import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUtilitySandbox, stopSandboxById } from "@/lib/sandbox";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import {
  recordWorkspaceSandbox,
  reserveWorkspaceSandbox,
  settleWorkspaceResource,
} from "@/lib/workspaces/resource-operations";
import {
  SANDBOX_PROVIDER_IDS,
  type SandboxConnection,
  type SandboxHandle,
} from "@/lib/sandbox/types";
import { SOURCE_CHECKPOINT_REF } from "./source-checkpoint";
import { restoreAndPushSourceInSandbox } from "./source-delivery-sandbox";

vi.mock("@/lib/sandbox", () => ({
  createUtilitySandbox: vi.fn(),
  stopSandboxById: vi.fn(),
}));
vi.mock("@/lib/sandbox-connections/server", () => ({
  loadRequiredWorkspaceSandboxConnection: vi.fn(),
}));
vi.mock("@/lib/workspaces/resource-operations", async (original) => ({
  ...(await original<typeof import("@/lib/workspaces/resource-operations")>()),
  reserveWorkspaceSandbox: vi.fn(),
  recordWorkspaceSandbox: vi.fn(),
  settleWorkspaceResource: vi.fn(),
}));

function fixture(provider: (typeof SANDBOX_PROVIDER_IDS)[number] = "vercel") {
  const connection = {
    provider,
    revision: "captured-revision",
    credentials: { token: "synthetic-provider-token", apiKey: "synthetic-provider-key" },
  } as SandboxConnection;
  const renewal = { eq: vi.fn().mockResolvedValue({ error: null }) };
  const update = vi.fn(() => renewal);
  const admin = { from: vi.fn(() => ({ update })) };
  const headSha = "b".repeat(40);
  const bytes = Buffer.from(
    `# v2 git bundle\n${headSha} ${SOURCE_CHECKPOINT_REF}\n\nsynthetic-pack`,
  );
  const input = {
    baseSha: "a".repeat(40),
    headSha,
    branch: "wallie/attempt",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    remoteUrl: "https://github.com/example/repo.git",
    token: "synthetic-github-token",
  };
  const handle: SandboxHandle = {
    id: `${provider}-helper`,
    repoPath: "/unused",
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    stop: vi.fn(),
    exec: vi.fn(async (command, args) => ({
      output: async () => ({
        stdout:
          command === "git" && args[0] === "bundle" && args[1] === "unbundle"
            ? `${headSha} ${SOURCE_CHECKPOINT_REF}\n`
            : "",
        stderr: "",
      }),
      exitCode: Promise.resolve(0),
      logs: async function* () {},
      kill: async () => undefined,
    })),
  };
  vi.mocked(loadRequiredWorkspaceSandboxConnection).mockResolvedValue({ connection } as never);
  vi.mocked(reserveWorkspaceSandbox).mockResolvedValue("operation");
  vi.mocked(recordWorkspaceSandbox).mockResolvedValue(true);
  vi.mocked(settleWorkspaceResource).mockResolvedValue(undefined);
  vi.mocked(stopSandboxById).mockResolvedValue(undefined);
  vi.mocked(createUtilitySandbox).mockImplementation(async (request) => {
    await request.onSandboxCreated({ provider, sandboxId: handle.id });
    return handle;
  });
  return {
    connection,
    admin,
    update,
    input,
    handle,
    context: { admin: admin as never, workspaceId: "workspace", runId: "run" },
  };
}

beforeEach(() => vi.resetAllMocks());

describe("source delivery utility sandboxes", () => {
  it.each(SANDBOX_PROVIDER_IDS)(
    "restores, pushes, and cleans up on the selected %s connection revision",
    async (provider) => {
      const f = fixture(provider);
      await expect(restoreAndPushSourceInSandbox(f.input, f.context)).resolves.toBe(f.input.branch);
      expect(reserveWorkspaceSandbox).toHaveBeenCalledWith(f.admin, {
        connection: f.connection,
        provider,
        timeoutMs: 120_000,
        acquisitionTimeoutMs: 60_000,
        workspaceId: "workspace",
      });
      expect(createUtilitySandbox).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "run", workspaceId: "workspace" }),
        f.connection,
      );
      expect(recordWorkspaceSandbox).toHaveBeenCalledExactlyOnceWith(
        f.admin,
        "operation",
        f.handle.id,
      );
      expect(vi.mocked(recordWorkspaceSandbox).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(f.handle.exec).mock.invocationCallOrder[0]!,
      );
      expect(f.update).toHaveBeenCalledWith({ recovery_after: expect.any(String) });
      expect(f.handle.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/tmp\/wallie-delivery-.*\/source\.bundle$/),
        f.input.bytes,
        { mode: 0o600 },
      );
      expect(f.handle.exec).toHaveBeenCalledWith(
        "git",
        ["push", f.input.remoteUrl, `${f.input.headSha}:refs/heads/${f.input.branch}`],
        expect.objectContaining({ env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }) }),
      );
      expect(stopSandboxById).toHaveBeenCalledExactlyOnceWith(f.handle.id, {
        connection: f.connection,
        throwOnError: true,
      });
      expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(f.admin, "operation", true);
    },
  );

  it("retains cleanup ownership if stopping the helper fails", async () => {
    const f = fixture("daytona");
    vi.mocked(stopSandboxById).mockRejectedValue(new Error("synthetic-provider-key"));
    await expect(restoreAndPushSourceInSandbox(f.input, f.context)).rejects.toThrow(
      "Source delivery sandbox cleanup will retry.",
    );
    expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(f.admin, "operation", false);
  });

  it("retains an unknown acquisition until its provider recovery deadline", async () => {
    const f = fixture("e2b");
    vi.mocked(createUtilitySandbox).mockRejectedValue(new Error("ambiguous provider timeout"));
    await expect(restoreAndPushSourceInSandbox(f.input, f.context)).rejects.toThrow(
      "Could not provision source delivery sandbox.",
    );
    expect(settleWorkspaceResource).not.toHaveBeenCalled();
    expect(stopSandboxById).not.toHaveBeenCalled();
  });

  it("keeps a known failed acquisition available to maintenance cleanup", async () => {
    const f = fixture("vercel");
    vi.mocked(createUtilitySandbox).mockImplementation(async (request) => {
      await request.onSandboxCreated({ provider: "vercel", sandboxId: f.handle.id });
      throw new Error("setup interrupted");
    });
    await expect(restoreAndPushSourceInSandbox(f.input, f.context)).rejects.toThrow(
      "Could not provision source delivery sandbox.",
    );
    expect(settleWorkspaceResource).toHaveBeenCalledExactlyOnceWith(f.admin, "operation", false);
  });
});
