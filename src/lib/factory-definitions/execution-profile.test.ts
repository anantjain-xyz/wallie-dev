import { describe, expect, it } from "vitest";

import { AGENT_PROVIDERS, RECOMMENDED_AGENT_MODELS } from "@/lib/agent-config/contracts";
import { SANDBOX_PROVIDER_IDS } from "@/lib/sandbox/types";

import { resolveFactoryExecutionProfile } from "./execution-profile";

const cursor = { provider: "cursor", model: "auto" } as const;

describe("effective factory execution profile", () => {
  it.each(
    AGENT_PROVIDERS.flatMap((provider) =>
      SANDBOX_PROVIDER_IDS.map((sandboxProvider) => ({ provider, sandboxProvider })),
    ),
  )(
    "keeps $provider and $sandboxProvider and reports only effective options",
    ({ provider, sandboxProvider }) => {
      const model = RECOMMENDED_AGENT_MODELS[provider];
      expect(
        resolveFactoryExecutionProfile(
          { agent: { provider, model, effort: "high", maxTurns: 12 }, sandboxProvider },
          "owner",
        ),
      ).toEqual({
        provider,
        model,
        effort: provider === "codex" || provider === "claude-code" ? "high" : null,
        maxTurns: provider === "claude-code" ? 12 : null,
        sandboxProvider,
        credentialAuthority: { kind: "human", memberId: "owner" },
        unavailableReason: null,
      });
    },
  );

  it("uses the same defaults as the Claude runner", () => {
    expect(
      resolveFactoryExecutionProfile({
        agent: { provider: "claude-code", model: "claude-opus-4-8", effort: null },
        sandboxProvider: "vercel",
      }),
    ).toMatchObject({ effort: "xhigh", maxTurns: 5 });
  });

  it("keeps service authority when the binding is missing", () => {
    const profile = resolveFactoryExecutionProfile(
      {
        agent: { provider: "codex", model: "gpt-5.6-sol" },
        executionGrant: { id: "grant", version: 2 },
        implementationAgent: { agentId: "agent" },
        sandboxProvider: "daytona",
      },
      "human-invoker",
    );
    expect(profile.credentialAuthority).toEqual({
      kind: "service",
      grantId: "grant",
      grantVersion: 2,
      bindingId: null,
      agentId: "agent",
    });
  });

  it("retains a mismatched saved model and explains how to fix it", () => {
    expect(
      resolveFactoryExecutionProfile({
        agent: { provider: "codex", model: "claude-opus-4-8" },
        sandboxProvider: "vercel",
      }),
    ).toMatchObject({
      provider: "codex",
      model: "claude-opus-4-8",
      unavailableReason: "Choose a model supported by the configured agent in Factory Definition.",
    });
  });

  it("reports unavailable Cursor tools while keeping the selected harness and sandbox", () => {
    expect(
      resolveFactoryExecutionProfile({
        agent: cursor,
        sandboxProvider: "e2b",
        mcpManifest: {
          agentId: "agent",
          servers: [
            {
              toolRevisionId: "tool",
              serverId: "server",
              serverSlug: "source",
              revisionNumber: 1,
              endpoint: "https://example.test/mcp",
              operations: ["read"],
              auth: { kind: "none" },
            },
          ],
        },
      }),
    ).toMatchObject({
      provider: "cursor",
      model: "auto",
      sandboxProvider: "e2b",
      unavailableReason: expect.stringContaining("Cursor MCP is unavailable"),
    });
  });
});
