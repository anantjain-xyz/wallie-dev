import { describe, expect, it, vi } from "vitest";
import { AGENT_PROVIDERS } from "@/lib/agent-config/contracts";
import { createAgentRunner } from "@/lib/agent-runner";
import type { AgentEvent } from "@/lib/agent-runner/types";
import { SANDBOX_PROVIDER_IDS, type SandboxHandle } from "@/lib/sandbox/types";
import { prepareSessionSandbox } from "@/lib/sandbox/setup";

const pairs = AGENT_PROVIDERS.flatMap((agent) =>
  SANDBOX_PROVIDER_IDS.map((provider) => ({ agent, provider })),
);
const progressMessages = [
  "Inspecting the implementation synthetic-gh-token",
  "Tests are still running synthetic-gh-token",
];
const finalDeliverable =
  "# Delivered\n\nValidation: all checks passed.\n\nBlocker: release awaits review. synthetic-gh-token\n";
const messages = {
  codex: [
    ...progressMessages.map((text, index) => ({
      type: "item.completed",
      item: { id: `progress-${index}`, type: "agent_message", text },
    })),
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
  ],
  "claude-code": [
    ...progressMessages.map((text) => ({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    })),
    { type: "result", subtype: "success", result: finalDeliverable, is_error: false },
  ],
  cursor: [
    ...progressMessages.map((text) => ({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    })),
    { type: "result", subtype: "success", result: finalDeliverable, is_error: false },
  ],
  opencode: [
    ...progressMessages.flatMap((text, index) => [
      { type: "step_start", part: { messageID: `progress-${index}` } },
      { type: "text", part: { id: `text-${index}`, messageID: `progress-${index}`, text } },
      {
        type: "step_finish",
        part: {
          messageID: `progress-${index}`,
          tokens: { input: 1, output: 2 },
          reason: "tool-calls",
        },
      },
    ]),
    { type: "step_start", part: { messageID: "final" } },
    { type: "text", part: { id: "final-text", messageID: "final", text: finalDeliverable } },
    {
      type: "step_finish",
      part: { messageID: "final", tokens: { input: 1, output: 2 }, reason: "stop" },
    },
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
      readFile: vi.fn(async (path) => files.get(path) ?? null),
      stop: vi.fn(async () => undefined),
      exec: vi.fn(async (cmd, args) => {
        const output =
          prepared && cmd === "bash" && !args[1]?.startsWith("mkdir -p ")
            ? messages[agent].map((message) => JSON.stringify(message)).join("\n") + "\n"
            : "";
        if (output && agent === "codex") {
          const promptFile = [...files.keys()].find((path) => path.endsWith("/prompt.txt"));
          if (!promptFile) throw new Error("Codex must write its prompt before launch");
          const finalOutputFile = promptFile.replace(/prompt\.txt$/, "final-output.md");
          expect(args[1]).toContain(`'--output-last-message' '${finalOutputFile}'`);
          files.set(finalOutputFile, finalDeliverable);
        }
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
    const redactedFinal = finalDeliverable.replaceAll("synthetic-gh-token", "[REDACTED]");
    expect(events.filter((event) => event.type === "progress").map((event) => event.text)).toEqual([
      ...progressMessages.map((text) => text.replaceAll("synthetic-gh-token", "[REDACTED]")),
      ...(agent === "opencode" ? [redactedFinal] : []),
    ]);
    const deliverables = events.filter(
      (event) => event.type === "completion" && event.finalOutput !== undefined,
    );
    expect(deliverables).toEqual([
      expect.objectContaining({
        type: "completion",
        taskComplete: true,
        finalOutput: redactedFinal,
      }),
    ]);
    expect(JSON.stringify(deliverables)).not.toContain("Tests are still running");
    expect(JSON.stringify(deliverables)).not.toContain("Inspecting the implementation");
    if (agent === "codex" || agent === "opencode") {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: agent === "codex" ? "usage" : "completion",
          usage: {
            inputTokens: agent === "codex" ? 1 : 3,
            outputTokens: agent === "codex" ? 2 : 6,
            provenance: "measured",
          },
        }),
      );
    }
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("synthetic-gh-token");
    expect([...files.keys()].every((path) => path.startsWith("/tmp/wallie-"))).toBe(true);
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });
});
