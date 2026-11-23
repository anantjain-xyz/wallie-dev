import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { factoryMemoryProposalPath } from "@/lib/factory-memory/proposal";
import type {
  SandboxConnection,
  SandboxExecHandle,
  SandboxProviderDriver,
} from "@/lib/sandbox/types";
import type { ValidationPlan } from "@/lib/validation-evidence/contracts";
import { validationPlanPath } from "@/lib/validation-evidence/plan";

type E2BConnection = Extract<SandboxConnection, { provider: "e2b" }>;

export const BASE_SHA = "128509c4128509c4128509c4128509c4128509c4";
export const TREE_SHA = "628509c4128509c4128509c4128509c4128509c4";
export const HOSTED_SANDBOX_KEY = "synthetic-local-sandbox-key";
export const FIXTURE_AGENT_EXIT = "Local qualification reached the agent transport.";
export const QUALIFICATION_COMMAND = "printf 'Wallie qualification passed\\n'";

type CompletedAttempt = {
  artifact: string;
  plan?: ValidationPlan;
  memoryProposal?: string;
};

type AttemptOutcome = { kind: "complete"; value: CompletedAttempt } | { kind: "fail" };

const measuredUsage =
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 21, output_tokens: 13 } }) + "\n";

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
  const outcomes = new Map<string, AttemptOutcome>();
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
          assert(!sandbox.stopped, "The processor used a stopped fixture sandbox.");
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
              for (const name of files.keys()) {
                if (name.startsWith(path + "/")) files.delete(name);
              }
              scopedMaterial.delete(path);
            }
            return commandResult();
          }
          const script = args[1];
          if (
            cmd === "node" &&
            args[0] === "-e" &&
            script?.includes("fs.openSync(process.argv[1]")
          ) {
            const [, , path, maxBytes] = args;
            assert(
              path &&
                /^\/tmp\/wallie-(?:validation-plan|memory-proposal)-[a-f0-9-]+\.(?:json|md)$/.test(
                  path,
                ),
            );
            const content = files.get(path);
            return content !== undefined && Buffer.byteLength(content) <= Number(maxBytes)
              ? commandResult(content)
              : commandResult("", "", 1);
          }
          if (cmd === "node" && args[0] === "-e" && script?.includes("HEAD^{tree}")) {
            return commandResult(
              JSON.stringify({ commitSha: BASE_SHA, treeSha: TREE_SHA, clean: true }),
            );
          }
          if (
            cmd === "node" &&
            args[0] === "-e" &&
            script?.includes("const command = JSON.parse(process.argv[1])")
          ) {
            const spec: unknown = JSON.parse(args[2]);
            assert(spec && typeof spec === "object" && "command" in spec);
            assert.equal(spec.command, QUALIFICATION_COMMAND);
            return commandResult(
              JSON.stringify({ exitCode: 0, error: false, truncated: false, log: "", reports: [] }),
            );
          }
          if (
            cmd === "bash" &&
            args[0] === "-lc" &&
            script?.includes("Preserve Wallie stage source")
          ) {
            assert(script.includes(BASE_SHA) && script.includes("reserved_runtime_path"));
            return commandResult(`UNCHANGED\n${BASE_SHA}\n`);
          }
          const credentialIndex = args.indexOf("wallie-credential");
          const scoped = credentialIndex !== -1;
          const command = args.find((arg) => arg.includes("codex 'exec'"));
          if (cmd === "bash" && command) {
            const [promptPath, prompt] =
              [...files].find(([path]) => path.endsWith("/prompt.txt")) ?? [];
            assert(promptPath);
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
            for (const [runId, outcome] of outcomes) {
              const path = validationPlanPath(runId);
              if (!files.has(path)) continue;
              outcomes.delete(runId);
              if (outcome.kind === "fail")
                return commandResult(measuredUsage, FIXTURE_AGENT_EXIT, 1);
              const completion = outcome.value;
              for (const [path, configuration] of files) {
                if (!path.endsWith(".mcp.json")) continue;
                assert(configuration.includes("https://browser-fixture.example.test/mcp"));
                assert(
                  configuration.includes('"capture"') && configuration.includes('"record_video"'),
                );
                // The synthetic hosted process exposes the exact approved fixture operations.
                files.set(`${path}.ready`, "ready\n");
              }
              files.set(promptPath.replace(/prompt\.txt$/, "final-output.md"), completion.artifact);
              if (completion.plan) files.set(path, JSON.stringify(completion.plan));
              if (completion.memoryProposal) {
                files.set(factoryMemoryProposalPath(runId), completion.memoryProposal);
              }
              return commandResult(measuredUsage);
            }
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
          files.clear();
        },
      };
    },
    async createUtility() {
      throw new Error("The unchanged fixture checkout cannot require a delivery sandbox.");
    },
    async findAcquisition() {
      return [];
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
  return {
    driver,
    sandboxes,
    invocations,
    scopedMaterial,
    failAttemptAfterUsage(runId: string) {
      assert(!outcomes.has(runId));
      outcomes.set(runId, { kind: "fail" });
    },
    completeAttempt(runId: string, completion: CompletedAttempt) {
      assert(!outcomes.has(runId));
      outcomes.set(runId, { kind: "complete", value: completion });
    },
  };
}

export type FactoryRuntimeTransport = ReturnType<typeof createFactoryRuntimeTransport>;
