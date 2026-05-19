import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
  encryptSecretValue: vi.fn((value: string) => `encrypted:${value}`),
  randomUUID: vi.fn(() => "00000000-0000-0000-0000-000000000123"),
  sandboxCreate: vi.fn(),
  sandboxGet: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: mocked.randomUUID,
}));

vi.mock("node:child_process", () => ({
  spawn: mocked.spawn,
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: mocked.sandboxCreate,
    get: mocked.sandboxGet,
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
  encryptSecretValue: mocked.encryptSecretValue,
}));

import {
  consumeAuthenticatedCodexDeviceAuthFlow,
  deleteCodexDeviceAuthFlow,
  getCodexDeviceAuthFlowSnapshot,
  startCodexDeviceAuthFlow,
} from "@/lib/codex/device-auth";

type FlowRow = {
  account_email: string | null;
  account_id: string | null;
  auth_cache_last_refresh: string | null;
  canceled_at: string | null;
  command_id: string;
  completed_at: string | null;
  created_at: string;
  encrypted_auth_json: string | null;
  error: string | null;
  expires_at: string;
  id: string;
  instructions: string | null;
  output_tail: string | null;
  sandbox_id: string;
  status: string;
  updated_at: string;
  user_code: string | null;
  user_id: string;
  verification_uri: string | null;
};

class FakeCommand {
  cmdId = "cmd-1";
  exitCode: number | null = null;
  logChunks: Array<{ data: string; stream: "stdout" | "stderr" }> = [];
  outputText = "";

  async *logs() {
    for (const chunk of this.logChunks) {
      yield chunk;
    }
  }

  async output() {
    return this.outputText;
  }
}

function buildFlowRow(overrides: Partial<FlowRow>): FlowRow {
  return {
    account_email: null,
    account_id: null,
    auth_cache_last_refresh: null,
    canceled_at: null,
    command_id: "cmd-1",
    completed_at: null,
    created_at: "2026-05-19T00:00:00.000Z",
    encrypted_auth_json: null,
    error: null,
    expires_at: "2099-01-01T00:00:00.000Z",
    id: "00000000-0000-0000-0000-000000000123",
    instructions: null,
    output_tail: null,
    sandbox_id: "sandbox-1",
    status: "starting",
    updated_at: "2026-05-19T00:00:00.000Z",
    user_code: null,
    user_id: "user-1",
    verification_uri: null,
    ...overrides,
  };
}

function buildAdminMock(rows: FlowRow[]) {
  return {
    from: vi.fn((table: string) => {
      if (table !== "codex_device_auth_flows") {
        throw new Error(`unexpected table: ${table}`);
      }

      return {
        delete: () => mutationChain(rows, null, "delete"),
        insert: (value: Partial<FlowRow>) => ({
          select: () => ({
            single: async () => {
              const row = buildFlowRow(value);
              rows.push(row);
              return { data: row, error: null };
            },
          }),
        }),
        select: () => selectChain(rows),
        update: (value: Partial<FlowRow>) => mutationChain(rows, value, "update"),
      };
    }),
  };
}

function selectChain(rows: FlowRow[]) {
  const filters: Array<(row: FlowRow) => boolean> = [];
  const chain = {
    eq(key: keyof FlowRow, value: unknown) {
      filters.push((row) => row[key] === value);
      return chain;
    },
    in(key: keyof FlowRow, values: unknown[]) {
      filters.push((row) => values.includes(row[key]));
      return chain;
    },
    lte(key: keyof FlowRow, value: string) {
      filters.push((row) => String(row[key]) <= value);
      return chain;
    },
    maybeSingle: async () => ({ data: filtered(rows, filters)[0] ?? null, error: null }),
    then(resolve: (value: { data: FlowRow[]; error: null }) => unknown) {
      return Promise.resolve({ data: filtered(rows, filters), error: null }).then(resolve);
    },
  };
  return chain;
}

function mutationChain(rows: FlowRow[], value: Partial<FlowRow> | null, mode: "delete" | "update") {
  const filters: Array<(row: FlowRow) => boolean> = [];
  const chain = {
    eq(key: keyof FlowRow, compare: unknown) {
      filters.push((row) => row[key] === compare);
      return chain;
    },
    select: () => ({
      single: async () => {
        const row = filtered(rows, filters)[0] ?? null;
        if (!row) return { data: null, error: new Error("missing row") };
        Object.assign(row, value, { updated_at: "2026-05-19T00:01:00.000Z" });
        return { data: row, error: null };
      },
    }),
    then(resolve: (value: { data: null; error: null }) => unknown) {
      if (mode === "delete") {
        const matched = new Set(filtered(rows, filters));
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (matched.has(rows[i]!)) rows.splice(i, 1);
        }
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return chain;
}

function filtered(rows: FlowRow[], filters: Array<(row: FlowRow) => boolean>): FlowRow[] {
  return rows.filter((row) => filters.every((filter) => filter(row)));
}

function fakeChildProcess() {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    pid: 12345,
    stderr,
    stdout,
    unref: vi.fn(),
  });
  return { child, stderr, stdout };
}

describe("Codex device auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODEX_DEVICE_AUTH_MODE;
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
  });

  it("starts device auth in a bootstrapped sandbox and persists the flow row", async () => {
    const rows: FlowRow[] = [];
    const admin = buildAdminMock(rows);
    const command = new FakeCommand();
    command.logChunks = [
      {
        data: "Open https://chatgpt.com/activate and enter code ABCD-EFGH\n",
        stream: "stdout",
      },
    ];
    const sandbox = {
      getCommand: vi.fn().mockResolvedValue(command),
      runCommand: vi.fn().mockResolvedValue(command),
      sandboxId: "sandbox-1",
      stop: vi.fn(),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.sandboxCreate.mockResolvedValue(sandbox);
    mocked.sandboxGet.mockResolvedValue(sandbox);

    const snapshot = await startCodexDeviceAuthFlow({ userId: "user-1" });

    expect(snapshot).toMatchObject({
      flowId: "00000000-0000-0000-0000-000000000123",
      status: "prompted",
      userCode: "ABCD-EFGH",
      verificationUri: "https://chatgpt.com/activate",
    });
    expect(mocked.sandboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { CI: "1", CODEX_HOME: "/vercel/sandbox/.codex" },
        runtime: "node22",
      }),
    );
    expect(sandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "bash",
        detached: true,
        env: { CI: "1", CODEX_HOME: "/vercel/sandbox/.codex" },
      }),
    );
    expect(sandbox.runCommand.mock.calls[0]?.[0].args[1]).toContain("npm install -g @openai/codex");
    expect(sandbox.runCommand.mock.calls[0]?.[0].args[1]).toContain("codex login --device-auth");
    expect(rows[0]).toMatchObject({
      command_id: "cmd-1",
      sandbox_id: "sandbox-1",
      status: "prompted",
      user_id: "user-1",
    });
  });

  it("starts local development auth without a Vercel Sandbox", async () => {
    process.env.CODEX_DEVICE_AUTH_MODE = "local";
    const rows: FlowRow[] = [];
    const admin = buildAdminMock(rows);
    const child = fakeChildProcess();
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.spawn.mockImplementation(() => {
      setTimeout(() => {
        child.stdout.emit("data", "Open https://chatgpt.com/activate and enter code WXYZ-1234\n");
      }, 0);
      return child.child;
    });

    const snapshot = await startCodexDeviceAuthFlow({ userId: "user-1" });

    expect(snapshot).toMatchObject({
      status: "prompted",
      userCode: "WXYZ-1234",
      verificationUri: "https://chatgpt.com/activate",
    });
    expect(mocked.sandboxCreate).not.toHaveBeenCalled();
    expect(mocked.spawn).toHaveBeenCalledWith(
      "bash",
      [
        "-lc",
        expect.stringContaining(
          "npm exec --yes --package @openai/codex -- codex login --device-auth",
        ),
      ],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({
          CODEX_HOME: expect.stringContaining(".codex"),
        }),
      }),
    );
    expect(rows[0]?.sandbox_id).toMatch(/^local:/);
  });

  it("persists completed auth JSON durably and deletes the flow after it is consumed", async () => {
    const rows: FlowRow[] = [
      buildFlowRow({
        instructions: "Open https://chatgpt.com/activate and enter code ABCD-EFGH",
        status: "prompted",
        user_code: "ABCD-EFGH",
        verification_uri: "https://chatgpt.com/activate",
      }),
    ];
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-05-19T00:00:00.000Z",
      tokens: {
        access_token: "access-token-value-1234567890",
        refresh_token: "refresh-token-value-1234567890",
      },
    });
    const command = new FakeCommand();
    command.exitCode = 0;
    command.outputText = "Open https://chatgpt.com/activate and enter code ABCD-EFGH\n";
    const sandbox = {
      getCommand: vi.fn().mockResolvedValue(command),
      readFileToBuffer: vi.fn().mockResolvedValue(Buffer.from(authJson, "utf8")),
      sandboxId: "sandbox-1",
      stop: vi.fn(),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.sandboxGet.mockResolvedValue(sandbox);

    const snapshot = await getCodexDeviceAuthFlowSnapshot({
      flowId: "00000000-0000-0000-0000-000000000123",
      userId: "user-1",
    });

    expect(snapshot).toMatchObject({ status: "authenticated" });
    expect(rows[0]).toMatchObject({
      auth_cache_last_refresh: "2026-05-19T00:00:00.000Z",
      encrypted_auth_json: `encrypted:${authJson}`,
      status: "authenticated",
    });
    expect(sandbox.stop).toHaveBeenCalled();

    const consumed = await consumeAuthenticatedCodexDeviceAuthFlow({
      flowId: "00000000-0000-0000-0000-000000000123",
      userId: "user-1",
    });

    expect(consumed).toMatchObject({
      authJson,
      metadata: {
        accountEmail: null,
        accountId: null,
        lastRefresh: "2026-05-19T00:00:00.000Z",
      },
    });
    expect(rows).toHaveLength(1);

    await expect(
      deleteCodexDeviceAuthFlow({
        flowId: "00000000-0000-0000-0000-000000000123",
        userId: "user-1",
      }),
    ).resolves.toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("checks a completed command before expiring an overdue flow", async () => {
    const rows: FlowRow[] = [
      buildFlowRow({
        expires_at: "2000-01-01T00:00:00.000Z",
        status: "prompted",
      }),
    ];
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-05-19T00:00:00.000Z",
      tokens: {
        access_token: "access-token-value-1234567890",
        refresh_token: "refresh-token-value-1234567890",
      },
    });
    const command = new FakeCommand();
    command.exitCode = 0;
    command.outputText = "Open https://chatgpt.com/activate and enter code ABCD-EFGH\n";
    const sandbox = {
      getCommand: vi.fn().mockResolvedValue(command),
      readFileToBuffer: vi.fn().mockResolvedValue(Buffer.from(authJson, "utf8")),
      sandboxId: "sandbox-1",
      stop: vi.fn(),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.sandboxGet.mockResolvedValue(sandbox);

    const snapshot = await getCodexDeviceAuthFlowSnapshot({
      flowId: "00000000-0000-0000-0000-000000000123",
      userId: "user-1",
    });

    expect(snapshot).toMatchObject({ status: "authenticated" });
    expect(rows[0]).toMatchObject({
      encrypted_auth_json: `encrypted:${authJson}`,
      status: "authenticated",
    });
  });
});
