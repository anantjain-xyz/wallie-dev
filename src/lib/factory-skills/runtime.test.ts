import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import { renderStagePrompt } from "@/lib/prompt-templates";
import type { Database } from "@/lib/supabase/database.types";

import { loadFactorySkillBundle } from "./runtime";

const scope = {
  workspaceId: "55300000-0000-4000-8000-000000000001",
  factoryId: "55300000-0000-4000-8000-000000000002",
};
const trustedId = "55300000-0000-4000-8000-000000000003";
const repositoryId = "55300000-0000-4000-8000-000000000004";
const approved = "Approved review instructions. Keep {{session.prompt}} literal.";
const fetched = "Fetched repository notes. Keep {{session.prompt}} literal.";

function revision(id: string, content: string, source: string) {
  return {
    id,
    content_md: content,
    content_sha256: createHash("sha256").update(content).digest("hex"),
    source_kind: source,
  };
}

function clientWithRows(rows: unknown[]) {
  const requests: URL[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    requests.push(new URL(input instanceof Request ? input.url : input));
    return Response.json(rows);
  });
  const client = createClient<Database>("http://skill-test.invalid", "fixture", {
    auth: { persistSession: false },
    global: { fetch },
  });
  return { client, requests };
}

describe("loadFactorySkillBundle", () => {
  it("uses exact retained revisions in the pinned order and classifies source provenance", async () => {
    const { client, requests } = clientWithRows([
      revision(repositoryId, fetched, "repository"),
      revision(trustedId, approved, "manual"),
    ]);
    const skillInstructions = await loadFactorySkillBundle(client, {
      ...scope,
      skillRevisionIds: [trustedId, repositoryId],
    });

    expect(requests).toHaveLength(1);
    const query = requests[0].searchParams;
    expect(query.get("workspace_id")).toBe(`eq.${scope.workspaceId}`);
    expect(query.get("factory_id")).toBe(`eq.${scope.factoryId}`);
    expect(query.get("id")).toBe(`in.(${trustedId},${repositoryId})`);
    expect(query.has("revoked_at")).toBe(false);
    expect(skillInstructions).toMatchObject([{ trust: "trusted" }, { trust: "untrusted" }]);

    const prompt = renderStagePrompt(
      {
        promptTemplateMd: trustedPromptValue("stage.promptTemplate", "Review {{session.prompt}}"),
        slug: trustedPromptValue("stage.slug", "review"),
      },
      {
        attemptNumber: 1,
        attemptFeedback: null,
        sessionTitle: untrustedPromptValue("session.title", "Review"),
        sessionPrompt: untrustedPromptValue("session.prompt", "Task data"),
        skillInstructions,
      },
    );
    expect(prompt.startsWith(approved)).toBe(true);
    expect(prompt).toContain(`Source: skill.repositoryRevision.${repositoryId}\n`);
    expect(prompt).toContain(fetched);
    expect(prompt).toContain("Source: session.prompt\n");
  });

  it("fails closed on missing or corrupted revision bytes", async () => {
    const { client } = clientWithRows([
      { ...revision(trustedId, approved, "manual"), content_md: "Modified bytes" },
    ]);
    await expect(
      loadFactorySkillBundle(client, { ...scope, skillRevisionIds: [trustedId, repositoryId] }),
    ).rejects.toThrow("unavailable in this factory");
    await expect(
      loadFactorySkillBundle(client, { ...scope, skillRevisionIds: [trustedId] }),
    ).rejects.toThrow("integrity verification");
  });
});
