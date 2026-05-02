import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  encryptSecretValue: vi.fn((value: string) => `enc:${value}`),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  encryptSecretValue: mocked.encryptSecretValue,
}));

import {
  deleteSlackInstallationForWorkspace,
  exchangeSlackOAuthCode,
  getSlackInstallationForWorkspace,
  upsertSlackInstallationForWorkspace,
} from "./service";

const env = {
  SLACK_CLIENT_ID: "client-id",
  SLACK_CLIENT_SECRET: "client-secret",
};

describe("exchangeSlackOAuthCode", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws when SLACK_CLIENT_ID or SLACK_CLIENT_SECRET is missing", async () => {
    await expect(
      exchangeSlackOAuthCode({ code: "c", redirectUri: "https://app/cb" }, {}),
    ).rejects.toThrow("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required.");
  });

  it("posts the OAuth body to slack.com and returns the parsed payload on success", async () => {
    type FetchInit = {
      body: URLSearchParams;
      headers: Record<string, string>;
      method: string;
    };
    const fetchCalls: Array<[string, FetchInit]> = [];
    globalThis.fetch = (async (url: string, init: FetchInit) => {
      fetchCalls.push([url, init]);
      return {
        json: async () => ({
          ok: true,
          access_token: "xoxb-tok",
          team: { id: "T-1", name: "Acme" },
        }),
      };
    }) as unknown as typeof fetch;

    const result = await exchangeSlackOAuthCode(
      { code: "the-code", redirectUri: "https://app/cb" },
      env,
    );

    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(url).toBe("https://slack.com/api/oauth.v2.access");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = init.body.toString();
    expect(body).toContain("client_id=client-id");
    expect(body).toContain("client_secret=client-secret");
    expect(body).toContain("code=the-code");
    expect(body).toContain("redirect_uri=https%3A%2F%2Fapp%2Fcb");

    expect(result.ok).toBe(true);
    expect(result.access_token).toBe("xoxb-tok");
    expect(result.team?.id).toBe("T-1");
  });

  it("throws when Slack returns ok=false with an error code", async () => {
    globalThis.fetch = (async () => ({
      json: async () => ({ ok: false, error: "invalid_code" }),
    })) as unknown as typeof fetch;

    await expect(
      exchangeSlackOAuthCode({ code: "bad", redirectUri: "https://app/cb" }, env),
    ).rejects.toThrow("Slack OAuth exchange failed: invalid_code");
  });

  it("throws when ok=true but the access token or team id is missing", async () => {
    globalThis.fetch = (async () => ({
      json: async () => ({ ok: true, access_token: "", team: { id: "" } }),
    })) as unknown as typeof fetch;

    await expect(
      exchangeSlackOAuthCode({ code: "c", redirectUri: "https://app/cb" }, env),
    ).rejects.toThrow("Slack OAuth exchange failed: unknown_error");
  });
});

// ---- supabase mock builder ----------------------------------------------

interface InstallationRow {
  bot_token_encrypted?: string;
  id: string;
  installed_at?: string;
  team_id: string;
  team_name?: string | null;
  updated_at?: string;
  workspace_id: string;
}

interface InstallationsMockOptions {
  initialRows?: InstallationRow[];
  insertError?: { message: string } | null;
  updateError?: { message: string } | null;
  deleteError?: { message: string } | null;
  selectError?: { message: string } | null;
}

function buildAdmin(opts: InstallationsMockOptions = {}) {
  const rows = [...(opts.initialRows ?? [])];
  const calls: { type: string; payload?: unknown; filters?: Record<string, unknown> }[] = [];

  return {
    rows,
    calls,
    admin: {
      from(table: string) {
        if (table !== "slack_installations") {
          throw new Error(`unexpected table ${table}`);
        }
        return {
          select() {
            return {
              or: async () => {
                calls.push({ type: "select.or" });
                return {
                  data: opts.selectError ? null : rows.map(asReadShape),
                  error: opts.selectError ?? null,
                };
              },
              eq(column: string, value: unknown) {
                return {
                  maybeSingle: async () => {
                    calls.push({ type: "select.eq.maybeSingle", filters: { [column]: value } });
                    if (opts.selectError) return { data: null, error: opts.selectError };
                    const found = rows.find(
                      (r) => (r as unknown as Record<string, unknown>)[column] === value,
                    );
                    return { data: found ? asReadShape(found) : null, error: null };
                  },
                };
              },
            };
          },
          insert(payload: Record<string, unknown>) {
            calls.push({ type: "insert", payload });
            return {
              select: () => ({
                single: async () => {
                  if (opts.insertError) return { data: null, error: opts.insertError };
                  const newRow = withDefaults(payload as Partial<InstallationRow>);
                  rows.push(newRow);
                  return { data: asReadShape(newRow), error: null };
                },
              }),
            };
          },
          update(payload: Record<string, unknown>) {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return chain;
              },
              select() {
                return {
                  single: async () => {
                    calls.push({ type: "update", payload, filters });
                    if (opts.updateError) return { data: null, error: opts.updateError };
                    const target = rows.find((r) => {
                      const record = r as unknown as Record<string, unknown>;
                      return Object.entries(filters).every(([k, v]) => record[k] === v);
                    });
                    if (!target) {
                      return { data: null, error: { message: "no row matched update filter" } };
                    }
                    Object.assign(target, payload);
                    return { data: asReadShape(target), error: null };
                  },
                };
              },
              then(resolve: (value: { data: null; error: { message: string } | null }) => void) {
                calls.push({ type: "update", payload, filters });
                resolve({ data: null, error: opts.updateError ?? null });
              },
            };
            return chain;
          },
          delete() {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return chain;
              },
              then(resolve: (value: { data: null; error: { message: string } | null }) => void) {
                calls.push({ type: "delete", filters });
                if (!opts.deleteError) {
                  for (let i = rows.length - 1; i >= 0; i--) {
                    const row = rows[i] as unknown as Record<string, unknown>;
                    if (Object.entries(filters).every(([k, v]) => row[k] === v)) {
                      rows.splice(i, 1);
                    }
                  }
                }
                resolve({ data: null, error: opts.deleteError ?? null });
              },
            };
            return chain;
          },
        };
      },
    },
  };
}

function withDefaults(partial: Partial<InstallationRow>): InstallationRow {
  return {
    bot_token_encrypted: partial.bot_token_encrypted ?? "enc:default",
    id: partial.id ?? "ins-default",
    installed_at: partial.installed_at ?? "2025-01-01T00:00:00Z",
    team_id: partial.team_id ?? "T-default",
    team_name: partial.team_name ?? null,
    updated_at: partial.updated_at ?? "2025-01-01T00:00:00Z",
    workspace_id: partial.workspace_id ?? "ws-default",
  };
}

function asReadShape(row: InstallationRow) {
  return {
    id: row.id,
    installed_at: row.installed_at,
    team_id: row.team_id,
    team_name: row.team_name ?? null,
    updated_at: row.updated_at,
    workspace_id: row.workspace_id,
  };
}

const slackEnv = {
  WALLIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
};

describe("upsertSlackInstallationForWorkspace", () => {
  beforeEach(() => {
    mocked.encryptSecretValue.mockClear();
    mocked.createSupabaseAdminClient.mockReset();
  });

  it("inserts a fresh row when neither workspace nor team has an installation yet", async () => {
    const { admin, calls, rows } = buildAdmin({ initialRows: [] });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    const summary = await upsertSlackInstallationForWorkspace(
      {
        botToken: "xoxb-fresh",
        teamId: "T-1",
        teamName: "Acme",
        workspaceId: "ws-1",
      },
      slackEnv,
    );

    const insertCall = calls.find((c) => c.type === "insert");
    expect(insertCall).toBeDefined();
    expect(mocked.encryptSecretValue).toHaveBeenCalledWith("xoxb-fresh", slackEnv);
    expect(insertCall!.payload).toMatchObject({
      bot_token_encrypted: "enc:xoxb-fresh",
      team_id: "T-1",
      team_name: "Acme",
      workspace_id: "ws-1",
    });
    expect(rows).toHaveLength(1);
    expect(summary.teamId).toBe("T-1");
    expect(summary.teamName).toBe("Acme");
  });

  it("updates the existing row when the workspace already has an installation", async () => {
    const existing: InstallationRow = withDefaults({
      id: "ins-existing",
      team_id: "T-old",
      team_name: "OldName",
      workspace_id: "ws-1",
    });
    const { admin, calls } = buildAdmin({ initialRows: [existing] });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    const summary = await upsertSlackInstallationForWorkspace(
      {
        botToken: "xoxb-rotated",
        teamId: "T-new",
        teamName: "NewName",
        workspaceId: "ws-1",
      },
      slackEnv,
    );

    const updateCall = calls.find((c) => c.type === "update");
    expect(updateCall).toBeDefined();
    expect(updateCall!.payload).toMatchObject({
      bot_token_encrypted: "enc:xoxb-rotated",
      team_id: "T-new",
      team_name: "NewName",
      workspace_id: "ws-1",
    });
    expect(updateCall!.filters).toEqual({ id: "ins-existing" });
    expect(summary.id).toBe("ins-existing");
    // No insert and no delete should have happened — only an update.
    expect(calls.find((c) => c.type === "insert")).toBeUndefined();
    expect(calls.find((c) => c.type === "delete")).toBeUndefined();
  });

  it("collapses a duplicate row when the same team is linked to a different workspace's row", async () => {
    // ws-1 already has its own row pinned to team T-old. Concurrently, T-new
    // shows up as a different row pinned to ws-other. The OR query returns both
    // rows; the service must keep ws-1's row (workspaceRow wins via `??`) and
    // delete the conflicting team row before re-pointing.
    const wsRow: InstallationRow = withDefaults({
      id: "ins-ws1",
      team_id: "T-old",
      workspace_id: "ws-1",
    });
    const teamRow: InstallationRow = withDefaults({
      id: "ins-other",
      team_id: "T-new",
      workspace_id: "ws-other",
    });
    const { admin, calls, rows } = buildAdmin({ initialRows: [wsRow, teamRow] });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    const summary = await upsertSlackInstallationForWorkspace(
      {
        botToken: "xoxb-shared",
        teamId: "T-new",
        teamName: "Acme",
        workspaceId: "ws-1",
      },
      slackEnv,
    );

    const deleteCall = calls.find((c) => c.type === "delete");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.filters).toEqual({ id: "ins-other" });

    const updateCall = calls.find((c) => c.type === "update");
    expect(updateCall).toBeDefined();
    expect(updateCall!.filters).toEqual({ id: "ins-ws1" });
    expect(updateCall!.payload).toMatchObject({ team_id: "T-new", workspace_id: "ws-1" });

    // Only ws-1's row should remain after collapse.
    expect(rows.map((r) => r.id).sort()).toEqual(["ins-ws1"]);
    expect(summary.id).toBe("ins-ws1");
    expect(summary.teamId).toBe("T-new");
  });

  it("propagates errors raised during the existence lookup", async () => {
    const { admin } = buildAdmin({ selectError: { message: "select boom" } });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await expect(
      upsertSlackInstallationForWorkspace(
        { botToken: "x", teamId: "T", teamName: null, workspaceId: "ws-1" },
        slackEnv,
      ),
    ).rejects.toMatchObject({ message: "select boom" });
  });
});

describe("getSlackInstallationForWorkspace", () => {
  beforeEach(() => {
    mocked.createSupabaseAdminClient.mockReset();
  });

  it("returns the mapped installation summary when the workspace has one", async () => {
    const row = withDefaults({
      id: "ins-1",
      team_id: "T-1",
      team_name: "Acme",
      workspace_id: "ws-1",
    });
    const { admin } = buildAdmin({ initialRows: [row] });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    const result = await getSlackInstallationForWorkspace("ws-1", slackEnv);
    expect(result).toEqual({
      id: "ins-1",
      installedAt: row.installed_at,
      teamId: "T-1",
      teamName: "Acme",
      updatedAt: row.updated_at,
    });
  });

  it("returns null when the workspace has no installation", async () => {
    const { admin } = buildAdmin({ initialRows: [] });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    const result = await getSlackInstallationForWorkspace("ws-1", slackEnv);
    expect(result).toBeNull();
  });

  it("propagates supabase errors so callers don't silently treat them as not-found", async () => {
    const { admin } = buildAdmin({ selectError: { message: "rls" } });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await expect(getSlackInstallationForWorkspace("ws-1", slackEnv)).rejects.toMatchObject({
      message: "rls",
    });
  });
});

describe("deleteSlackInstallationForWorkspace", () => {
  beforeEach(() => {
    mocked.createSupabaseAdminClient.mockReset();
  });

  it("scopes the delete by both installationId and workspaceId so cross-workspace deletes can't slip through", async () => {
    const { admin, calls } = buildAdmin({
      initialRows: [
        withDefaults({ id: "ins-1", team_id: "T-1", workspace_id: "ws-1" }),
        withDefaults({ id: "ins-2", team_id: "T-2", workspace_id: "ws-2" }),
      ],
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await deleteSlackInstallationForWorkspace(
      { installationId: "ins-1", workspaceId: "ws-1" },
      slackEnv,
    );

    const del = calls.find((c) => c.type === "delete");
    expect(del).toBeDefined();
    expect(del!.filters).toEqual({ id: "ins-1", workspace_id: "ws-1" });
  });

  it("propagates the delete error", async () => {
    const { admin } = buildAdmin({ deleteError: { message: "rls" } });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await expect(
      deleteSlackInstallationForWorkspace(
        { installationId: "ins-1", workspaceId: "ws-1" },
        slackEnv,
      ),
    ).rejects.toMatchObject({ message: "rls" });
  });
});
