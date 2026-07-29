import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatPipelineContractDiagnostics,
  loadPipelineContractFiles,
  type PipelineTransitionContract,
  PIPELINE_TRANSITION_CONTRACT,
  verifyPipelineContract,
} from "./contract-verifier";

const fixtureDirectory = join(process.cwd(), "src/lib/pipeline/__fixtures__/contract");

function fixture(name: string, path: string) {
  return {
    path,
    source: readFileSync(join(fixtureDirectory, `${name}.ts.fixture`), "utf8"),
  };
}

function sqlFixture(name: string, path: string) {
  return {
    path,
    source: readFileSync(join(fixtureDirectory, `${name}.sql.fixture`), "utf8"),
  };
}

function fixtureContract(
  overrides: Partial<PipelineTransitionContract> = {},
): PipelineTransitionContract {
  return {
    ...PIPELINE_TRANSITION_CONTRACT,
    ordinaryOwners: [],
    recoveryOwners: [],
    sqlMigrationOwners: [],
    sqlOwners: [],
    ...overrides,
  };
}

describe("pipeline contract verifier", () => {
  it("accepts a named owner with an expected-state predicate through table and patch aliases", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("canonical-cas", "src/lib/pipeline/processor.ts")],
      fixtureContract({
        ordinaryOwners: [
          {
            canonicalApi: "Use processPipelineJob().",
            id: "fixture-session-owner",
            path: "src/lib/pipeline/processor.ts",
            transitions: [
              {
                fields: ["phase_status"],
                functionName: "processPipelineJob",
                operation: "update",
                requiredPredicates: [
                  [
                    { field: "archived_at", method: "is", value: null },
                    { field: "phase_status", method: "eq", value: "rejected" },
                  ],
                ],
                table: "sessions",
              },
            ],
          },
        ],
      }),
    );

    expect(diagnostics).toEqual([]);
  });

  it("rejects direct writes outside a named transition owner and points to the canonical API", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("direct-write", "src/features/unsafe-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        path: "src/features/unsafe-transition.ts",
      }),
    ]);
    expect(formatPipelineContractDiagnostics(diagnostics)).toContain(
      "Use processPipelineJob()/handleRejection() or the approve_session_stage transactional RPC.",
    );
  });

  it("rejects an owned ordinary transition without an expected-state predicate", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("direct-write", "src/lib/pipeline/processor.ts")],
      fixtureContract({
        ordinaryOwners: [
          {
            canonicalApi: "Use processPipelineJob().",
            id: "fixture-session-owner",
            path: "src/lib/pipeline/processor.ts",
            transitions: [
              {
                fields: ["phase_status"],
                functionName: "bypassPipelineContract",
                operation: "update",
                requiredPredicates: [
                  [{ field: "phase_status", method: "eq", value: "awaiting_review" }],
                ],
                table: "sessions",
              },
            ],
          },
        ],
      }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-cas",
        message: expect.stringContaining("expected-state predicate"),
      }),
    ]);
  });

  it("finds a write hidden behind table, patch, and query aliases", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("hidden-alias", "src/features/hidden-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics.map((item) => item.code)).toEqual(["pipeline-owner"]);
  });

  it("finds a write invoked through constant element access", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("element-access-mutation", "src/features/hidden-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("approve_session_stage"),
      }),
    ]);
  });

  it("treats an unresolved update payload as a protected write", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("unresolved-payload", "src/features/hidden-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("processPipelineJob"),
      }),
    ]);
  });

  it("protects rejection_count as rejection transition state", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("direct-rejection-count", "src/features/unsafe-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("handleRejection"),
      }),
    ]);
  });

  it("protects the session pipeline pin from direct updates", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("direct-pipeline-pin", "src/features/unsafe-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("approve_session_stage"),
      }),
    ]);
  });

  it("protects job dedupe identity from direct updates", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("direct-dedupe-key", "src/features/unsafe-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("claim_next_agent_job"),
      }),
    ]);
  });

  it("protects persisted sandbox routing metadata from direct updates", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("direct-sandbox-routing", "src/features/unsafe-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("processor run lifecycle helpers"),
      }),
    ]);
  });

  it("protects run ownership links from direct updates", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("direct-run-ownership", "src/features/unsafe-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("processor run lifecycle helpers"),
      }),
    ]);
  });

  it("does not resolve a parameter from an unrelated function's same-name initializer", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("cross-scope-payload", "src/features/hidden-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("processPipelineJob"),
      }),
    ]);
  });

  it("requires every transition-specific expected-state predicate", () => {
    const sessionOwner = PIPELINE_TRANSITION_CONTRACT.ordinaryOwners.find(
      (owner) => owner.id === "pipeline-session-transitions",
    )!;
    const diagnostics = verifyPipelineContract(
      [fixture("incomplete-transition-cas", "src/lib/pipeline/processor.ts")],
      fixtureContract({ ordinaryOwners: [sessionOwner] }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-cas",
        message: expect.stringContaining("phase_status"),
      }),
    ]);
  });

  it.each(["invalid-cas-operator", "invalid-cas-value"])(
    "requires the exact expected-state predicate operator and value: %s",
    (name) => {
      const sessionOwner = PIPELINE_TRANSITION_CONTRACT.ordinaryOwners.find(
        (owner) => owner.id === "pipeline-session-transitions",
      )!;
      const diagnostics = verifyPipelineContract(
        [fixture(name, "src/lib/pipeline/processor.ts")],
        fixtureContract({ ordinaryOwners: [sessionOwner] }),
      );

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "pipeline-cas",
          message: expect.stringContaining('phase_status eq "agent_generating"'),
        }),
      ]);
    },
  );

  it.each(["owner-field-overreach", "owner-operation-overreach"])(
    "rejects a named owner that exceeds its field or operation permission: %s",
    (name) => {
      const sessionOwner = PIPELINE_TRANSITION_CONTRACT.ordinaryOwners.find(
        (owner) => owner.id === "pipeline-session-transitions",
      )!;
      const diagnostics = verifyPipelineContract(
        [fixture(name, "src/lib/pipeline/processor.ts")],
        fixtureContract({ ordinaryOwners: [sessionOwner] }),
      );

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "pipeline-owner",
          message: expect.stringContaining("does not permit"),
        }),
      ]);
    },
  );

  it.each(["conditional-alias-cas", "late-alias-cas"])(
    "rejects a CAS predicate that is not guaranteed before execution: %s",
    (name) => {
      const functionName =
        name === "conditional-alias-cas"
          ? "conditionallyGuardTransition"
          : "guardTransitionAfterExecution";
      const diagnostics = verifyPipelineContract(
        [fixture(name, "src/lib/pipeline/processor.ts")],
        fixtureContract({
          ordinaryOwners: [
            {
              canonicalApi: "Use processPipelineJob().",
              id: "fixture-session-owner",
              path: "src/lib/pipeline/processor.ts",
              transitions: [
                {
                  fields: ["phase_status"],
                  functionName,
                  operation: "update",
                  requiredPredicates: [
                    [{ field: "phase_status", method: "eq", value: "awaiting_review" }],
                  ],
                  table: "sessions",
                },
              ],
            },
          ],
        }),
      );

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "pipeline-cas",
          message: expect.stringContaining("Use processPipelineJob()."),
        }),
      ]);
    },
  );

  it("accepts a named destructive cleanup owner with an expected-state predicate", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("canonical-delete", "src/lib/pipeline/processor.ts")],
      fixtureContract({
        ordinaryOwners: [
          {
            canonicalApi: "Use cleanupQueuedJob().",
            id: "fixture-job-cleanup-owner",
            path: "src/lib/pipeline/processor.ts",
            transitions: [
              {
                fields: [],
                functionName: "cleanupQueuedJob",
                operation: "delete",
                requiredPredicates: [[{ field: "status", method: "eq", value: "queued" }]],
                table: "agent_jobs",
              },
            ],
          },
        ],
      }),
    );

    expect(diagnostics).toEqual([]);
  });

  it("rejects a destructive delete outside a named transition owner", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("direct-delete", "src/features/unsafe-transition.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("claim_next_agent_job"),
      }),
    ]);
  });

  it("accepts a declared recovery owner with an active-state guard", () => {
    const contract = fixtureContract({
      recoveryOwners: [
        {
          canonicalApi: "Use cancelSessionWork().",
          category: "cancellation",
          id: "fixture-cancellation",
          path: "src/lib/pipeline/cancel.ts",
          transitions: [
            {
              fields: ["finished_at", "status"],
              functionName: "cancelSessionWork",
              operation: "update",
              requiredPredicates: [
                [
                  {
                    field: "status",
                    method: "in",
                    value: ["queued", "started", "running"],
                  },
                ],
              ],
              table: "agent_jobs",
            },
          ],
        },
      ],
    });

    expect(
      verifyPipelineContract([fixture("recovery", "src/lib/pipeline/cancel.ts")], contract),
    ).toEqual([]);
  });

  it("fails when a declared recovery exception is unused", () => {
    const diagnostics = verifyPipelineContract([], {
      ...fixtureContract(),
      recoveryOwners: [
        {
          canonicalApi: "Use sweepStalledRuns().",
          category: "stall-detector",
          id: "fixture-stall-owner",
          path: "src/worker/stall-detector.ts",
          transitions: [
            {
              fields: ["finished_at", "status"],
              functionName: "sweepStalledRuns",
              operation: "update",
              requiredPredicates: [
                [
                  {
                    field: "status",
                    method: "in",
                    value: ["queued", "started", "running"],
                  },
                ],
              ],
              table: "agent_runs",
            },
          ],
        },
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "recovery-owner-unused",
        message: expect.stringContaining("sweepStalledRuns"),
      }),
    ]);
  });

  it("rejects seeded-stage branching in generic production code", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("seeded-stage", "src/lib/pipeline/generic-runner.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "seeded-stage-branch",
        path: "src/lib/pipeline/generic-runner.ts",
      }),
    ]);
  });

  it("rejects seeded-stage branching through object and destructured slug aliases", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("seeded-stage-alias", "src/lib/pipeline/generic-runner.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "seeded-stage-branch",
        path: "src/lib/pipeline/generic-runner.ts",
      }),
    ]);
  });

  it("rejects membership-based seeded-stage branching", () => {
    const diagnostics = verifyPipelineContract(
      [fixture("seeded-stage-membership", "src/lib/pipeline/generic-runner.ts")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "seeded-stage-branch",
        path: "src/lib/pipeline/generic-runner.ts",
      }),
    ]);
  });

  it("rejects protected SQL writes outside a named transactional RPC", () => {
    const diagnostics = verifyPipelineContract(
      [
        {
          path: "supabase/migrations/fixture.sql",
          source: `
            create or replace function public.bypass_transition()
            returns void language plpgsql as $$
            begin
              update public.sessions
              set phase_status = 'approved'
              where id = gen_random_uuid();
            end;
            $$;
          `,
        },
      ],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("approve_session_stage"),
      }),
    ]);
  });

  it("rejects protected SQL deletes outside a named transactional RPC", () => {
    const diagnostics = verifyPipelineContract(
      [
        {
          path: "supabase/migrations/fixture.sql",
          source: `
            create or replace function public.bypass_transition()
            returns void language plpgsql as $$
            begin
              delete from public.agent_jobs where status = 'queued';
            end;
            $$;
          `,
        },
      ],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("claim_next_agent_job"),
      }),
    ]);
  });

  it("ignores mutation-looking SQL comments and string literals", () => {
    expect(
      verifyPipelineContract(
        [sqlFixture("sql-comments", "supabase/migrations/fixture.sql")],
        fixtureContract(),
      ),
    ).toEqual([]);
  });

  it("rejects a protected transition hidden in executable dynamic SQL", () => {
    const diagnostics = verifyPipelineContract(
      [sqlFixture("dynamic-sql", "supabase/migrations/fixture.sql")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("approve_session_stage"),
      }),
    ]);
  });

  it("rejects a protected transition held in a PL/pgSQL variable", () => {
    const diagnostics = verifyPipelineContract(
      [sqlFixture("dynamic-sql-variable", "supabase/migrations/fixture.sql")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("approve_session_stage"),
      }),
    ]);
  });

  it("rejects a protected variable-held transition with EXECUTE INTO/USING clauses", () => {
    const diagnostics = verifyPipelineContract(
      [sqlFixture("dynamic-sql-variable-suffix", "supabase/migrations/fixture.sql")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("approve_session_stage"),
      }),
    ]);
  });

  it("rejects a columnless insert into a protected lifecycle table", () => {
    const diagnostics = verifyPipelineContract(
      [sqlFixture("columnless-insert", "supabase/migrations/fixture.sql")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("claim_next_agent_job"),
      }),
    ]);
  });

  it("rejects protected fields written through a SQL tuple assignment", () => {
    const diagnostics = verifyPipelineContract(
      [sqlFixture("tuple-update", "supabase/migrations/fixture.sql")],
      fixtureContract(),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("approve_session_stage"),
      }),
    ]);
  });

  it("rejects every protected lifecycle action in a SQL MERGE", () => {
    const diagnostics = verifyPipelineContract(
      [sqlFixture("merge-actions", "supabase/migrations/fixture.sql")],
      fixtureContract({
        sqlOwners: [
          {
            canonicalApi: "Use a canonical transition RPC.",
            functionName: "public.bypass_transition",
            id: "fixture-merge-owner",
            signature: "public.bypass_transition()",
            transitions: [],
          },
        ],
      }),
    );

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map((item) => item.code)).toEqual([
      "pipeline-owner",
      "pipeline-owner",
      "pipeline-owner",
    ]);
    expect(diagnostics.map((item) => item.message).join("\n")).toContain("update");
    expect(diagnostics.map((item) => item.message).join("\n")).toContain("delete");
    expect(diagnostics.map((item) => item.message).join("\n")).toContain("insert");
  });

  it("rejects a transactional SQL owner missing its exact expected-state predicates", () => {
    const approvalOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
      (owner) => owner.id === "stage-approval-rpc",
    )!;
    const diagnostics = verifyPipelineContract(
      [sqlFixture("sql-owner-missing-cas", "supabase/migrations/fixture.sql")],
      fixtureContract({ sqlOwners: [approvalOwner] }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-cas",
        message: expect.stringContaining("phase_status"),
      }),
    ]);
  });

  it("requires SQL CAS predicates to constrain the mutation conjunctively", () => {
    const approvalOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
      (owner) => owner.id === "stage-approval-rpc",
    )!;
    const diagnostics = verifyPipelineContract(
      [sqlFixture("sql-owner-disjunctive-cas", "supabase/migrations/fixture.sql")],
      fixtureContract({ sqlOwners: [approvalOwner] }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-cas",
        message: expect.stringContaining("phase_status"),
      }),
    ]);
  });

  it("requires SQL CAS predicates to constrain the mutation target rather than a FROM alias", () => {
    const approvalOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
      (owner) => owner.id === "stage-approval-rpc",
    )!;
    const diagnostics = verifyPipelineContract(
      [sqlFixture("sql-owner-foreign-qualifier", "supabase/migrations/fixture.sql")],
      fixtureContract({ sqlOwners: [approvalOwner] }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-cas",
        message: expect.stringContaining("phase_status"),
      }),
    ]);
  });

  it("does not credit predicates from a SET scalar subquery as the UPDATE outer CAS", () => {
    const approvalOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
      (owner) => owner.id === "stage-approval-rpc",
    )!;
    const diagnostics = verifyPipelineContract(
      [sqlFixture("sql-owner-subquery-where", "supabase/migrations/fixture.sql")],
      fixtureContract({ sqlOwners: [approvalOwner] }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-cas",
        message: expect.stringContaining("phase_status"),
      }),
    ]);
  });

  it("enforces SQL CAS on the effective latest RPC redefinition", () => {
    const approvalOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
      (owner) => owner.id === "stage-approval-rpc",
    )!;
    const diagnostics = verifyPipelineContract(
      [
        sqlFixture("sql-owner-latest-safe", "supabase/migrations/20260722000000_approval.sql"),
        sqlFixture(
          "sql-owner-latest-unsafe",
          "supabase/migrations/20260801000000_redefine_approval.sql",
        ),
      ],
      fixtureContract({ sqlOwners: [approvalOwner] }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-cas",
        path: "supabase/migrations/20260801000000_redefine_approval.sql",
      }),
    ]);
  });

  it("tracks the effective SQL owner definition by full function signature", () => {
    const approvalOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
      (owner) => owner.id === "stage-approval-rpc",
    )!;
    const diagnostics = verifyPipelineContract(
      [
        sqlFixture(
          "sql-owner-latest-unsafe",
          "supabase/migrations/20260801000000_redefine_approval.sql",
        ),
        sqlFixture(
          "sql-owner-unrelated-overload",
          "supabase/migrations/20260802000000_unrelated_overload.sql",
        ),
      ],
      fixtureContract({ sqlOwners: [approvalOwner] }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-cas",
        path: "supabase/migrations/20260801000000_redefine_approval.sql",
      }),
    ]);
  });

  it("treats ON CONFLICT DO UPDATE as its own protected mutation", () => {
    const createOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
      (owner) => owner.id === "session-create-rpc",
    )!;
    const diagnostics = verifyPipelineContract(
      [sqlFixture("owned-insert-conflict-update", "supabase/migrations/fixture.sql")],
      fixtureContract({ sqlOwners: [createOwner] }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "pipeline-owner",
        message: expect.stringContaining("does not permit update sessions"),
      }),
    ]);
  });

  it.each(["sql-owner-dependent-before-claim", "sql-owner-dependent-without-gate"])(
    "requires a guarded approval claim to dominate dependent writes: %s",
    (name) => {
      const approvalOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
        (owner) => owner.id === "stage-approval-rpc",
      )!;
      const diagnostics = verifyPipelineContract(
        [sqlFixture(name, "supabase/migrations/fixture.sql")],
        fixtureContract({ sqlOwners: [approvalOwner] }),
      );

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "pipeline-cas",
          message: expect.stringContaining("dominating transition"),
        }),
      ]);
    },
  );

  it("accepts executable SQL when its transactional RPC owns the exact mutation", () => {
    const approvalOwner = PIPELINE_TRANSITION_CONTRACT.sqlOwners.find(
      (owner) => owner.id === "stage-approval-rpc",
    )!;

    expect(
      verifyPipelineContract(
        [sqlFixture("owned-dynamic-sql", "supabase/migrations/fixture.sql")],
        fixtureContract({ sqlOwners: [approvalOwner] }),
      ),
    ).toEqual([]);
  });

  it("keeps the repository inside the declared pipeline transition contract", () => {
    const diagnostics = verifyPipelineContract(loadPipelineContractFiles());

    expect(formatPipelineContractDiagnostics(diagnostics)).toBe("");
  });
});
