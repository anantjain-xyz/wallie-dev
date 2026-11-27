import Link from "next/link";
import { isValidElement, type ReactNode } from "react";

import type {
  AnalyticsEvidence as Evidence,
  loadAnalyticsEvidence,
} from "@/features/factory-analytics/analytics-data";
import type { AnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import { type AnalyticsLabels, throughputLabel } from "./analytics-labels";
import {
  type AnalyticsHref,
  dimensionLabels,
  durationLabel,
  evidenceTitles,
  metricPanelIds,
  moneyFormat,
  periodLabels,
  TechnicalDetails,
  timeLabel,
  windowLabel,
} from "@/features/factory-analytics/analytics-view-shared";
import { workspaceRunDetailPath, workspaceSessionDetailPath } from "@/lib/routes";

type Detail = readonly [label: string, value: ReactNode];
type EvidenceRow = {
  key: string;
  sessionId: string;
  runId?: string | null;
  attempt?: number | null;
  runContext?: string;
  title: string;
  details: Detail[];
  extra?: ReactNode;
};
type EvidenceItem<T extends Evidence["metric"]> = Evidence extends infer Page
  ? Page extends Evidence
    ? T extends Page["metric"]
      ? Page["items"][number]
      : never
    : never
  : never;

function sourceId(value: string | null | undefined) {
  return value ? <SourceReference ids={[value]} /> : null;
}

function sourceIds(ids: readonly string[]) {
  return ids.length ? <SourceReference ids={ids} /> : null;
}

function SourceReference({ ids }: { ids: readonly string[] }) {
  return ids.length === 1 ? (
    <code className="break-all font-mono">{ids[0]}</code>
  ) : (
    <ul className="space-y-1">
      {ids.map((id) => (
        <li key={id}>
          <code className="break-all font-mono">{id}</code>
        </li>
      ))}
    </ul>
  );
}

function Details({ values }: { values: readonly Detail[] }) {
  const readable: Detail[] = [];
  const technical: Detail[] = [];
  for (const item of values) {
    if (item[1] == null) continue;
    (isValidElement(item[1]) && item[1].type === SourceReference ? technical : readable).push(item);
  }
  return (
    <>
      {readable.length > 0 && <DetailList values={readable} />}
      {technical.length > 0 && (
        <TechnicalDetails>
          <DetailList values={technical} />
        </TechnicalDetails>
      )}
    </>
  );
}

function DetailList({ values }: { values: readonly Detail[] }) {
  return (
    <dl className="space-y-1">
      {values.map(([label, value]) =>
        value == null ? null : (
          <div
            className="grid gap-x-2 sm:grid-cols-[minmax(8rem,0.45fr)_minmax(0,1fr)]"
            key={label}
          >
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

function RunLink({
  runId,
  attempt,
  stage,
  context,
  workspaceSlug,
}: {
  runId: string;
  attempt?: number | null;
  stage?: string;
  context?: string;
  workspaceSlug: string;
}) {
  const recordedAttempt = attempt != null && attempt > 0 ? attempt : undefined;
  return (
    <Link
      className="break-words underline underline-offset-4"
      href={workspaceRunDetailPath(workspaceSlug, runId, { attempt: recordedAttempt })}
      prefetch={false}
    >
      {["Open run", recordedAttempt ? `attempt ${recordedAttempt}` : null, stage, context]
        .filter(Boolean)
        .join(" · ")}
    </Link>
  );
}

const statusLabels: Record<string, string> = {
  ambiguous: "Ambiguous relationship",
  candidate: "Candidate",
  censored: "Endpoint not observed",
  confirmed: "Confirmed",
  covered: "Covered mature window",
  estimated: "Estimated",
  exact_publication_receipt: "Exact publication receipt",
  immature: "Window still open",
  invalidated: "Invalidated",
  measured: "Measured",
  partial: "Partial coverage",
  pending: "Pending",
  settled_session_window: "Settled session window",
  unavailable: "Unavailable",
  unknown: "Unknown",
  unlinked: "Unlinked",
  unresolved: "Unresolved",
};

function evidenceStatus(status: string) {
  return statusLabels[status] ?? status;
}

function flowRow(
  item: EvidenceItem<"flow">,
  workspaceSlug: string,
  labels: AnalyticsLabels,
): EvidenceRow {
  return {
    key: `${item.sessionId}-${item.phase}-${item.sourceStartedAt}-${item.sourceEndedAt}`,
    sessionId: item.sessionId,
    title: `${item.phase[0]?.toUpperCase()}${item.phase.slice(1)} · ${durationLabel(item.seconds)}`,
    details: [
      ["Phase state", evidenceStatus(item.status)],
      ["Counted from", timeLabel(item.startedAt)],
      ["Counted through", timeLabel(item.endedAt)],
      ["Segment started", timeLabel(item.sourceStartedAt)],
      ["Segment ended", timeLabel(item.sourceEndedAt)],
      ["Observation IDs", sourceIds(item.observationIds)],
    ],
    extra: item.observations && item.observations.length > 0 && (
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">Lifecycle observations</summary>
        <ul className="mt-2 space-y-2">
          {item.observations.map((observation) => (
            <li className="border-t border-border pt-2" key={observation.id}>
              <Details
                values={[
                  ["Event type", observation.eventType],
                  ["Observation ID", sourceId(observation.id)],
                  ["Occurred", timeLabel(observation.occurredAt)],
                  ["Observed", timeLabel(observation.observedAt)],
                  ["Job ID", sourceId(observation.jobId)],
                  [
                    "Run",
                    observation.runId && (
                      <RunLink
                        attempt={observation.attemptCount}
                        context={timeLabel(observation.occurredAt)}
                        runId={observation.runId}
                        stage={labels.runStages.get(observation.runId)}
                        workspaceSlug={workspaceSlug}
                      />
                    ),
                  ],
                  ["Run ID", sourceId(observation.runId)],
                  ["Artifact ID", sourceId(observation.artifactId)],
                ]}
              />
            </li>
          ))}
        </ul>
      </details>
    ),
  };
}

function deliveryRow(item: EvidenceItem<"merge">): EvidenceRow {
  return {
    key: item.sessionId,
    sessionId: item.sessionId,
    title:
      item.seconds === null
        ? evidenceStatus(item.status)
        : `${durationLabel(item.seconds)} · Measured`,
    details: [
      ["Requested", timeLabel(item.requestedAt)],
      ["Request observation", sourceId(item.requestObservationId)],
      ["Delivered", item.deliveredAt && timeLabel(item.deliveredAt)],
      ["Canonical merge ID", sourceId(item.canonicalMergeId)],
      ["Merge observation", sourceId(item.mergeObservationId)],
      ["Deployment ID", sourceId(item.deploymentId)],
      ["Deployment observation", sourceId(item.deploymentObservationId)],
      ["Environment", item.deploymentEnvironment],
    ],
  };
}

function costRow(item: EvidenceItem<"delivery-cost">): EvidenceRow {
  return {
    key: item.runId,
    sessionId: item.sessionId,
    runId: item.runId,
    attempt: item.attemptCount,
    runContext: evidenceStatus(item.runStatus),
    title:
      item.costUsd === null
        ? evidenceStatus(item.costState)
        : `${moneyFormat.format(item.costUsd)} · ${evidenceStatus(item.costState)}`,
    details: [
      ["Attempt", item.attemptCount],
      ["Run status", item.runStatus],
      ["Run started", timeLabel(item.startedAt)],
      ["Run finished", item.finishedAt && timeLabel(item.finishedAt)],
      ["Attribution", evidenceStatus(item.attribution)],
      ["Canonical merge ID", sourceId(item.mergeId)],
      ["Merge observation", sourceId(item.mergeObservationId)],
      ["Candidate merge ID", sourceId(item.candidateMergeId)],
      ["Usage recorded", item.usageRecordedAt && timeLabel(item.usageRecordedAt)],
      ["Usage finalized", item.usageFinalizedAt && timeLabel(item.usageFinalizedAt)],
      ["Estimation revision", item.usageEstimationRevision],
    ],
  };
}

function costMergeRow(item: EvidenceItem<"cost-merges">): EvidenceRow {
  return {
    key: item.mergeId,
    sessionId: item.sessionId,
    title: `PR #${item.pullRequestNumber}`,
    details: [
      ["Provider merge time", timeLabel(item.mergedAt)],
      ["Canonical merge ID", sourceId(item.mergeId)],
      ["Merge observation", sourceId(item.mergeObservationId)],
      ["Merge commit", sourceId(item.mergeCommitSha)],
      ["Repository ID", sourceId(item.repositoryId)],
    ],
  };
}

function throughputRow(
  item: EvidenceItem<"throughput">,
  dimension: AnalyticsQuery["dimension"],
  labels: AnalyticsLabels,
): EvidenceRow {
  const actorKey = item.invokingActorServicePrincipalId
    ? `service:${item.invokingActorServicePrincipalId}`
    : item.invokingActorMemberId
      ? `member:${item.invokingActorMemberId}`
      : null;
  return {
    key: `${item.mergeId}-${item.runId}-${item.attemptCount}`,
    sessionId: item.sessionId,
    runId: item.runId,
    attempt: item.attemptCount,
    title: `PR #${item.pullRequestNumber} · ${throughputLabel(labels.buckets, dimension, item.bucketKey, item.bucketLabel)}`,
    details: [
      ["Provider merge time", timeLabel(item.mergedAt)],
      ["Canonical merge ID", sourceId(item.mergeId)],
      ["Merge observation", sourceId(item.mergeObservationId)],
      ["Repository ID", sourceId(item.repositoryId)],
      ["Attempt", item.attemptCount],
      ["Request source", item.requestSource],
      ["Requested by", actorKey && throughputLabel(labels.buckets, "person", actorKey, "Unknown")],
      ["Request receipt", sourceId(item.requestSourceReceiptId)],
      ["Invoking member", sourceId(item.invokingActorMemberId)],
      ["Invoking service principal", sourceId(item.invokingActorServicePrincipalId)],
      ["Credential owner member", sourceId(item.credentialOwnerMemberId)],
      ["Credential owner service principal", sourceId(item.credentialOwnerServicePrincipalId)],
      ["Budget payer", sourceId(item.budgetPayerMemberId)],
      ["Agent ID", sourceId(item.agentId)],
      ["Agent prompt revision", sourceId(item.agentPromptRevisionId)],
      ["Model", item.modelName],
      ["Harness", item.harness],
      ["Worker runtime", item.workerRuntime],
      [
        "Definition revision",
        item.definitionRevisionId &&
          throughputLabel(labels.buckets, "definition", item.definitionRevisionId, "Unknown"),
      ],
      ["Definition revision ID", sourceId(item.definitionRevisionId)],
      ["Definition digest", sourceId(item.definitionDigest)],
    ],
  };
}

function revertRow(item: EvidenceItem<"revert">): EvidenceRow {
  return {
    key: item.originalMergeId,
    sessionId: item.sessionId,
    title: `PR #${item.pullRequestNumber} · ${evidenceStatus(item.status)}`,
    details: [
      ["Original provider merge", timeLabel(item.originalMergedAt)],
      ["Revert window ends", timeLabel(item.windowEndsAt)],
      ["Original merge ID", sourceId(item.originalMergeId)],
      ["Original merge observation", sourceId(item.originalObservationId)],
      ["Original merge commit", sourceId(item.originalMergeSha)],
      ["Repository ID", sourceId(item.repositoryId)],
      ["Base branch", item.baseBranch],
      ["Complete coverage", item.hasCompleteCoverage ? "Yes" : "No"],
      ["Verified revert", item.hasVerifiedRevert ? "Yes" : "No"],
      ["Unresolved relationships", item.unresolvedRelationshipCount],
      ["Coverage receipt IDs", sourceIds(item.coverageIds)],
      ["Coverage receipts", item.coverageCount],
    ],
    extra: item.relationships.length > 0 && (
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">Revert relationship observations</summary>
        <ul className="mt-2 space-y-2">
          {item.relationships.map((relationship) => (
            <li className="border-t border-border pt-2" key={relationship.observationId}>
              <Details
                values={[
                  ["Revert PR", `#${relationship.revertPrNumber}`],
                  ["Relationship state", evidenceStatus(relationship.status)],
                  ["Evidence state", evidenceStatus(relationship.evidenceState)],
                  ["Observation ID", sourceId(relationship.observationId)],
                  ["Revision", relationship.revision],
                  ["Current relationship", relationship.current ? "Yes" : "No"],
                  [
                    "Original observation at verification",
                    sourceId(relationship.originalObservationId),
                  ],
                  ["Original commit at verification", sourceId(relationship.originalMergeSha)],
                  ["Original merge time at verification", timeLabel(relationship.originalMergedAt)],
                  ["Stale original evidence", relationship.stale ? "Yes" : "No"],
                  ["Revert merge commit", sourceId(relationship.revertMergeSha)],
                  [
                    "Revert merged",
                    relationship.revertMergedAt && timeLabel(relationship.revertMergedAt),
                  ],
                  [
                    "Provider updated",
                    relationship.providerUpdatedAt && timeLabel(relationship.providerUpdatedAt),
                  ],
                  ["Observed", timeLabel(relationship.observedAt)],
                  [
                    "Verified within window",
                    relationship.withinWindow == null
                      ? null
                      : relationship.withinWindow
                        ? "Yes"
                        : "No",
                  ],
                ]}
              />
            </li>
          ))}
        </ul>
        {item.relationshipsTruncated && (
          <p className="mt-2 text-muted">Showing up to 50 relationship observations.</p>
        )}
      </details>
    ),
  };
}

function getRows(
  evidence: Evidence,
  workspaceSlug: string,
  dimension: AnalyticsQuery["dimension"],
  labels: AnalyticsLabels,
) {
  switch (evidence.metric) {
    case "flow":
      return evidence.items.map((item) => flowRow(item, workspaceSlug, labels));
    case "merge":
    case "deployment":
      return evidence.items.map(deliveryRow);
    case "delivery-cost":
    case "operating-cost":
      return evidence.items.map(costRow);
    case "cost-merges":
      return evidence.items.map(costMergeRow);
    case "throughput":
      return evidence.items.map((item) => throughputRow(item, dimension, labels));
    case "revert":
      return evidence.items.map(revertRow);
  }
}

export function AnalyticsEvidence({
  bucketLabel,
  query,
  evidence,
  href,
  labels,
  workspaceSlug,
}: {
  bucketLabel: string | undefined;
  query: AnalyticsQuery;
  evidence: Awaited<ReturnType<typeof loadAnalyticsEvidence>>;
  href: AnalyticsHref;
  labels: AnalyticsLabels;
  workspaceSlug: string;
}) {
  const selection = query.evidence;
  if (!selection) return null;
  const result = evidence?.status === "ready" ? evidence.data : null;
  const rows = result ? getRows(result, workspaceSlug, query.dimension, labels) : [];
  const window = selection.period === "compare" && query.comparison ? query.comparison : query;
  const facet = "facet" in selection ? selection.facet : null;
  const selectedBucket = selection.metric === "throughput" ? selection.bucket : undefined;
  const retainedBucket = result?.metric === "throughput" ? result.items[0] : undefined;
  const bucket = selectedBucket
    ? (bucketLabel ??
      (retainedBucket
        ? throughputLabel(
            labels.buckets,
            query.dimension,
            retainedBucket.bucketKey,
            retainedBucket.bucketLabel,
          )
        : "Selected breakdown no longer available"))
    : null;

  return (
    <section
      aria-labelledby="analytics-evidence-heading"
      className="ui-sheet mb-6 min-w-0 scroll-mt-4"
      id="analytics-evidence"
      tabIndex={-1}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="space-y-1">
          <h2 className="type-section-title" id="analytics-evidence-heading">
            Evidence
          </h2>
          <p className="type-secondary break-words text-muted">
            {evidenceTitles[selection.metric]} · {periodLabels[selection.period]} ·{" "}
            {windowLabel(window)}
            {facet ? ` · ${evidenceStatus(facet)}` : ""}
            {selection.metric === "throughput" ? ` · ${dimensionLabels[query.dimension]}` : ""}
            {bucket ? ` · ${bucket}` : ""}
            {result && "metricRevision" in result ? ` · Revision ${result.metricRevision}` : ""}
          </p>
          {result?.metric === "throughput" && result.rolesVisibility === "redacted" && (
            <p className="type-label text-muted">
              Credential and budget details are restricted to factory managers.
            </p>
          )}
          {selectedBucket && (
            <TechnicalDetails>
              <code className="break-all">{selectedBucket}</code>
            </TechnicalDetails>
          )}
        </div>
        <a
          className="ui-button px-3 py-2 text-sm"
          href={href() + "#" + metricPanelIds[selection.metric]}
        >
          Close evidence
        </a>
      </header>
      {!result || rows.length === 0 ? (
        <p className="type-secondary border-t border-border p-4 text-muted sm:px-6">
          {result ? (
            "No retained facts match this selection."
          ) : (
            <>
              Evidence unavailable.{" "}
              <a className="text-accent underline underline-offset-4" href={href(selection)}>
                Try again
              </a>
            </>
          )}
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <table className="type-secondary w-full text-left">
            <caption className="sr-only">Contributing evidence</caption>
            <thead className="text-muted">
              <tr>
                <th className="w-[27%] px-4 py-3 font-medium sm:px-6" scope="col">
                  Session and run
                </th>
                <th className="px-4 py-3 font-medium sm:px-6" scope="col">
                  Retained fact
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const number = result.sessionNumbers[row.sessionId];
                return (
                  <tr className="border-t border-border align-top" key={row.key}>
                    <th className="px-4 py-3 font-medium sm:px-6" scope="row">
                      {number === undefined ? (
                        "Session details unavailable"
                      ) : (
                        <Link
                          className="underline"
                          href={workspaceSessionDetailPath(workspaceSlug, number)}
                          prefetch={false}
                        >
                          Session #{number}
                        </Link>
                      )}
                      {row.runId && (
                        <div className="mt-1">
                          <RunLink
                            attempt={row.attempt}
                            context={row.runContext}
                            runId={row.runId}
                            stage={labels.runStages.get(row.runId)}
                            workspaceSlug={workspaceSlug}
                          />
                        </div>
                      )}
                    </th>
                    <td className="space-y-2 px-4 py-3 sm:px-6">
                      <p className="break-words font-medium">{row.title}</p>
                      <Details
                        values={[
                          ...row.details,
                          ["Session ID", sourceId(row.sessionId)],
                          ["Run ID", sourceId(row.runId)],
                        ]}
                      />
                      {row.extra}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {result?.nextCursor && (
        <div className="border-t border-border px-4 py-3 sm:px-6">
          <Link
            className="ui-button px-3 py-2 text-sm"
            href={href({ ...selection, cursor: result.nextCursor })}
            prefetch={false}
          >
            Next evidence page
          </Link>
        </div>
      )}
    </section>
  );
}
