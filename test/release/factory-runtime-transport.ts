import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type {
  SandboxConnection,
  SandboxExecHandle,
  SandboxProviderDriver,
} from "@/lib/sandbox/types";

type E2BConnection = Extract<SandboxConnection, { provider: "e2b" }>;

export const BASE_SHA = "128509c4128509c4128509c4128509c4128509c4";
export const HOSTED_SANDBOX_KEY = "synthetic-local-sandbox-key";
export const FIXTURE_AGENT_EXIT = "Local qualification reached the agent transport.";

function commandResult(stdout = "", stderr = "", code = 0): SandboxExecHandle {
  return {
    async *logs() {
      if (stdout) yield { stream: "stdout", data: stdout };
      if (stderr) yield { stream: "stderr", data: stderr };
    },
    output: async () => ({ stdout, stderr }),
    exitCode: Promise.resolve(code),
    kill: async () => undefined,
  };
}

export function createFactoryRuntimeTransport() {
  const sandboxes: { repo: string; provider: string; revision: string; stopped: boolean }[] = [];
  const invocations: {
    repo: string;
    prompt: string;
    command: string;
    secret: string;
    scoped: boolean;
  }[] = [];
  const scopedMaterial = new Map<string, string>();
  const driver: SandboxProviderDriver<E2BConnection> = {
    async create(request, connection) {
      assert.equal(connection.credentials.apiKey === HOSTED_SANDBOX_KEY, true);
      assert(request.repoFullName);
      const sandbox = {
        id: randomUUID(),
        repo: request.repoFullName,
        provider: connection.provider,
        revision: connection.revision,
        stopped: false,
      };
      sandboxes.push(sandbox);
      const files = new Map<string, string>();
      await request.onSandboxCreated?.({ provider: "e2b", sandboxId: sandbox.id });
      return {
        id: sandbox.id,
        repoPath: "/fixture/checkout",
        async exec(cmd, args, options) {
          if (cmd === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") {
            return commandResult(BASE_SHA + "\n");
          }
          if (cmd === "bash" && args.some((part) => part.includes("git check-ref-format"))) {
            return commandResult();
          }
          if (cmd === "sh" && args.includes("wallie-codex-config")) return commandResult();
          if (cmd === "mkdir" || (cmd === "bash" && args[1]?.startsWith("mkdir -p"))) {
            return commandResult();
          }
          if (cmd === "rm") {
            for (const path of args.slice(2)) {
              files.delete(path);
              scopedMaterial.delete(path);
            }
            return commandResult();
          }
          const credentialIndex = args.indexOf("wallie-credential");
          const scoped = credentialIndex !== -1;
          const command = args.find((arg) => arg.includes("codex 'exec'"));
          if (cmd === "bash" && command) {
            const prompt = [...files].find(([path]) => path.endsWith("/prompt.txt"))?.[1];
            assert(prompt, "Codex was launched without the rendered prompt.");
            const credentialPath = args[credentialIndex + 1];
            const secret = scoped
              ? scopedMaterial.get(credentialPath)?.match(/^export OPENAI_API_KEY='([^']+)'$/m)?.[1]
              : options?.env?.OPENAI_API_KEY;
            assert(secret, "No provider credential reached the fixture sandbox.");
            if (scoped) {
              // The real runner provides a private file and asks its launch shim to unlink it.
              files.delete(credentialPath);
              scopedMaterial.delete(credentialPath);
            }
            invocations.push({ repo: sandbox.repo, prompt, command, secret, scoped });
            // Everything through launch is real. The remote CLI stops here so
            // this fixture doesn't depend on source publication or vendor services.
            return commandResult("", FIXTURE_AGENT_EXIT, 1);
          }
          throw new Error("Unexpected sandbox qualification command: " + cmd);
        },
        async writeFile(path, data, options) {
          const content = data.toString();
          files.set(path, content);
          if (path.endsWith("/credential.env")) {
            assert.equal(options?.mode, 0o600);
            scopedMaterial.set(path, content);
          }
        },
        async readFile(path) {
          return files.get(path) ?? null;
        },
        async stop() {
          sandbox.stopped = true;
        },
      };
    },
    async createUtility() {
      throw new Error("This fixture ends before utility sandbox execution.");
    },
    async listRunning() {
      return [];
    },
    async hasRecoverableSource() {
      return false;
    },
    async stopById() {},
    async validate() {
      return { ok: true };
    },
  };
  return { driver, sandboxes, invocations, scopedMaterial };
}

export type FactoryRuntimeTransport = ReturnType<typeof createFactoryRuntimeTransport>;
