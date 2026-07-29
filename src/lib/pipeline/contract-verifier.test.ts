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

function fixtureContract(
  overrides: Partial<PipelineTransitionContract> = {},
): PipelineTransitionContract {
  return {
    ...PIPELINE_TRANSITION_CONTRACT,
    ordinaryOwners: [],
    recoveryOwners: [],
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
            functions: ["processPipelineJob"],
            id: "fixture-session-owner",
            path: "src/lib/pipeline/processor.ts",
            tables: ["sessions"],
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
            functions: ["bypassPipelineContract"],
            id: "fixture-session-owner",
            path: "src/lib/pipeline/processor.ts",
            tables: ["sessions"],
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

  it("accepts a declared recovery owner with an active-state guard", () => {
    const contract = fixtureContract({
      recoveryOwners: [
        {
          canonicalApi: "Use cancelSessionWork().",
          category: "cancellation",
          functions: ["cancelSessionWork"],
          id: "fixture-cancellation",
          path: "src/lib/pipeline/cancel.ts",
          tables: ["agent_jobs"],
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
          functions: ["sweepStalledRuns"],
          id: "fixture-stall-owner",
          path: "src/worker/stall-detector.ts",
          tables: ["agent_runs"],
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

  it("keeps the repository inside the declared pipeline transition contract", () => {
    const diagnostics = verifyPipelineContract(loadPipelineContractFiles());

    expect(formatPipelineContractDiagnostics(diagnostics)).toBe("");
  });
});
