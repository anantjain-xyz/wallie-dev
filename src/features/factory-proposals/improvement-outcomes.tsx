import "server-only";

import Link from "next/link";
import type { ReactNode } from "react";

import { PageSection } from "@/components/ui/page-shell";
import { Status, type StatusValue } from "@/components/ui/status";
import { moneyFormat, numberFormat } from "@/features/factory-analytics/analytics-view-shared";
import type { loadImprovementScope } from "@/features/factory-proposals/improvement-scope";
import { ImprovementTime } from "@/features/factory-proposals/improvement-status";
import type { FactoryImprovementAdoption } from "@/lib/factory-proposals/adoption-contracts";
import type { FactoryImprovementOutcomes } from "@/lib/factory-proposals/outcome-contracts";
import { readFactoryImprovementOutcomes } from "@/lib/factory-proposals/outcome-server";
import { workspaceFactoryDefinitionPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Scope = NonNullable<Awaited<ReturnType<typeof loadImprovementScope>>>;
type Cohort = FactoryImprovementOutcomes["baseline"];
type Metric = { label: string; value: (cohort: Cohort) => ReactNode };

const statusLabels = {
  observed: { value: "complete", label: "Observed" },
  degraded: { value: "needs_attention", label: "Degradation observed" },
  inconclusive: { value: "blocked", label: "Inconclusive" },
} satisfies Record<FactoryImprovementOutcomes["status"], { value: StatusValue; label: string }>;

const spendLabels = {
  no_attempts: "No attempts",
  unavailable: "Unavailable",
  partial: "Partial",
  estimated: "Includes estimates",
  measured: "Measured",
} satisfies Record<Cohort["spend"]["state"], string>;

const percentage = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2,
});
const percent = (bps: number) => percentage.format(bps / 10_000);
const count = (value: number) => numberFormat.format(value);

function CohortSpend({ spend }: { spend: Cohort["spend"] }) {
  return (
    <>
      <p>
        {spend.knownUsd === null ? spendLabels[spend.state] : moneyFormat.format(spend.knownUsd)}
      </p>
      {spend.knownUsd !== null ? (
        <p className="type-annotation mt-1 text-muted">{spendLabels[spend.state]}</p>
      ) : null}
      {spend.state !== "no_attempts" ? (
        <ul className="type-annotation mt-1 text-muted" aria-label="Spend coverage">
          <li>{count(spend.measuredAttempts)} measured</li>
          <li>{count(spend.estimatedAttempts)} estimated</li>
          <li>{count(spend.unavailableAttempts)} unavailable</li>
          <li>{count(spend.pendingAttempts)} pending</li>
        </ul>
      ) : null}
    </>
  );
}

const metrics: Metric[] = [
  { label: "Admitted sessions", value: (cohort) => count(cohort.admittedSessions) },
  { label: "Started sessions", value: (cohort) => count(cohort.startedSessions) },
  { label: "Approved", value: (cohort) => count(cohort.approvedSessions) },
  { label: "Execution exhausted", value: (cohort) => count(cohort.exhaustedSessions) },
  { label: "Unresolved", value: (cohort) => count(cohort.unresolvedSessions) },
  { label: "Sessions with verified merge", value: (cohort) => count(cohort.verifiedMerges) },
  {
    label: "Approval rate",
    value: (cohort) =>
      cohort.approvalRateBps === null ? "Unavailable" : percent(cohort.approvalRateBps),
  },
  {
    label: "Approval limits",
    value: ({ approvalLimitsBps }) =>
      approvalLimitsBps
        ? `${percent(approvalLimitsBps.lower)}–${percent(approvalLimitsBps.upper)}`
        : "Unavailable",
  },
  { label: "Known run spend", value: ({ spend }) => <CohortSpend spend={spend} /> },
];

export async function ImprovementOutcomes({
  scope,
  workspaceSlug,
  adoption,
}: {
  scope: Scope;
  workspaceSlug: string;
  adoption: FactoryImprovementAdoption;
}) {
  const outcomes = await readFactoryImprovementOutcomes({
    client: createSupabaseAdminClient(),
    workspaceId: scope.workspaceId,
    factoryId: scope.factoryId,
    actorUserId: scope.actorUserId,
    proposalId: adoption.proposalId,
    proposalRevisionId: adoption.proposalRevisionId,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!outcomes || outcomes.adoptionId !== adoption.id) {
    return (
      <PageSection anchorId="outcomes" title="Production outcomes">
        <p className="ui-sheet type-secondary p-4 text-muted sm:p-5">
          Production observations are unavailable. Reload to retry.
        </p>
      </PageSection>
    );
  }

  const { baseline, candidate, restore, reasons } = outcomes;
  const rollbackPath = workspaceFactoryDefinitionPath(workspaceSlug, {
    factory: scope.factoryId,
    revision: baseline.revisionId,
    activation: baseline.activationNumber,
    restoreFrom: candidate.activationNumber,
  });

  return (
    <PageSection
      anchorId="outcomes"
      title="Production outcomes"
      statusBadge={<Status compact {...statusLabels[outcomes.status]} />}
    >
      <div className="ui-sheet min-w-0">
        <div className="space-y-1 px-4 py-3 sm:px-5">
          <p className="type-secondary text-muted">
            Observed through <ImprovementTime instant={outcomes.observedAt} />
          </p>
          {reasons.includes("insufficient_completed_sessions") ? (
            <p className="type-secondary text-muted">
              At least {count(outcomes.minimumCompleted)} completed sessions in each cohort are
              needed to assess degradation.
            </p>
          ) : null}
          {reasons.includes("incomplete_outcome_coverage") ? (
            <p className="type-secondary text-muted">Outcome coverage is incomplete.</p>
          ) : null}
        </div>
        <table className="w-full table-fixed border-y border-border text-left">
          <caption className="sr-only">Production cohort comparison by admission</caption>
          <thead>
            <tr className="border-b border-border bg-surface">
              <th scope="col" className="type-annotation w-[38%] px-3 py-2 text-muted sm:px-5">
                Outcomes
              </th>
              <th scope="col" className="type-label px-2 py-2 align-top sm:px-5">
                Baseline
                <span className="type-annotation block font-normal text-muted">
                  Activation #{baseline.activationNumber}
                </span>
              </th>
              <th scope="col" className="type-label px-2 py-2 align-top sm:px-5">
                Adopted
                <span className="type-annotation block font-normal text-muted">
                  Activation #{candidate.activationNumber}
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {metrics.map(({ label, value }) => (
              <tr key={label}>
                <th scope="row" className="type-secondary px-3 py-2 align-top font-medium sm:px-5">
                  {label}
                </th>
                <td className="type-secondary px-2 py-2 align-top tabular-nums [overflow-wrap:anywhere] sm:px-5">
                  {value(baseline)}
                </td>
                <td className="type-secondary px-2 py-2 align-top tabular-nums [overflow-wrap:anywhere] sm:px-5">
                  {value(candidate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-3 px-4 py-3 sm:px-5">
          <p className="type-secondary text-muted">
            Approval limits account for unresolved admissions.
          </p>
          {restore.receipt ? (
            <div className="space-y-1 border-t border-border pt-3">
              <Status compact value="complete" label="Baseline restored" />
              <p className="type-secondary">
                Activation #{restore.receipt.activationNumber} restored baseline activation #
                {restore.receipt.targetActivationNumber} for new sessions.
              </p>
              <ImprovementTime instant={restore.receipt.createdAt} />
            </div>
          ) : restore.eligible && scope.workspaceOperator ? (
            <Link className="ui-button" href={`${rollbackPath}#candidate-tests`} prefetch={false}>
              Review rollback
            </Link>
          ) : null}
        </div>
      </div>
    </PageSection>
  );
}
