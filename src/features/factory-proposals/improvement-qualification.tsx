import "server-only";

import Link from "next/link";

import { PageSection } from "@/components/ui/page-shell";
import { Status, type StatusValue } from "@/components/ui/status";
import { readFactoryImprovementValidation } from "@/lib/factory-proposals/validation-server";
import type { FactoryImprovementValidationReceipt } from "@/lib/factory-proposals/validation-contracts";
import { workspaceBenchmarkComparisonPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import type { loadImprovementScope } from "./improvement-scope";

const states = {
  "not-run": { label: "Not run", value: "not_started" },
  unavailable: { label: "Unavailable", value: "blocked" },
  active: { label: "In progress", value: "running" },
  failed: { label: "Failed", value: "blocked" },
  inconclusive: { label: "Inconclusive", value: "needs_attention" },
  qualified: { label: "Qualified", value: "complete" },
  stale: { label: "Stale", value: "needs_attention" },
} satisfies Record<string, { label: string; value: StatusValue }>;

function improvementQualificationState(receipt: FactoryImprovementValidationReceipt) {
  if (receipt.status !== "inconclusive") return receipt.status;
  return [receipt.targeted, receipt.holdout].some(
    (comparison) =>
      comparison.scheduleState === "active" && comparison.reasons.includes("pending_work"),
  )
    ? "active"
    : "inconclusive";
}

const reasonCopy: readonly [string, string][] = [
  ["stale_proposal", "A newer proposal revision exists."],
  ["stale_base", "The active definition no longer matches the recorded base."],
  ["factory_unavailable", "The factory is no longer active."],
  ["diagnosis_evidence_unavailable", "The source diagnosis evidence is no longer available."],
  ["quality_below_floor", "The candidate did not meet the quality threshold."],
  ["quality_regression", "The candidate exceeded the allowed quality drop."],
  ["cost_regression", "The candidate exceeded the allowed cost increase."],
  ["latency_regression", "The candidate exceeded the allowed latency increase."],
  ["schedule_canceled", "A comparison schedule was canceled."],
  ["insufficient_independent_tasks", "There aren’t enough independent tasks."],
  ["insufficient_coverage", "The comparisons haven’t reached the required coverage."],
  ["no_observed_improvement", "The targeted comparison didn’t show an improvement."],
];

export async function ImprovementQualification({
  scope,
  workspaceSlug,
  proposalId,
  proposalRevisionId,
}: {
  scope: NonNullable<Awaited<ReturnType<typeof loadImprovementScope>>>;
  workspaceSlug: string;
  proposalId: string;
  proposalRevisionId: string;
}) {
  if (!scope.factory.canManage) return null;

  const receipt = await readFactoryImprovementValidation({
    client: createSupabaseAdminClient(),
    workspaceId: scope.workspaceId,
    factoryId: scope.factoryId,
    actorUserId: scope.actorUserId,
    proposalId,
    proposalRevisionId,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  const state = receipt
    ? improvementQualificationState(receipt)
    : receipt === null
      ? "not-run"
      : "unavailable";
  const comparisons = receipt
    ? [
        { label: "Targeted comparison", comparison: receipt.targeted },
        { label: "Held-out comparison", comparison: receipt.holdout },
      ]
    : [];
  const suites = receipt
    ? (
        await scope.supabase
          .from("factory_benchmark_suite_revisions")
          .select("id, suite_id")
          .eq("workspace_id", scope.workspaceId)
          .eq("factory_id", scope.factoryId)
          .in(
            "id",
            comparisons.map(({ comparison }) => comparison.suiteRevisionId),
          )
      ).data
    : null;
  const reason = receipt && reasonCopy.find(([code]) => receipt.reasons.includes(code))?.[1];

  return (
    <PageSection
      anchorId="benchmark-qualification"
      title="Benchmark qualification"
      statusBadge={<Status compact {...states[state]} />}
    >
      <div className="ui-sheet min-w-0 space-y-3 p-4 sm:p-5">
        <p className="type-secondary text-muted">
          {state === "not-run"
            ? "No benchmark comparison was recorded for this revision."
            : state === "unavailable"
              ? "Could not load benchmark qualification. Reload to retry."
              : state === "qualified"
                ? "Both benchmark comparisons met the recorded thresholds."
                : state === "active"
                  ? "Benchmark work is still pending."
                  : (reason ?? "Open the exact comparisons to inspect the recorded evidence.")}
        </p>
        {comparisons.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {comparisons.map(({ label, comparison }) => {
              const suite = suites?.find(({ id }) => id === comparison.suiteRevisionId);
              return (
                <li className="space-y-1" key={label}>
                  {suite ? (
                    <Link
                      className="type-label underline underline-offset-4"
                      href={workspaceBenchmarkComparisonPath(
                        workspaceSlug,
                        suite.suite_id,
                        comparison.experimentId,
                        { factory: scope.factoryId },
                      )}
                      prefetch={false}
                    >
                      {label}
                    </Link>
                  ) : (
                    <p className="type-label">{label} link unavailable</p>
                  )}
                  <p className="type-annotation text-muted tabular-nums">
                    {comparison.resolvedPairs} of {comparison.plannedPairs} pairs resolved
                  </p>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </PageSection>
  );
}
