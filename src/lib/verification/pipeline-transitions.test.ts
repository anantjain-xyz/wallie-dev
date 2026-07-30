import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { pipelineTransitionBoundaryConfig } from "../../../scripts/pipeline-transition-boundaries.config";
import {
  formatPipelineTransitionDiagnostics,
  loadPipelineTransitionFiles,
  type PipelineTransitionBoundaryConfig,
  type PipelineTransitionFile,
  verifyPipelineTransitions,
} from "../../../scripts/verify-pipeline-transitions";

const fixtureRoot = resolve(process.cwd(), "test/fixtures/pipeline-transitions");

function fixture(path: string): PipelineTransitionFile {
  const sourcePath = resolve(fixtureRoot, `${path}.fixture`);
  return { path, source: readFileSync(sourcePath, "utf8") };
}

function fixtureConfig(
  overrides: Partial<PipelineTransitionBoundaryConfig> = {},
): PipelineTransitionBoundaryConfig {
  return {
    dynamicTableExceptions: [],
    genericStageSourceRoots: [""],
    importPermissions: [],
    mutationOwners: [],
    protectedTables: [
      "agent_jobs",
      "agent_runs",
      "session_artifact_feedback",
      "session_artifacts",
      "session_phase_completions",
      "sessions",
    ],
    recoveryReadOwners: [],
    rpcOwners: [],
    seededStageAdapters: [],
    seededStageLiteralExceptions: [],
    seededStageSlugs: ["build", "land", "plan"],
    sourceRoots: [""],
    sqlFileOwners: [],
    transitionModule: "./transitions",
    ...overrides,
  };
}

describe("pipeline transition boundary verifier", () => {
  it("keeps the production lifecycle graph within exact structural owners", () => {
    expect(
      verifyPipelineTransitions({
        config: pipelineTransitionBoundaryConfig,
        files: loadPipelineTransitionFiles(),
      }),
    ).toEqual([]);
  }, 15_000);

  it("discovers production .mts and .cts modules", () => {
    const projectRoot = mkdtempSync(resolve(tmpdir(), "wallie-pipeline-transitions-"));
    try {
      const sourceRoot = resolve(projectRoot, "src");
      mkdirSync(sourceRoot, { recursive: true });
      mkdirSync(resolve(projectRoot, "supabase/migrations"), { recursive: true });
      writeFileSync(resolve(sourceRoot, "first.mts"), "export const first = true;\n");
      writeFileSync(resolve(sourceRoot, "second.cts"), "export const second = true;\n");

      expect(
        loadPipelineTransitionFiles(projectRoot)
          .map((file) => file.path)
          .sort(),
      ).toEqual(["src/first.mts", "src/second.cts"]);
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("accepts a named cancellation owner and legitimate reaper read path", () => {
    const config = fixtureConfig({
      importPermissions: [
        {
          callers: ["valid/caller.ts"],
          name: "cancelSessionAgentJobs",
        },
      ],
      mutationOwners: [
        {
          callers: ["valid/caller.ts"],
          canonicalApi: "Use cancelSessionAgentJobs().",
          functionName: "cancelSessionAgentJobs",
          operation: "update",
          path: "valid/transitions.ts",
          recovery: "cancellation",
          table: "agent_jobs",
        },
      ],
      recoveryReadOwners: [
        {
          category: "reaper",
          functionName: "loadKnownRuns",
          path: "valid/reaper.ts",
          table: "agent_runs",
        },
      ],
    });

    expect(
      verifyPipelineTransitions({
        config,
        files: [
          fixture("valid/transitions.ts"),
          fixture("valid/caller.ts"),
          fixture("valid/reaper.ts"),
        ],
      }),
    ).toEqual([]);
  });

  it("rejects a direct protected write and points to the transition module", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("direct-write.ts")],
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "pipeline-owner",
      path: "direct-write.ts",
    });
    expect(formatPipelineTransitionDiagnostics(diagnostics)).toContain(
      "Use the canonical API in ./transitions",
    );
  });

  it("protects rejection feedback records as lifecycle state", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("direct-feedback-write.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        path: "direct-feedback-write.ts",
      }),
    ]);
  });

  it("rejects a protected table hidden behind aliases without data-flow interpretation", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("hidden-alias.ts")],
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "dynamic-table-access",
      path: "hidden-alias.ts",
    });
    expect(diagnostics[0]?.message).toContain("fail-closed");
  });

  it("rejects dynamic table access through an aliased database client", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("aliased-client.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "dynamic-table-access",
        path: "aliased-client.ts",
      }),
    ]);
  });

  it("rejects detached Supabase table methods fail-closed", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("detached-from.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "dynamic-table-access",
        path: "detached-from.ts",
      }),
      expect.objectContaining({
        code: "dynamic-table-access",
        path: "detached-from.ts",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("fail-closed");
  });

  it("rejects dynamically named RPC calls fail-closed", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("dynamic-rpc.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "dynamic-rpc-access",
        path: "dynamic-rpc.ts",
      }),
    ]);
  });

  it("rejects detached and indirectly invoked RPC methods fail-closed", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("detached-rpc.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "dynamic-rpc-access",
        path: "detached-rpc.ts",
      }),
      expect.objectContaining({
        code: "dynamic-rpc-access",
        path: "detached-rpc.ts",
      }),
      expect.objectContaining({
        code: "dynamic-rpc-access",
        path: "detached-rpc.ts",
      }),
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.message.includes("fail-closed"))).toBe(
      true,
    );
  });

  it("rejects literal-typed computed Supabase method calls fail-closed", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("computed-client-method.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "dynamic-table-access",
        path: "computed-client-method.ts",
      }),
      expect.objectContaining({
        code: "dynamic-rpc-access",
        path: "computed-client-method.ts",
      }),
    ]);
  });

  it("rejects detached protected table handles before a hidden mutation can occur", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("hidden-handle.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unbound-table-access",
        path: "hidden-handle.ts",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("cannot be aliased or detached");
  });

  it("fails when a declared recovery transition no longer exists", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig({
        mutationOwners: [
          {
            callers: ["unused-caller.ts"],
            canonicalApi: "Use cancelSessionAgentJobs().",
            functionName: "cancelSessionAgentJobs",
            operation: "update",
            path: "unused-recovery.ts",
            recovery: "cancellation",
            table: "agent_jobs",
          },
        ],
      }),
      files: [fixture("unused-recovery.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "recovery-owner-unused",
        path: "unused-recovery.ts",
      }),
    ]);
  });

  it("rejects direct and exported-alias re-exports of imported transition APIs", () => {
    const config = fixtureConfig({
      importPermissions: [
        {
          callers: ["transition-reexport.ts", "transition-export-alias.ts"],
          name: "cancelSessionAgentJobs",
        },
      ],
    });

    const diagnostics = verifyPipelineTransitions({
      config,
      files: [fixture("transition-reexport.ts"), fixture("transition-export-alias.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-export-alias.ts",
      }),
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-reexport.ts",
      }),
    ]);
    expect(
      diagnostics.every((diagnostic) => diagnostic.message.includes("cannot be re-exported")),
    ).toBe(true);
  });

  it("rejects computed dynamic module imports fail-closed", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("computed-import.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "computed-import.ts",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("fail-closed");
  });

  it("normalizes resolvable extensions before checking transition imports", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("extension-import.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "extension-import.ts",
      }),
    ]);
  });

  it("rejects transition APIs embedded in exported aggregate bindings", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig({
        importPermissions: [
          {
            callers: ["transition-export-aggregate.ts", "transition-export-object.ts"],
            name: "cancelSessionAgentJobs",
          },
        ],
      }),
      files: [fixture("transition-export-object.ts"), fixture("transition-export-aggregate.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-export-aggregate.ts",
      }),
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-export-object.ts",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("cannot be re-exported");
  });

  it("allows exported results and wrappers that directly invoke a permitted transition", () => {
    expect(
      verifyPipelineTransitions({
        config: fixtureConfig({
          importPermissions: [
            {
              callers: ["valid/aggregate-caller.ts"],
              name: "cancelSessionAgentJobs",
            },
          ],
        }),
        files: [fixture("valid/aggregate-caller.ts")],
      }),
    ).toEqual([]);
  });

  it("rejects transition values escaping exported function and class bodies", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig({
        importPermissions: [
          {
            callers: ["transition-export-function.ts"],
            name: "cancelSessionAgentJobs",
          },
        ],
      }),
      files: [fixture("transition-export-function.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-export-function.ts",
      }),
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-export-function.ts",
      }),
    ]);
  });

  it("rejects post-declaration mutations of exported transition holders", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig({
        importPermissions: [
          {
            callers: ["transition-export-mutation.ts"],
            name: "cancelSessionAgentJobs",
          },
        ],
      }),
      files: [fixture("transition-export-mutation.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-export-mutation.ts",
      }),
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-export-mutation.ts",
      }),
      expect.objectContaining({
        code: "unauthorized-transition-import",
        path: "transition-export-mutation.ts",
      }),
    ]);
  });

  it("rejects production runtime imports of verifier-skipped test modules", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("bypass.test.ts"), fixture("production-test-import.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "production-test-import",
        path: "production-test-import.ts",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("canonical transition");
  });

  it("does not grant ownership to a same-named nested declaration", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig({
        mutationOwners: [
          {
            callers: ["nested-owner-caller.ts"],
            canonicalApi: "Use cancelSessionAgentJobs().",
            functionName: "cancelSessionAgentJobs",
            operation: "update",
            path: "nested-owner.ts",
            table: "agent_jobs",
          },
        ],
      }),
      files: [fixture("nested-owner.ts")],
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "pipeline-owner",
        path: "nested-owner.ts",
      }),
    );
  });

  it("rejects seeded-stage aliases in generic production code", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("seeded-stage-alias.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "seeded-stage-branch",
        path: "seeded-stage-alias.ts",
      }),
    ]);
  });

  it("rejects seeded-stage identifier property names in generic production code", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("seeded-stage-property.ts")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "seeded-stage-branch",
        path: "seeded-stage-property.ts",
      }),
    ]);
  });

  it("rejects SQL lifecycle writes outside the exact migration allowlist", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("direct-write.sql")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "sql-owner",
        path: "direct-write.sql",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("named transactional RPC");
  });

  it("rejects seeded-stage branches inside SQL functions", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig(),
      files: [fixture("seeded-stage.sql")],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "seeded-stage-branch",
        path: "seeded-stage.sql",
      }),
    ]);
  });

  it("accepts an exact SQL default-stage adapter exception", () => {
    const config = fixtureConfig({
      seededStageLiteralExceptions: [
        {
          functionName: "default_pipeline_stages",
          owner: "pipeline-defaults@example.com",
          path: "valid/default-stage.sql",
          reason: "Defines the workspace default only.",
          value: "build",
        },
      ],
    });

    expect(
      verifyPipelineTransitions({
        config,
        files: [fixture("valid/default-stage.sql")],
      }),
    ).toEqual([]);
  });

  it("rejects a transactional RPC call outside its exact typed wrapper", () => {
    const diagnostics = verifyPipelineTransitions({
      config: fixtureConfig({
        importPermissions: [
          {
            callers: ["valid/rpc-caller.ts"],
            name: "approveSessionStage",
          },
        ],
        rpcOwners: [
          {
            callers: ["valid/rpc-caller.ts"],
            canonicalApi: "Use approveSessionStage().",
            functionName: "approveSessionStage",
            latestMigration: "valid/approve.sql",
            path: "valid/rpc-owner.ts",
            rpc: "approve_session_stage",
          },
        ],
        transitionModule: "./rpc-owner",
      }),
      files: [
        fixture("valid/rpc-owner.ts"),
        fixture("valid/rpc-caller.ts"),
        fixture("valid/approve.sql"),
        fixture("direct-rpc.ts"),
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        path: "direct-rpc.ts",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("Use approveSessionStage()");
  });

  it("recognizes plain CREATE FUNCTION as the effective RPC definition", () => {
    const config = fixtureConfig({
      importPermissions: [
        {
          callers: ["valid/rpc-caller.ts"],
          name: "approveSessionStage",
        },
      ],
      rpcOwners: [
        {
          callers: ["valid/rpc-caller.ts"],
          canonicalApi: "Use approveSessionStage().",
          functionName: "approveSessionStage",
          latestMigration: "valid/approve-plain.sql",
          path: "valid/rpc-owner.ts",
          rpc: "approve_session_stage",
        },
      ],
      transitionModule: "./rpc-owner",
    });

    expect(
      verifyPipelineTransitions({
        config,
        files: [
          fixture("valid/rpc-owner.ts"),
          fixture("valid/rpc-caller.ts"),
          fixture("valid/approve-plain.sql"),
        ],
      }),
    ).toEqual([]);
  });

  it("recognizes a quoted CREATE FUNCTION as the effective RPC definition", () => {
    const config = fixtureConfig({
      importPermissions: [
        {
          callers: ["valid/rpc-caller.ts"],
          name: "approveSessionStage",
        },
      ],
      rpcOwners: [
        {
          callers: ["valid/rpc-caller.ts"],
          canonicalApi: "Use approveSessionStage().",
          functionName: "approveSessionStage",
          latestMigration: "valid/approve-quoted.sql",
          path: "valid/rpc-owner.ts",
          rpc: "approve_session_stage",
        },
      ],
      transitionModule: "./rpc-owner",
    });

    expect(
      verifyPipelineTransitions({
        config,
        files: [
          fixture("valid/rpc-owner.ts"),
          fixture("valid/rpc-caller.ts"),
          fixture("valid/approve-quoted.sql"),
        ],
      }),
    ).toEqual([]);
  });

  it("treats a later DROP FUNCTION as removing the effective RPC owner", () => {
    const config = fixtureConfig({
      importPermissions: [
        {
          callers: ["valid/rpc-caller.ts"],
          name: "approveSessionStage",
        },
      ],
      rpcOwners: [
        {
          callers: ["valid/rpc-caller.ts"],
          canonicalApi: "Use approveSessionStage().",
          functionName: "approveSessionStage",
          latestMigration: "valid/approve.sql",
          path: "valid/rpc-owner.ts",
          rpc: "approve_session_stage",
        },
      ],
      transitionModule: "./rpc-owner",
    });

    const diagnostics = verifyPipelineTransitions({
      config,
      files: [
        fixture("valid/rpc-owner.ts"),
        fixture("valid/rpc-caller.ts"),
        fixture("valid/approve.sql"),
        fixture("valid/drop-approve.sql"),
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "sql-owner",
        path: "valid/drop-approve.sql",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("missing");
    expect(diagnostics[0]?.message).toContain("Use approveSessionStage()");
  });

  it("treats a quoted DROP FUNCTION as removing the effective RPC owner", () => {
    const config = fixtureConfig({
      importPermissions: [
        {
          callers: ["valid/rpc-caller.ts"],
          name: "approveSessionStage",
        },
      ],
      rpcOwners: [
        {
          callers: ["valid/rpc-caller.ts"],
          canonicalApi: "Use approveSessionStage().",
          functionName: "approveSessionStage",
          latestMigration: "valid/approve.sql",
          path: "valid/rpc-owner.ts",
          rpc: "approve_session_stage",
        },
      ],
      transitionModule: "./rpc-owner",
    });

    const diagnostics = verifyPipelineTransitions({
      config,
      files: [
        fixture("valid/rpc-owner.ts"),
        fixture("valid/rpc-caller.ts"),
        fixture("valid/approve.sql"),
        fixture("valid/drop-approve-quoted.sql"),
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "sql-owner",
        path: "valid/drop-approve-quoted.sql",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("missing");
  });

  it("treats a later DROP ROUTINE as removing the effective RPC owner", () => {
    const config = fixtureConfig({
      importPermissions: [
        {
          callers: ["valid/rpc-caller.ts"],
          name: "approveSessionStage",
        },
      ],
      rpcOwners: [
        {
          callers: ["valid/rpc-caller.ts"],
          canonicalApi: "Use approveSessionStage().",
          functionName: "approveSessionStage",
          latestMigration: "valid/approve.sql",
          path: "valid/rpc-owner.ts",
          rpc: "approve_session_stage",
        },
      ],
      transitionModule: "./rpc-owner",
    });

    const diagnostics = verifyPipelineTransitions({
      config,
      files: [
        fixture("valid/rpc-owner.ts"),
        fixture("valid/rpc-caller.ts"),
        fixture("valid/approve.sql"),
        fixture("valid/drop-approve-routine.sql"),
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "sql-owner",
        path: "valid/drop-approve-routine.sql",
      }),
    ]);
    expect(diagnostics[0]?.message).toContain("missing");
  });

  it("accepts an RPC recreated after a DROP FUNCTION in its owning migration", () => {
    const config = fixtureConfig({
      importPermissions: [
        {
          callers: ["valid/rpc-caller.ts"],
          name: "approveSessionStage",
        },
      ],
      rpcOwners: [
        {
          callers: ["valid/rpc-caller.ts"],
          canonicalApi: "Use approveSessionStage().",
          functionName: "approveSessionStage",
          latestMigration: "valid/recreate-approve.sql",
          path: "valid/rpc-owner.ts",
          rpc: "approve_session_stage",
        },
      ],
      transitionModule: "./rpc-owner",
    });

    expect(
      verifyPipelineTransitions({
        config,
        files: [
          fixture("valid/rpc-owner.ts"),
          fixture("valid/rpc-caller.ts"),
          fixture("valid/approve.sql"),
          fixture("valid/recreate-approve.sql"),
        ],
      }),
    ).toEqual([]);
  });
});
