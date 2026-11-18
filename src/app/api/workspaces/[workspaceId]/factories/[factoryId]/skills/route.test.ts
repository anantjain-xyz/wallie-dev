import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { DELETE as revoke, POST as revise } from "./[skillId]/revisions/route";
import { POST } from "./route";

const workspaceId = "55310000-0000-4000-8000-000000000001";
const factoryId = "55310000-0000-4000-8000-000000000002";
const userId = "55310000-0000-4000-8000-000000000003";
const skillId = "55310000-0000-4000-8000-000000000004";
const revisionId = "55310000-0000-4000-8000-000000000005";
const repositoryId = "55310000-0000-4000-8000-000000000006";
const params = Promise.resolve({ workspaceId, factoryId, skillId });
const skill = { name: "Release", slug: "release", contentMd: "Review the release notes." };

function fixture({
  visible = true,
  repositoryVisible = true,
  errorCode,
}: {
  visible?: boolean;
  repositoryVisible?: boolean;
  errorCode?: string;
} = {}) {
  const calls: { url: URL; body?: unknown }[] = [];
  const client = createClient<Database>("http://factory.test", "fixture", {
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (url.pathname.endsWith("/factories")) {
          return Response.json(visible ? { id: factoryId } : null);
        }
        if (url.pathname.endsWith("/github_repositories")) {
          return Response.json(repositoryVisible ? { id: repositoryId } : null);
        }
        if (errorCode) {
          return Response.json({ code: errorCode, message: "Rejected" }, { status: 400 });
        }
        return Response.json({ id: revisionId, skill_id: skillId });
      },
    },
  });
  mocks.access.mockResolvedValue({ ok: true, context: { user: { id: userId }, supabase: client } });
  mocks.admin.mockReturnValue(client);
  return calls;
}

function request(body: unknown, method = "POST") {
  return new Request("http://localhost/api/skills", { method, body: JSON.stringify(body) });
}

describe("factory skill commands", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps hidden factories and caller claims of built-in trust away from privileged writes", async () => {
    fixture({ visible: false });
    expect((await POST(request(skill), { params })).status).toBe(404);
    fixture();
    expect(
      (await POST(request({ ...skill, source: { kind: "wallie_builtin" } }), { params })).status,
    ).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("registers declared repository content with a scoped repository and immutable source ref", async () => {
    const calls = fixture();
    const commitSha = "a".repeat(40);
    const path = ".agents/skills/release/SKILL.md";
    const result = await POST(
      request({ ...skill, source: { kind: "repository", repositoryId, commitSha, path } }),
      { params },
    );
    expect(result.status).toBe(201);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    const repositoryLookup = calls.find(({ url }) => url.pathname.endsWith("/github_repositories"));
    expect(repositoryLookup?.url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
    expect(repositoryLookup?.url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(calls.at(-1)?.body).toMatchObject({
      p_actor_user_id: userId,
      p_source_kind: "repository",
      p_source_ref: `${repositoryId}@${commitSha}:${path}`,
      p_content_md: skill.contentMd,
    });
  });

  it("rejects repository provenance from a different factory before creating a revision", async () => {
    const calls = fixture({ repositoryVisible: false });
    const result = await POST(
      request({
        ...skill,
        source: { kind: "repository", repositoryId, commitSha: "a".repeat(40), path: "SKILL.md" },
      }),
      { params },
    );
    expect(result.status).toBe(404);
    expect(calls.some(({ url }) => url.pathname.includes("/rpc/"))).toBe(false);
  });

  it("keeps optimistic revision conflicts and manager checks on the write RPCs", async () => {
    fixture({ errorCode: "PT409" });
    const edit = await revise(request({ expectedRevisionNumber: 1, contentMd: "Edited" }), {
      params,
    });
    expect(edit.status).toBe(409);
    fixture({ errorCode: "42501" });
    const revocation = await revoke(request({ revisionId }, "DELETE"), { params });
    expect(revocation.status).toBe(403);
  });
});
