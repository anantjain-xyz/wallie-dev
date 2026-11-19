import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { prepareMcpAdapter } from "./mcp-runtime";
import { withRunnerCredentials } from "./scoped-credentials";
import type { AgentRunnerStartInput } from "./types";

const toolRevisionId = "00000000-0000-4000-8000-000000000001";
const token = "synthetic-mcp-fixture-token";
const runtime: NonNullable<AgentRunnerStartInput["mcp"]> = {
  manifest: {
    agentId: "00000000-0000-4000-8000-000000000002",
    servers: [
      {
        toolRevisionId,
        serverId: "00000000-0000-4000-8000-000000000003",
        serverSlug: "fixture",
        revisionNumber: 1,
        endpoint: "https://approved.example.test/mcp",
        operations: ["read_item"],
        auth: { kind: "bearer", secretBindingId: "00000000-0000-4000-8000-000000000004" },
      },
    ],
  },
  loadCredentials: async () => new Map([[toolRevisionId, token]]),
};

it.each(["completion", "timeout", "cancellation", "setup failure"])(
  "verifies MCP config and credential cleanup after %s",
  async (result) => {
    const directory = await mkdtemp(join(tmpdir(), "wallie-mcp-cleanup-"));
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    const controller = new AbortController();
    const onCleanup = vi.fn(async () => {});
    const input = {
      sessionId: "fixture",
      prompt: "Fixture",
      scopedCredential: true,
      signal: controller.signal,
      sandbox,
      mcp: { ...runtime, onCleanup },
    } satisfies AgentRunnerStartInput;
    const credentialPath = join(directory, "wallie1.mcp.json");
    const bridgePath = join(directory, "wallie-mcp.cjs");
    const events = withRunnerCredentials(input, async function* (safety, material) {
      if (!material) throw new Error("Scoped material unavailable.");
      const scoped = await prepareMcpAdapter({
        runtime,
        sandbox,
        directory,
        signal: controller.signal,
        material,
      });
      await scoped.stageCredentials(material, safety);
      await sandbox.writeFile(`${credentialPath}.ready`, "ready\n");
      if (result === "setup failure") throw new Error("The adapter setup failed.");
      if (result === "completion") {
        yield { type: "completion", taskComplete: true, summary: "Fixture done" };
        return;
      }
      await material.exec("sh", ["-c", "exec sleep 60"], { signal: controller.signal });
      yield { type: "progress", text: "Provider started" };
    })[Symbol.asyncIterator]();
    try {
      if (result === "setup failure") {
        await expect(events.next()).rejects.toThrow("The adapter setup failed.");
      } else {
        const received = await events.next();
        if (result === "completion") {
          expect(received.value).toMatchObject({ type: "completion" });
        } else {
          expect(received.value).toMatchObject({ type: "progress" });
          await expect(readFile(credentialPath, "utf8")).resolves.toContain(token);
          if (result === "timeout") {
            const deadline = AbortSignal.timeout(10);
            deadline.addEventListener("abort", () => controller.abort(deadline.reason), {
              once: true,
            });
          } else {
            controller.abort(new Error("Fixture canceled"));
          }
        }
      }
      await vi.waitFor(async () => {
        expect(onCleanup).toHaveBeenCalledExactlyOnceWith("removed");
        for (const path of [bridgePath, credentialPath, `${credentialPath}.ready`]) {
          await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
      expect(JSON.stringify(sandbox.calls)).not.toContain(token);
    } finally {
      await events.return?.();
      await sandbox.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
