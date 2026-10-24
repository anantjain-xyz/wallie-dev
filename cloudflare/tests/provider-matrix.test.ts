import { describe, expect, it, vi } from "vitest";
import { AGENT_PROVIDERS } from "@/lib/agent-config/contracts";
import { createAgentRunner } from "@/lib/agent-runner";
import type { AgentEvent } from "@/lib/agent-runner/types";
import { SANDBOX_PROVIDER_IDS, type SandboxHandle } from "@/lib/sandbox/types";
import { prepareSessionSandbox } from "@/lib/sandbox/setup";

const pairs = AGENT_PROVIDERS.flatMap((agent) =>
  SANDBOX_PROVIDER_IDS.map((provider) => ({ agent, provider })),
);
const messages = {
  codex: [
    { type: "text", text: "Reviewable output synthetic-gh-token" },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
  ],
  "claude-code": [
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Reviewable output synthetic-gh-token" }] },
    },
    { type: "result", subtype: "success", result: "Reviewable output", is_error: false },
  ],
  cursor: [
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Reviewable output synthetic-gh-token" }] },
    },
    { type: "result", result: "Reviewable output" },
  ],
  opencode: [
    { type: "text", part: { text: "Reviewable output synthetic-gh-token" } },
    { type: "step_finish", part: { tokens: { input: 1, output: 2 }, reason: "stop" } },
  ],
};

describe("all agent/sandbox combinations under workerd", () => {
  it.each(pairs)("prepares and streams $agent on $provider", async ({ agent, provider }) => {
    const files = new Map<string, string>();
    let prepared = false;
    const sandbox: SandboxHandle = {
      id: `${provider}-synthetic`,
      repoPath: `/provider/${provider}/repo`,
      writeFile: vi.fn(async (path, bytes) => {
        files.set(path, bytes.toString());
      }),
      readFile: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
      exec: vi.fn(async (cmd, args) => {
        const output =
          prepared && cmd === "bash" && !args[1]?.startsWith("mkdir -p ")
            ? messages[agent].map((message) => JSON.stringify(message)).join("\n") + "\n"
            : "";
        return {
          logs: async function* () {
            if (output) {
              yield { data: output.slice(0, 17), stream: "stdout" as const };
              yield { data: output.slice(17), stream: "stdout" as const };
            }
          },
          output: async () => ({ stdout: output, stderr: "" }),
          exitCode: Promise.resolve(0),
          kill: async () => undefined,
        };
      }),
    };
    await prepareSessionSandbox({
      handle: sandbox,
      provider,
      repoAlreadyCloned: provider === "vercel",
      request: {
        sessionId: "session",
        workspaceId: "workspace",
        agentProvider: agent,
        baseBranch: "main",
        branch: "wallie/test",
        installationToken: "synthetic-gh-token",
        repoFullName: "example/test",
      },
    });
    prepared = true;
    const runner = createAgentRunner(agent, {
      codex: {
        credential: {
          type: "platform_api_key",
          secret: "synthetic-codex-key",
          userId: "user",
          expiresAt: null,
        },
      },
      claudeCode: { credential: { secret: "synthetic-anthropic-key" } },
      cursor: {
        credential: {
          secret: "synthetic-cursor-key",
          userId: "user",
          generation: "generation",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
      openCode: {
        model: "anthropic/test-model",
        providerCredentials: { anthropic: { secret: "synthetic-opencode-key" } },
      },
    });
    const events: AgentEvent[] = [];
    try {
      for await (const event of runner.start({
        prompt: "Produce reviewable output",
        sessionId: "session",
        sandbox,
        secrets: ["synthetic-gh-token"],
      }))
        events.push(event);
    } finally {
      await sandbox.stop();
    }
    expect(
      events.some((event) => event.type === "text" && event.text.includes("Reviewable output")),
    ).toBe(true);
    expect(events.some((event) => event.type === "completion" && event.taskComplete)).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("synthetic-gh-token");
    expect([...files.keys()].every((path) => path.startsWith("/tmp/wallie-"))).toBe(true);
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });
});
