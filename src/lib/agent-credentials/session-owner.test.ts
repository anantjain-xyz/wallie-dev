import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database, Tables } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

import { resolveSessionOwnerUserId } from "@/lib/agent-credentials/session-owner";
import { getClaudeCodeCredentialForSession } from "@/lib/claude-code/tokens";
import { getCodexCredentialForSession } from "@/lib/codex/tokens";
import { getCursorCredentialForSession } from "@/lib/cursor/tokens";
import { getOpenCodeAuthForSession, getOpenCodeCredentialForSession } from "@/lib/opencode/tokens";

type AdminClient = SupabaseClient<Database>;
type Member = Pick<
  Tables<"workspace_members">,
  "id" | "workspace_id" | "user_id" | "is_active" | "kind"
>;

const session = { creator_member_id: "member-1", workspace_id: "workspace-1" };
const activeMember: Member = {
  id: session.creator_member_id,
  workspace_id: session.workspace_id,
  user_id: "user-1",
  is_active: true,
  kind: "human",
};

function createAdmin(member: Member | null, memberError: Error | null = null) {
  const credential = {
    user_id: "user-1",
    encrypted_api_key: "encrypted:personal-key",
    encrypted_credential: "encrypted:personal-key",
    credential_type: "platform_api_key",
    access_token_expires_at: null,
    api_key_expires_at: "2099-01-01T00:00:00.000Z",
    credential_generation: "generation-1",
    reconnect_required: false,
  };
  const rows: Record<string, Record<string, unknown> | null> = {
    workspace_members: member,
    user_claude_code_credentials: credential,
    user_codex_credentials: credential,
    user_cursor_credentials: credential,
    user_opencode_credentials: credential,
    user_opencode_provider_credentials: { ...credential, provider_id: "opencode-go" },
  };
  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select() {
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return query;
      },
      async maybeSingle() {
        const row = rows[table];
        return {
          data: row && filters.every(([column, value]) => row[column] === value) ? row : null,
          error: table === "workspace_members" ? memberError : null,
        };
      },
    };
    return query;
  });
  return { admin: { from } as unknown as AdminClient, from };
}

const loaders = [
  { name: "Codex", load: getCodexCredentialForSession },
  { name: "Claude Code", load: getClaudeCodeCredentialForSession },
  { name: "Cursor", load: getCursorCredentialForSession },
  { name: "OpenCode Zen", load: getOpenCodeCredentialForSession },
  {
    name: "OpenCode custom provider",
    load: (admin: AdminClient, owner: typeof session) =>
      getOpenCodeAuthForSession(admin, owner, "opencode-go/glm-5.3"),
  },
];

beforeEach(() => {
  mocked.decryptSecretValue.mockClear();
});

describe.each(loaders)("$name session credential authority", ({ load }) => {
  it.each([
    { name: "inactive member", member: { ...activeMember, is_active: false } },
    { name: "member in another workspace", member: { ...activeMember, workspace_id: "other" } },
    { name: "system member", member: { ...activeMember, kind: "system" as const } },
    { name: "missing member", member: null },
  ])("does not read or decrypt personal credentials for an $name", async ({ member }) => {
    const { admin, from } = createAdmin(member);

    await expect(load(admin, session)).rejects.toThrow(/no active human owner/);

    expect(from.mock.calls.map(([table]) => table)).toEqual(["workspace_members"]);
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });

  it("allows an active human in the session workspace to supply credentials", async () => {
    const { admin } = createAdmin(activeMember);

    const result = await load(admin, session);

    expect(JSON.stringify(result)).toContain("personal-key");
    expect(mocked.decryptSecretValue).toHaveBeenCalled();
  });

  it("rechecks membership when queued work later requests the same owner's credentials", async () => {
    const member = { ...activeMember };
    const { admin, from } = createAdmin(member);
    await load(admin, session);
    member.is_active = false;
    from.mockClear();
    mocked.decryptSecretValue.mockClear();

    await expect(load(admin, session)).rejects.toThrow(/no active human owner/);

    expect(from.mock.calls.map(([table]) => table)).toEqual(["workspace_members"]);
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });
});

describe("resolveSessionOwnerUserId", () => {
  it("does not look up credentials when a session has no creator", async () => {
    const { admin, from } = createAdmin(activeMember);

    await expect(
      resolveSessionOwnerUserId(admin, { ...session, creator_member_id: null }),
    ).resolves.toBeNull();

    expect(from).not.toHaveBeenCalled();
  });

  it("propagates membership lookup failures", async () => {
    const error = new Error("Database unavailable");
    const { admin } = createAdmin(activeMember, error);

    await expect(resolveSessionOwnerUserId(admin, session)).rejects.toThrow(error);
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });
});
