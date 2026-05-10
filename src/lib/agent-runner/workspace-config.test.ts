import { describe, expect, it } from "vitest";

import { loadWorkspaceAgentConfig } from "@/lib/agent-runner/workspace-config";
import { DEFAULT_AGENT_RUNNER_CONFIG } from "@/lib/agent-runner/types";

type ConfigRow = { key: string; value_json: unknown };

function buildAdmin(rows: ConfigRow[]) {
  return {
    from: (table: string) => {
      if (table !== "workspace_agent_config") {
        throw new Error(`unexpected table: ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            in: async () => ({ data: rows, error: null }),
          }),
        }),
      };
    },
  } as unknown as Parameters<typeof loadWorkspaceAgentConfig>[0];
}

describe("loadWorkspaceAgentConfig", () => {
  it("returns the workspace's configured model and provider", async () => {
    const admin = buildAdmin([
      { key: "agent_model", value_json: "claude-sonnet-4-20250514" },
      { key: "agent_provider", value_json: "claude-code" },
      { key: "max_turns", value_json: 7 },
    ]);

    const config = await loadWorkspaceAgentConfig(admin, "ws-1");

    expect(config).toEqual({
      maxTurns: 7,
      model: "claude-sonnet-4-20250514",
      provider: "claude-code",
    });
  });

  it("falls back to runner defaults when keys are unset", async () => {
    const admin = buildAdmin([]);

    const config = await loadWorkspaceAgentConfig(admin, "ws-1");

    expect(config.model).toBe(DEFAULT_AGENT_RUNNER_CONFIG.model);
    expect(config.provider).toBe(DEFAULT_AGENT_RUNNER_CONFIG.provider);
    expect(config.maxTurns).toBeUndefined();
  });

  it("never returns the legacy 'wallie-control-plane-stub' placeholder", async () => {
    // Regression guard for WAL-3: the stub placeholder must not leak from any
    // unset / mistyped row in workspace_agent_config.
    const admin = buildAdmin([
      { key: "agent_model", value_json: 42 }, // wrong type → should fall back to default
      { key: "agent_provider", value_json: null },
    ]);

    const config = await loadWorkspaceAgentConfig(admin, "ws-1");

    expect(config.model).not.toBe("wallie-control-plane-stub");
    expect(config.model).toBe(DEFAULT_AGENT_RUNNER_CONFIG.model);
  });

  it("normalizes the underscore-aliased provider workspaces persist via the settings UI", async () => {
    const admin = buildAdmin([{ key: "agent_provider", value_json: "claude_code" }]);

    const config = await loadWorkspaceAgentConfig(admin, "ws-1");

    expect(config.provider).toBe("claude-code");
  });

  it("throws a canonical supported-provider message for unknown configured providers", async () => {
    const admin = buildAdmin([{ key: "agent_provider", value_json: "unknown-provider" }]);

    await expect(loadWorkspaceAgentConfig(admin, "ws-1")).rejects.toThrow(
      'Unknown agent provider: "unknown-provider". Supported: codex, claude-code, anthropic-api',
    );
  });
});
