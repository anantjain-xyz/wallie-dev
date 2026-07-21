import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  daytonaClient: vi.fn(),
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
  e2bConnect: vi.fn(),
  e2bCreate: vi.fn(),
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

vi.mock("e2b", () => ({
  FileNotFoundError: class FileNotFoundError extends Error {},
  Sandbox: {
    connect: mocked.e2bConnect,
    create: mocked.e2bCreate,
  },
}));

vi.mock("@daytona/sdk", () => ({
  Daytona: class Daytona {
    constructor(input: unknown) {
      return mocked.daytonaClient(input);
    }
  },
  DaytonaNotFoundError: class DaytonaNotFoundError extends Error {},
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
  encryptSecretValue: mocked.encryptSecretValue,
}));

import {
  cancelCodexDeviceAuthFlow,
  consumeAuthenticatedCodexDeviceAuthFlow,
  deleteCodexDeviceAuthFlow,
  getCodexDeviceAuthFlowSnapshot,
  startCodexDeviceAuthFlow,
} from "@/lib/codex/device-auth";

const vercelCredentials = {
  projectId: "prj_workspace",
  teamId: "team_workspace",
  token: "vca_workspace",
};

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
  sandbox_connection_revision?: string | null;
  sandbox_provider?: string | null;
  status: string;
  updated_at: string;
  user_code: string | null;
  user_id: string;
  verification_uri: string | null;
  workspace_id?: string | null;
};

class FakeCommand {
  cmdId = "cmd-1";
  exitCode: number | null = null;
  logChunks: Array<{ data: string; stream: "stdout" | "stderr" }> = [];
  outputText = "";
  waitResult: FakeCommand | null = null;

  async *logs() {
    for (const chunk of this.logChunks) {
      yield chunk;
    }
  }

  async output() {
    return this.outputText;
  }

  wait = vi.fn(async () => this.waitResult ?? this);
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
    sandbox_connection_revision: null,
    sandbox_provider: null,
    status: "starting",
    updated_at: "2026-05-19T00:00:00.000Z",
    user_code: null,
    user_id: "user-1",
    verification_uri: null,
    workspace_id: null,
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
      maybeSingle: async () => {
        const row = filtered(rows, filters)[0] ?? null;
        if (!row) return { data: null, error: null };
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
        data:
          "Device code authorization\n" +
          "Open https://chatgpt.com/activate and enter code ABCD-EFGH\n",
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

    const snapshot = await startCodexDeviceAuthFlow({
      userId: "user-1",
      vercelCredentials,
    });

    expect(snapshot).toMatchObject({
      flowId: "00000000-0000-0000-0000-000000000123",
      status: "prompted",
      userCode: "ABCD-EFGH",
      verificationUri: "https://chatgpt.com/activate",
    });
    expect(mocked.sandboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { CI: "1", CODEX_HOME: "/vercel/sandbox/.codex" },
        projectId: "prj_workspace",
        runtime: "node22",
        teamId: "team_workspace",
        token: "vca_workspace",
      }),
    );
    expect(mocked.sandboxGet).toHaveBeenCalledWith({
      projectId: "prj_workspace",
      sandboxId: "sandbox-1",
      teamId: "team_workspace",
      token: "vca_workspace",
    });
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

  it("runs and reconnects ChatGPT device auth through E2B", async () => {
    const rows: FlowRow[] = [];
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-05-19T00:00:00.000Z",
      tokens: {
        access_token: "access-token-value-1234567890",
        refresh_token: "refresh-token-value-1234567890",
      },
    });
    const filesRead = vi.fn(async (path: string) => {
      if (path.endsWith(".log")) {
        return "Open https://chatgpt.com/activate and enter code E2B1-AUTH\n";
      }
      if (path.endsWith(".exit")) return "0";
      if (path === "/home/user/.codex/auth.json") return authJson;
      throw new Error(`unexpected E2B file: ${path}`);
    });
    const e2bSandbox = {
      commands: { run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "" }) },
      files: { read: filesRead },
      kill: vi.fn(),
      sandboxId: "e2b-sandbox-1",
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.e2bCreate.mockResolvedValue(e2bSandbox);
    mocked.e2bConnect.mockResolvedValue(e2bSandbox);

    const snapshot = await startCodexDeviceAuthFlow({
      connection: {
        credentials: { apiKey: "e2b-secret" },
        provider: "e2b",
        revision: "e2b-revision-1",
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    expect(snapshot.error).toBeNull();
    expect(snapshot).toMatchObject({ status: "authenticated" });
    expect(mocked.e2bCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "e2b-secret",
        lifecycle: { onTimeout: "kill" },
        metadata: expect.objectContaining({ wallie_workspace_id: "workspace-1" }),
      }),
    );
    expect(mocked.e2bConnect).toHaveBeenCalledWith("e2b-sandbox-1", {
      apiKey: "e2b-secret",
    });
    expect(rows[0]).toMatchObject({
      sandbox_connection_revision: "e2b-revision-1",
      sandbox_id: "e2b-sandbox-1",
      sandbox_provider: "e2b",
      status: "authenticated",
      workspace_id: "workspace-1",
    });
    expect(e2bSandbox.kill).toHaveBeenCalled();
  });

  it("runs and reconnects ChatGPT device auth through Daytona", async () => {
    const rows: FlowRow[] = [];
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-05-19T00:00:00.000Z",
      tokens: {
        access_token: "access-token-value-1234567890",
        refresh_token: "refresh-token-value-1234567890",
      },
    });
    const downloadFile = vi.fn(async (path: string) => {
      if (path.endsWith(".log")) {
        return Buffer.from("Open https://chatgpt.com/activate and enter code DAYT-AUTH\n", "utf8");
      }
      if (path.endsWith(".exit")) return Buffer.from("0", "utf8");
      if (path === "/home/daytona/.codex/auth.json") return Buffer.from(authJson, "utf8");
      throw new Error(`unexpected Daytona file: ${path}`);
    });
    const daytonaSandbox = {
      delete: vi.fn(),
      fs: { downloadFile },
      id: "daytona-sandbox-1",
      process: {
        executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: "" }),
      },
    };
    const dispose = vi.fn();
    const daytonaClient = {
      [Symbol.asyncDispose]: dispose,
      create: vi.fn().mockResolvedValue(daytonaSandbox),
      get: vi.fn().mockResolvedValue(daytonaSandbox),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.daytonaClient.mockReturnValue(daytonaClient);

    const snapshot = await startCodexDeviceAuthFlow({
      connection: {
        credentials: {
          apiKey: "daytona-secret",
          apiUrl: "https://daytona.example/api",
          target: "enterprise",
        },
        provider: "daytona",
        revision: "daytona-revision-1",
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    expect(snapshot.error).toBeNull();
    expect(snapshot).toMatchObject({ status: "authenticated" });
    expect(mocked.daytonaClient).toHaveBeenCalledWith({
      apiKey: "daytona-secret",
      apiUrl: "https://daytona.example/api",
      target: "enterprise",
    });
    expect(daytonaClient.create).toHaveBeenCalledWith(
      expect.objectContaining({
        autoStopInterval: 0,
        image: "node:22-bookworm",
        labels: expect.objectContaining({ wallie_workspace_id: "workspace-1" }),
      }),
      { timeout: 60 },
    );
    expect(rows[0]).toMatchObject({
      sandbox_connection_revision: "daytona-revision-1",
      sandbox_id: "daytona-sandbox-1",
      sandbox_provider: "daytona",
      status: "authenticated",
      workspace_id: "workspace-1",
    });
    expect(daytonaSandbox.delete).toHaveBeenCalledWith(60, true);
    expect(dispose).toHaveBeenCalled();
  });

  it("extracts the current Codex CLI one-time code without using banner text", async () => {
    const rows: FlowRow[] = [];
    const admin = buildAdminMock(rows);
    const command = new FakeCommand();
    command.logChunks = [
      {
        data:
          "\nWelcome to Codex [v0.133.0]\n" +
          "OpenAI's command-line coding agent\n\n" +
          "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
          "1. Open this link in your browser and sign in to your account\n" +
          "   https://auth.openai.com/codex/device\n\n" +
          "2. Enter this one-time code (expires in 15 minutes)\n" +
          "   MMP2-IDEMJ\n\n" +
          "Device codes are a common phishing target. Never share this code.\n",
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
      status: "prompted",
      userCode: "MMP2-IDEMJ",
      verificationUri: "https://auth.openai.com/codex/device",
    });
    expect(rows[0]).toMatchObject({
      status: "prompted",
      user_code: "MMP2-IDEMJ",
      verification_uri: "https://auth.openai.com/codex/device",
    });
  });

  it("does not surface unlabeled hyphenated setup text as a device code", async () => {
    const rows: FlowRow[] = [];
    const admin = buildAdminMock(rows);
    const command = new FakeCommand();
    command.logChunks = [
      {
        data: "Open https://auth.openai.com/codex/device\n" + "Preparing VERIFY-DEPS-BEFORE\n",
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
      status: "prompted",
      userCode: null,
      verificationUri: "https://auth.openai.com/codex/device",
    });
    expect(rows[0]).toMatchObject({
      status: "prompted",
      user_code: null,
      verification_uri: "https://auth.openai.com/codex/device",
    });
  });

  it("returns an actionable error when sandbox startup is rejected with payment required", async () => {
    const rows: FlowRow[] = [];
    const admin = buildAdminMock(rows);
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.sandboxCreate.mockRejectedValue(new Error("Status code 402 is not ok"));

    const snapshot = await startCodexDeviceAuthFlow({
      userId: "user-1",
      vercelCredentials,
    });

    expect(snapshot).toMatchObject({
      status: "error",
      userCode: null,
      verificationUri: null,
    });
    expect(snapshot.error).toContain("active sandbox provider returned 402 Payment Required");
    expect(snapshot.error).not.toContain("Status code 402 is not ok");
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
      vercelCredentials,
    });

    expect(snapshot).toMatchObject({ status: "authenticated" });
    expect(mocked.sandboxGet).toHaveBeenCalledWith({
      projectId: "prj_workspace",
      sandboxId: "sandbox-1",
      teamId: "team_workspace",
      token: "vca_workspace",
    });
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

  it("waits for detached sandbox commands before deciding a flow is still running", async () => {
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
    command.exitCode = null;
    const finished = new FakeCommand();
    finished.exitCode = 0;
    finished.outputText = "Open https://chatgpt.com/activate and enter code ABCD-EFGH\n";
    command.waitResult = finished;
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

    expect(command.wait).toHaveBeenCalled();
    expect(snapshot).toMatchObject({ status: "authenticated" });
    expect(rows[0]).toMatchObject({
      encrypted_auth_json: `encrypted:${authJson}`,
      status: "authenticated",
    });
  });

  it("returns an actionable error when OpenAI rejects Codex login with payment required", async () => {
    const rows: FlowRow[] = [
      buildFlowRow({
        instructions: "Open https://auth.openai.com/codex/device and enter code ABCD-EFGH",
        status: "prompted",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.openai.com/codex/device",
      }),
    ];
    const command = new FakeCommand();
    command.exitCode = 1;
    command.outputText = "Status code 402 is not ok\n";
    const sandbox = {
      getCommand: vi.fn().mockResolvedValue(command),
      sandboxId: "sandbox-1",
      stop: vi.fn(),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.sandboxGet.mockResolvedValue(sandbox);

    const snapshot = await getCodexDeviceAuthFlowSnapshot({
      flowId: "00000000-0000-0000-0000-000000000123",
      userId: "user-1",
    });
    if (!snapshot) {
      throw new Error("Expected payment-required flow snapshot.");
    }

    expect(snapshot).toMatchObject({ status: "error" });
    expect(snapshot.error).toContain("ChatGPT account with Codex access");
    expect(snapshot.error).not.toContain("Status code 402 is not ok");
    expect(sandbox.stop).toHaveBeenCalled();
  });

  it("keeps sandbox polling payment failures distinct from OpenAI login failures", async () => {
    const rows: FlowRow[] = [
      buildFlowRow({
        instructions: "Open https://auth.openai.com/codex/device and enter code ABCD-EFGH",
        status: "prompted",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.openai.com/codex/device",
      }),
    ];
    const sandbox = {
      getCommand: vi.fn().mockRejectedValue(new Error("Status code 402 is not ok")),
      sandboxId: "sandbox-1",
      stop: vi.fn(),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.sandboxGet.mockResolvedValue(sandbox);

    const snapshot = await getCodexDeviceAuthFlowSnapshot({
      flowId: "00000000-0000-0000-0000-000000000123",
      userId: "user-1",
    });
    if (!snapshot) {
      throw new Error("Expected sandbox payment-required flow snapshot.");
    }

    expect(snapshot).toMatchObject({ status: "error" });
    expect(snapshot.error).toContain("active sandbox provider returned 402 Payment Required");
    expect(snapshot.error).not.toContain("ChatGPT account with Codex access");
    expect(sandbox.stop).toHaveBeenCalled();
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

  it("preserves completed auth when cancel races with command completion", async () => {
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
    command.exitCode = null;
    const finished = new FakeCommand();
    finished.exitCode = 0;
    finished.outputText = "Open https://chatgpt.com/activate and enter code ABCD-EFGH\n";
    command.waitResult = finished;
    const sandbox = {
      getCommand: vi.fn().mockResolvedValue(command),
      readFileToBuffer: vi.fn().mockResolvedValue(Buffer.from(authJson, "utf8")),
      sandboxId: "sandbox-1",
      stop: vi.fn(),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.sandboxGet.mockResolvedValue(sandbox);

    await expect(
      cancelCodexDeviceAuthFlow({
        flowId: "00000000-0000-0000-0000-000000000123",
        userId: "user-1",
      }),
    ).resolves.toBe(true);

    expect(rows[0]).toMatchObject({
      encrypted_auth_json: `encrypted:${authJson}`,
      status: "authenticated",
    });
  });

  it("returns a completed active flow instead of bulk-canceling it when starting another sign-in", async () => {
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
    command.exitCode = null;
    const finished = new FakeCommand();
    finished.exitCode = 0;
    finished.outputText = "Open https://chatgpt.com/activate and enter code ABCD-EFGH\n";
    command.waitResult = finished;
    const sandbox = {
      getCommand: vi.fn().mockResolvedValue(command),
      readFileToBuffer: vi.fn().mockResolvedValue(Buffer.from(authJson, "utf8")),
      sandboxId: "sandbox-1",
      stop: vi.fn(),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.sandboxGet.mockResolvedValue(sandbox);

    const snapshot = await startCodexDeviceAuthFlow({
      userId: "user-1",
      vercelCredentials,
    });

    expect(snapshot).toMatchObject({
      flowId: "00000000-0000-0000-0000-000000000123",
      status: "authenticated",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      encrypted_auth_json: `encrypted:${authJson}`,
      status: "authenticated",
    });
    expect(mocked.sandboxCreate).not.toHaveBeenCalled();
    expect(mocked.sandboxGet).toHaveBeenCalledWith({
      sandboxId: "sandbox-1",
    });
  });

  it("expires unconsumed authenticated flows after their TTL", async () => {
    const rows: FlowRow[] = [
      buildFlowRow({
        encrypted_auth_json: "encrypted:{}",
        expires_at: "2000-01-01T00:00:00.000Z",
        status: "authenticated",
      }),
    ];
    const sandbox = {
      sandboxId: "sandbox-1",
      stop: vi.fn(),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(buildAdminMock(rows));
    mocked.sandboxGet.mockResolvedValue(sandbox);

    const snapshot = await getCodexDeviceAuthFlowSnapshot({
      flowId: "00000000-0000-0000-0000-000000000123",
      userId: "user-1",
    });

    expect(snapshot).toMatchObject({ status: "expired" });
    expect(rows[0]).toMatchObject({
      encrypted_auth_json: null,
      status: "expired",
    });
  });
});
