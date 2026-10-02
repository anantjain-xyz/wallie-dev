import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionCredentialOwner } from "@/lib/agent-credentials/session-owner";
import type { Database, Tables } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

import { getClaudeCodeCredentialForSession } from "@/lib/claude-code/tokens";
import { createCodexChatGptAuthStore, getCodexCredentialForSession } from "@/lib/codex/tokens";
import { CodexRunner } from "@/lib/agent-runner/codex";
import { FakeSandbox } from "@/lib/sandbox/fake";
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

function createAdmin(
  member: Member | null,
  options: { beforeRead?: () => void; error?: Error; missingCredential?: boolean } = {},
) {
  const credential = {
    user_id: "user-1",
    encrypted_api_key: "encrypted:personal-key",
    encrypted_credential: "encrypted:personal-key",
    zen_encrypted_api_key: "encrypted:zen-key",
    credential_type: "chatgpt_auth_json",
    access_token_expires_at: null,
    api_key_expires_at: "2099-01-01T00:00:00.000Z",
    credential_generation: "generation-1",
    credential_version: 1,
    auth_cache_last_refresh: null,
    auth_reconnect_required: false,
    auth_reconnect_reason: null,
    reconnect_required: false,
    reconnect_reason: null,
  };
  const from = vi.fn(() => {
    throw new Error("Session credential loaders must use the atomic membership RPC.");
  });
  // Model a single statement's authorized result; the SQL suite proves the real
  // joins and permissions. Any former two-request loader fails the `from` guard.
  const rpc = vi.fn(
    async (
      _name: string,
      args: {
        p_creator_member_id: string;
        p_workspace_id: string;
        p_expected_user_id?: string;
        p_provider_id?: string;
      },
    ) => {
      options.beforeRead?.();
      if (options.error) return { data: null, error: options.error };
      const authorized =
        member?.id === args.p_creator_member_id &&
        member.workspace_id === args.p_workspace_id &&
        member.is_active &&
        member.kind === "human" &&
        member.user_id === credential.user_id &&
        (!args.p_expected_user_id || args.p_expected_user_id === member.user_id);
      return { data: authorized && !options.missingCredential ? [credential] : [], error: null };
    },
  );
  return { admin: { from, rpc } as unknown as AdminClient, from, rpc };
}

const loaders = [
  {
    name: "Codex",
    load: getCodexCredentialForSession,
    rpcName: "load_session_codex_credential",
    extraArgs: {},
  },
  {
    name: "Claude Code",
    load: getClaudeCodeCredentialForSession,
    rpcName: "load_session_claude_code_credential",
    extraArgs: {},
  },
  {
    name: "Cursor",
    load: getCursorCredentialForSession,
    rpcName: "load_session_cursor_credential",
    extraArgs: {},
  },
  {
    name: "OpenCode Zen",
    load: getOpenCodeCredentialForSession,
    rpcName: "load_session_opencode_credentials",
    extraArgs: { p_provider_id: "opencode" },
  },
  {
    name: "OpenCode custom provider",
    load: (admin: AdminClient, owner: SessionCredentialOwner) =>
      getOpenCodeAuthForSession(admin, owner, "opencode-go/glm-5.3"),
    rpcName: "load_session_opencode_credentials",
    extraArgs: { p_provider_id: "opencode-go" },
  },
  {
    name: "Codex subscription auth reload",
    load: (admin: AdminClient, owner: SessionCredentialOwner) =>
      createCodexChatGptAuthStore(admin, owner).loadChatGptAuth({ userId: "user-1" }),
    rpcName: "load_session_codex_credential",
    extraArgs: { p_expected_user_id: "user-1" },
  },
];

beforeEach(() => {
  mocked.decryptSecretValue.mockClear();
});

describe.each(loaders)("$name atomic credential authority", ({ load, rpcName, extraArgs }) => {
  const expectedArgs = {
    p_creator_member_id: session.creator_member_id,
    p_workspace_id: session.workspace_id,
    ...extraArgs,
  };

  it.each([
    { name: "inactive member", member: { ...activeMember, is_active: false } },
    { name: "member in another workspace", member: { ...activeMember, workspace_id: "other" } },
    { name: "system member", member: { ...activeMember, kind: "system" as const } },
    { name: "missing member", member: null },
  ])("does not receive or decrypt credentials for an $name", async ({ member }) => {
    const { admin, from, rpc } = createAdmin(member);

    await expect(load(admin, session)).rejects.toThrow(/no active human owner/);

    expect(rpc).toHaveBeenCalledExactlyOnceWith(rpcName, expectedArgs);
    expect(from).not.toHaveBeenCalled();
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });

  it("loads the active member's credentials with one authorized database request", async () => {
    const { admin, from, rpc } = createAdmin(activeMember);

    expect(JSON.stringify(await load(admin, session))).toContain("personal-key");

    expect(rpc).toHaveBeenCalledExactlyOnceWith(rpcName, expectedArgs);
    expect(from).not.toHaveBeenCalled();
    expect(mocked.decryptSecretValue).toHaveBeenCalled();
  });

  it("checks membership in the same request that retrieves ciphertext", async () => {
    const member = { ...activeMember };
    const { admin, from, rpc } = createAdmin(member, {
      beforeRead: () => {
        member.is_active = false;
      },
    });

    await expect(load(admin, session)).rejects.toThrow(/no active human owner/);

    expect(rpc).toHaveBeenCalledExactlyOnceWith(rpcName, expectedArgs);
    expect(from).not.toHaveBeenCalled();
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });

  it("rejects later use after the member leaves", async () => {
    const member = { ...activeMember };
    const { admin, rpc } = createAdmin(member);
    await load(admin, session);
    member.is_active = false;
    rpc.mockClear();
    mocked.decryptSecretValue.mockClear();

    await expect(load(admin, session)).rejects.toThrow(/no active human owner/);

    expect(rpc).toHaveBeenCalledExactlyOnceWith(rpcName, expectedArgs);
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });

  it("makes no credential request when the session has no creator", async () => {
    const { admin, from, rpc } = createAdmin(activeMember);

    await expect(load(admin, { ...session, creator_member_id: null })).rejects.toThrow(
      /no active human owner/,
    );

    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });

  it("does not decrypt when the requested credential is absent", async () => {
    const { admin } = createAdmin(activeMember, { missingCredential: true });

    await expect(load(admin, session)).rejects.toThrow(/no active human owner/);

    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });

  it("propagates database failures without decrypting", async () => {
    const error = new Error("Database unavailable");
    const { admin } = createAdmin(activeMember, { error });

    await expect(load(admin, session)).rejects.toThrow(error);
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });
});

describe("Codex subscription auth reload", () => {
  it("filters the expected credential user in the same database request", async () => {
    const { admin, from, rpc } = createAdmin(activeMember);
    const store = createCodexChatGptAuthStore(admin, session);

    await expect(store.loadChatGptAuth({ userId: "another-user" })).rejects.toThrow(
      /matching connected Codex credential/,
    );

    expect(rpc).toHaveBeenCalledExactlyOnceWith("load_session_codex_credential", {
      p_creator_member_id: "member-1",
      p_workspace_id: "workspace-1",
      p_expected_user_id: "another-user",
    });
    expect(from).not.toHaveBeenCalled();
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
  });

  it("blocks auth reload and CLI launch if the creator is removed during sandbox setup", async () => {
    const member = { ...activeMember };
    const { admin, from, rpc } = createAdmin(member);
    const credential = await getCodexCredentialForSession(admin, session);
    const runner = new CodexRunner({
      credential,
      chatGptAuthStore: createCodexChatGptAuthStore(admin, session),
    });
    const sandbox = new FakeSandbox();
    member.is_active = false;
    rpc.mockClear();
    mocked.decryptSecretValue.mockClear();

    const consume = async () => {
      for await (const event of runner.start({
        prompt: "Run stage",
        sandbox,
        sessionId: "session-1",
      })) {
        void event;
      }
    };
    await expect(consume()).rejects.toThrow(/no active human owner/);

    expect(rpc).toHaveBeenCalledExactlyOnceWith("load_session_codex_credential", {
      p_creator_member_id: "member-1",
      p_workspace_id: "workspace-1",
      p_expected_user_id: "user-1",
    });
    expect(from).not.toHaveBeenCalled();
    expect(mocked.decryptSecretValue).not.toHaveBeenCalled();
    expect(sandbox.files.size).toBe(0);
    expect(sandbox.calls).toHaveLength(0);
  });
});
