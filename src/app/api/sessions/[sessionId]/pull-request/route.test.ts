import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  enforceRateLimit: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocked.getSupabaseUserOrNull }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocked.enforceRateLimit }));

import { GET, POST } from "./route";

const sessionId = "49800000-0000-4000-8000-000000000001";
const workspaceId = "49800000-0000-4000-8000-000000000002";
const epochId = "49800000-0000-4000-8000-000000000003";
const requestId = "49800000-0000-4000-8000-000000000004";
const successorId = "49800000-0000-4000-8000-000000000005";
const actorId = "49800000-0000-4000-8000-000000000006";
const checkpointId = "49800000-0000-4000-8000-000000000007";
const repositoryId = "49800000-0000-4000-8000-000000000008";
const sync = {
  session_id: sessionId,
  workspace_id: workspaceId,
  current_epoch_id: epochId,
  desired_checkpoint_run_id: checkpointId,
  target_generation: 3,
  status: "pending",
  observed_head_sha: "a".repeat(40),
  observed_pr_head_sha: "a".repeat(40),
  last_error_code: null,
  claim_id: "private-claim",
};
const epoch = {
  id: epochId,
  session_id: sessionId,
  workspace_id: workspaceId,
  epoch_number: 1,
  repository_id: repositoryId,
  github_repository_id: 555,
  repository_full_name: "acme/app",
  base_branch: "main",
  branch_name: `wallie/sessions/${sessionId}/${epochId}`,
  pr_number: 42,
  pr_url: "https://github.com/acme/app/pull/42",
  pr_state: "open",
  is_draft: true,
  create_attempted: true,
};
type Row = Record<string, unknown>;
function serverClient(overrides: Record<string, Row | null> = {}, errorTable?: string) {
  const rows: Record<string, Row | null> = {
    sessions: { id: sessionId, workspace_id: workspaceId },
    workspace_members: {
      id: "member-id",
      workspace_id: workspaceId,
      user_id: actorId,
      kind: "human",
      is_active: true,
    },
    session_pr_sync: sync,
    session_pr_epochs: epoch,
    ...overrides,
  };
  const filters: Array<[string, string, unknown]> = [];
  const reads: Array<[string, string]> = [];
  const client = {
    from(table: string) {
      let columns: string[] = [];
      let row = rows[table];
      const query = {
        select(selection: string) {
          reads.push([table, selection]);
          columns = selection.split(",").map((name) => name.trim());
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push([table, column, value]);
          if (row?.[column] !== value) row = null;
          return query;
        },
        async maybeSingle() {
          return {
            data: row ? Object.fromEntries(columns.map((name) => [name, row![name]])) : null,
            error: table === errorTable ? { message: "private database failure" } : null,
          };
        },
      };
      return query;
    },
  };
  mocked.createSupabaseServerClient.mockResolvedValue(client);
  return { client, filters, reads };
}
function get(id = sessionId) {
  return GET(new Request("http://localhost"), { params: Promise.resolve({ sessionId: id }) });
}
function post(body: unknown = { expectedEpochId: epochId, requestId }, id = sessionId) {
  return POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ sessionId: id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serverClient();
  mocked.getSupabaseUserOrNull.mockResolvedValue({ id: actorId });
  mocked.createSupabaseAdminClient.mockReturnValue({ rpc: mocked.rpc });
  mocked.rpc.mockResolvedValue({ data: successorId, error: null });
  mocked.enforceRateLimit.mockResolvedValue({ response: null });
});

describe("GET canonical session pull request", () => {
  it("returns scoped intended and observed facts through RLS without private operation fields", async () => {
    const { filters } = serverClient();
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sync).toMatchObject({
      desired_checkpoint_run_id: checkpointId,
      status: "pending",
      observed_pr_head_sha: "a".repeat(40),
    });
    expect(body.epoch).toMatchObject({ id: epochId, pr_number: 42, pr_state: "open" });
    expect(body.sync).not.toHaveProperty("claim_id");
    expect(body.epoch).not.toHaveProperty("create_attempted");
    expect(filters).toContainEqual(["session_pr_sync", "workspace_id", workspaceId]);
    expect(filters).toContainEqual(["session_pr_epochs", "workspace_id", workspaceId]);
    expect(filters).toContainEqual(["session_pr_epochs", "session_id", sessionId]);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
  it("returns an unmanaged session without inventing a PR", async () => {
    serverClient({ session_pr_sync: null });
    expect(await (await get()).json()).toEqual({ sync: null, epoch: null });
  });
  it("does not expose an epoch from another session or workspace", async () => {
    serverClient({ session_pr_epochs: { ...epoch, workspace_id: "foreign-workspace" } });
    expect((await get()).status).toBe(500);
  });
  it.each(["sessions", "session_pr_sync", "session_pr_epochs"])(
    "does not turn a %s read error into absence or synchronization success",
    async (table) => {
      serverClient({}, table);
      const response = await get();
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private database failure");
    },
  );
});

describe("POST explicit canonical PR successor", () => {
  it("authorizes the authenticated human's exact session, epoch and idempotency key", async () => {
    const { filters } = serverClient();
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ epochId: successorId });
    expect(mocked.rpc).toHaveBeenCalledExactlyOnceWith("authorize_session_pr_successor", {
      p_actor_user_id: actorId,
      p_session_id: sessionId,
      p_expected_epoch_id: epochId,
      p_request_id: requestId,
    });
    expect(filters).toContainEqual(["workspace_members", "workspace_id", workspaceId]);
    expect(filters).toContainEqual(["workspace_members", "user_id", actorId]);
    expect(filters).toContainEqual(["workspace_members", "kind", "human"]);
    expect(filters).toContainEqual(["workspace_members", "is_active", true]);
  });
  it("forwards repeated requests unchanged so the database can return its idempotent receipt", async () => {
    expect(await (await post()).json()).toEqual({ epochId: successorId });
    expect(await (await post()).json()).toEqual({ epochId: successorId });
    expect(mocked.rpc.mock.calls[0]).toEqual(mocked.rpc.mock.calls[1]);
  });
  it.each([
    {},
    { expectedEpochId: "bad", requestId },
    { expectedEpochId: epochId, requestId: "bad" },
    { expectedEpochId: epochId, requestId, actorId: "forged" },
    { expectedEpochId: epochId, requestId, workspaceId: "foreign" },
  ])("rejects invalid or caller-supplied authority: %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON", async () => {
    const response = await POST(new Request("http://localhost", { method: "POST", body: "{" }), {
      params: Promise.resolve({ sessionId }),
    });
    expect(response.status).toBe(400);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { id: "bot", workspace_id: workspaceId, user_id: actorId, kind: "agent", is_active: true },
    {
      id: "inactive",
      workspace_id: workspaceId,
      user_id: actorId,
      kind: "human",
      is_active: false,
    },
  ])("rejects a missing or inactive human membership", async (member) => {
    serverClient({ workspace_members: member });
    expect((await post()).status).toBe(403);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
  it("honors rate limiting before invoking the privileged RPC", async () => {
    mocked.enforceRateLimit.mockResolvedValue({
      response: new Response("limited", { status: 429 }),
    });
    expect((await post()).status).toBe(429);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["42501", 403],
    ["P0002", 404],
    ["55000", 409],
    ["23514", 409],
    ["23505", 409],
    ["unknown", 500],
  ])("maps a %s database refusal without exposing internals", async (code, status) => {
    mocked.rpc.mockResolvedValue({ data: null, error: { code, message: "private detail" } });
    const response = await post();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private detail");
  });
  it("does not claim authorization succeeded without a receipt", async () => {
    mocked.rpc.mockResolvedValue({ data: null, error: null });
    expect((await post()).status).toBe(409);
  });
});

describe("canonical PR route access", () => {
  it.each([get, post])("requires authentication", async (action) => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);
    expect((await action()).status).toBe(401);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
  it.each([get, post])(
    "does not bypass an RLS session miss with the admin client",
    async (action) => {
      serverClient({ sessions: null });
      expect((await action()).status).toBe(404);
      expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed session identities before querying", async () => {
    expect((await get("bad")).status).toBe(400);
    expect((await post(undefined, "bad")).status).toBe(400);
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });
});
