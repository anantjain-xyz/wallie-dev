import { describe, expect, it } from "vitest";

import { assertCurrentSandboxCapabilityCheck, SandboxCapabilityCheckStaleError } from "./readiness";
import type { SandboxCapabilityReport } from "./contracts";

const completeCapabilities = Object.fromEntries(
  [
    "git",
    "node",
    "packageManager",
    "agentCli",
    "playwrightPackage",
    "chromium",
    "screenshotSmoke",
  ].map((name) => [name, { detail: "ok", ok: true }]),
) as unknown as SandboxCapabilityReport;

const connection = {
  credentials: { apiKey: "secret" },
  provider: "e2b" as const,
  revision: "revision-1",
};

function adminWith(row: Record<string, unknown> | null) {
  const builder = {
    eq: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: row, error: null }),
    order: () => builder,
    select: () => builder,
  };
  return { from: () => builder };
}

function assertReady(row: Record<string, unknown> | null) {
  return assertCurrentSandboxCapabilityCheck({
    admin: adminWith(row) as never,
    agent: { model: "gpt-5.5", provider: "codex" },
    connection,
    repositoryId: "repository-1",
    workspaceId: "workspace-1",
  });
}

describe("assertCurrentSandboxCapabilityCheck", () => {
  it("accepts a complete check for the exact provider, revision, and agent", async () => {
    await expect(
      assertReady({
        agent_model: "gpt-5.5",
        agent_provider: "codex",
        capabilities: completeCapabilities,
        sandbox_connection_revision: "revision-1",
        sandbox_provider: "e2b",
        status: "success",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a check from another connection revision", async () => {
    await expect(
      assertReady({
        agent_model: "gpt-5.5",
        agent_provider: "codex",
        capabilities: completeCapabilities,
        sandbox_connection_revision: "revision-old",
        sandbox_provider: "e2b",
        status: "success",
      }),
    ).rejects.toMatchObject({ provider: "e2b" });
  });

  it("rejects legacy checks without agent metadata instead of matching every agent", async () => {
    await expect(
      assertReady({
        agent_model: null,
        agent_provider: null,
        capabilities: completeCapabilities,
        sandbox_connection_revision: "revision-1",
        sandbox_provider: "e2b",
        status: "success",
      }),
    ).rejects.toBeInstanceOf(SandboxCapabilityCheckStaleError);
  });

  it("rejects successful rows that do not contain the complete runtime probe", async () => {
    await expect(
      assertReady({
        agent_model: "gpt-5.5",
        agent_provider: "codex",
        capabilities: { git: { detail: "ok", ok: true } },
        sandbox_connection_revision: "revision-1",
        sandbox_provider: "e2b",
        status: "success",
      }),
    ).rejects.toBeInstanceOf(SandboxCapabilityCheckStaleError);
  });
});
