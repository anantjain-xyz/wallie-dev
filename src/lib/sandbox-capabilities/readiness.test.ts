import { describe, expect, it, vi } from "vitest";

import { assertCurrentSandboxCapabilityCheck, SandboxCapabilityCheckStaleError } from "./readiness";
import type { SandboxCapabilityReport } from "./contracts";

const completeCapabilities = Object.fromEntries(
  [
    "git",
    "node",
    "packageManager",
    "agentCli",
    "codexExternalSandbox",
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
    is: (column: string, value: null) => {
      expect([column, value]).toEqual(["factory_definition_digest", null]);
      return builder;
    },
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
  it.each([null, "error"])(
    "scopes pinned capability reuse when the definition-specific result is %s",
    async (status) => {
      const row = {
        agent_model: "gpt-5.5",
        agent_provider: "codex",
        capabilities: completeCapabilities,
        sandbox_connection_revision: connection.revision,
        sandbox_provider: connection.provider,
        status: "success",
      };
      const query = (data: typeof row | null) => {
        const builder = {
          eq: vi.fn(() => builder),
          is: vi.fn(() => builder),
          limit: () => builder,
          maybeSingle: async () => ({ data, error: null }),
          order: () => builder,
          select: () => builder,
        };
        return builder;
      };
      const specific = query(status === null ? null : { ...row, status });
      const compatible = query(row);
      const from = vi.fn().mockReturnValueOnce(specific).mockReturnValueOnce(compatible);
      const check = assertCurrentSandboxCapabilityCheck({
        admin: { from } as never,
        agent: { model: "gpt-5.5", provider: "codex" },
        connection,
        definitionDigest: "pinned-digest",
        repositoryId: "repository-1",
        workspaceId: "workspace-1",
      });
      expect(specific.eq).toHaveBeenCalledWith("factory_definition_digest", "pinned-digest");
      if (status === null) {
        await expect(check).resolves.toBeUndefined();
        expect(compatible.is).toHaveBeenCalledWith("factory_definition_digest", null);
        expect(compatible.eq).toHaveBeenCalledWith("agent_model", "gpt-5.5");
        expect(compatible.eq).toHaveBeenCalledWith(
          "sandbox_connection_revision",
          connection.revision,
        );
      } else {
        await expect(check).rejects.toBeInstanceOf(SandboxCapabilityCheckStaleError);
        expect(from).toHaveBeenCalledTimes(1);
      }
    },
  );

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

  it("rejects a Codex check whose external-sandbox boundary probe failed", async () => {
    await expect(
      assertReady({
        agent_model: "gpt-5.5",
        agent_provider: "codex",
        capabilities: {
          ...completeCapabilities,
          codexExternalSandbox: { detail: "boundary missing", ok: false },
        },
        sandbox_connection_revision: "revision-1",
        sandbox_provider: "e2b",
        status: "success",
      }),
    ).rejects.toBeInstanceOf(SandboxCapabilityCheckStaleError);
  });
});
