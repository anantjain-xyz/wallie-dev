import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { loadRunAgentPrompt } from "./runtime";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const factoryId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";
const promptMd = "Implement the assigned stage. Keep {{session.prompt}} literal here.";
const promptSha256 = createHash("sha256").update(promptMd).digest("hex");
const snapshot = { agentId, promptRevisionId: revisionId, promptMd, promptSha256 };
const input = { workspaceId, factoryId, sessionId, runId };

function clientForRevision(hash = promptSha256) {
  const runQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: { agent_id: agentId, agent_prompt_revision_id: revisionId },
      error: null,
    }),
  };
  const revisionQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: {
        id: revisionId,
        agent_id: agentId,
        prompt_md: promptMd,
        prompt_sha256: hash,
      },
      error: null,
    }),
  };
  const from = vi.fn((table: string) => {
    if (table === "agent_runs") return runQuery;
    if (table === "factory_agent_prompt_revisions") return revisionQuery;
    throw new Error(`Unexpected table ${table}`);
  });
  return {
    client: { from } as unknown as SupabaseClient<Database>,
    runQuery,
    revisionQuery,
  };
}

describe("loadRunAgentPrompt", () => {
  it("loads the exact run revision within its owning session, workspace, and factory", async () => {
    const { client, runQuery, revisionQuery } = clientForRevision();
    await expect(loadRunAgentPrompt(client, { ...input, expected: snapshot })).resolves.toEqual(
      snapshot,
    );
    expect(runQuery.eq.mock.calls).toEqual([
      ["workspace_id", workspaceId],
      ["session_id", sessionId],
      ["id", runId],
    ]);
    expect(revisionQuery.eq.mock.calls).toEqual([
      ["workspace_id", workspaceId],
      ["factory_id", factoryId],
      ["agent_id", agentId],
      ["id", revisionId],
    ]);
  });

  it("rejects bytes that differ from their retained digest", async () => {
    const { client } = clientForRevision("a".repeat(64));
    await expect(loadRunAgentPrompt(client, input)).rejects.toThrow("integrity verification");
  });

  it("rejects a run identity that differs from the pinned definition", async () => {
    const { client } = clientForRevision();
    await expect(
      loadRunAgentPrompt(client, {
        ...input,
        expected: { ...snapshot, promptRevisionId: "77777777-7777-4777-8777-777777777777" },
      }),
    ).rejects.toThrow("differs from its pinned factory definition");
  });
});
