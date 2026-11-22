import Link from "next/link";

import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { routingDraftEvidenceHrefs } from "@/features/factory-definition/routing-draft-evidence";
import type { RoutingCanaryAlert } from "@/lib/model-routing/canary-alert";
import { workspaceFactoryDefinitionPath } from "@/lib/routes";

import { durationLabel, moneyFormat, numberFormat, timeLabel } from "./analytics-view-shared";

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });

const metrics = {
  pass_rate: {
    label: "Scored pass rate",
    format: (value: number) => percent.format(value),
    threshold: (bps: number) =>
      `At least ${numberFormat.format(bps / 100)} percentage points lower`,
  },
  spend: {
    label: "Mean spend per complete session",
    format: (value: number) => moneyFormat.format(value),
    threshold: (bps: number) => `At least ${percent.format(bps / 10_000)} higher`,
  },
  wall_time: {
    label: "Mean attempt wall time per session",
    format: (value: number) => durationLabel(value / 1_000),
    threshold: (bps: number) => `At least ${percent.format(bps / 10_000)} higher`,
  },
} satisfies Record<RoutingCanaryAlert["metric"], unknown>;

export function RoutingCanaryAlertEvidence({
  alert,
  canManageFactory,
  factoryId,
  liveReportHref,
  workspaceSlug,
}: {
  alert: RoutingCanaryAlert;
  canManageFactory?: boolean;
  factoryId: string;
  liveReportHref?: string;
  workspaceSlug: string;
}) {
  const metric = metrics[alert.metric];
  const { canary } = alert.report;
  const evidenceLinks = routingDraftEvidenceHrefs({
    evidence: alert.evidence,
    factoryId,
    workspaceSlug,
  });
  const rollbackHref = canManageFactory
    ? `${workspaceFactoryDefinitionPath(workspaceSlug, {
        factory: factoryId,
        revision: canary.baselineRevisionId,
        activation: canary.baselineActivationNumber,
      })}#revision-history`
    : null;

  return (
    <section
      aria-labelledby="routing-alert-title"
      className="min-w-0 space-y-4 border-b border-border px-4 py-4 sm:px-6"
      id="routing-alert-evidence"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="type-section-title" id="routing-alert-title">
          Retained routing alert evidence
        </h3>
        <Status compact label="Degradation detected" value="needs_attention" />
      </div>
      <p className="type-secondary text-muted">
        This comparison shows the observations used to raise the alert.
      </p>
      <MetadataList className="grid gap-x-6 sm:grid-cols-2">
        <MetadataItem label="Observed" value={timeLabel(alert.observedAt)} />
        <MetadataItem label="Degradation metric" value={metric.label} />
        <MetadataItem
          label="Baseline observation"
          value={`${metric.format(alert.baselineValue)} · ${numberFormat.format(alert.baselineSupport)} supporting sessions`}
        />
        <MetadataItem
          label="Candidate observation"
          value={`${metric.format(alert.candidateValue)} · ${numberFormat.format(alert.candidateSupport)} supporting sessions`}
        />
        <MetadataItem label="Alert threshold" value={metric.threshold(alert.thresholdBps)} />
        <MetadataItem label="Threshold policy" value={`Revision ${alert.thresholdRevision}`} />
        <MetadataItem label="Routing rule" value={alert.ruleId} monospace />
        <MetadataItem
          label="Frozen scorer revision"
          value={alert.evidence.scorerRevisionId}
          monospace
        />
      </MetadataList>
      <div className="space-y-2">
        <h4 className="type-label">Frozen benchmark evidence</h4>
        <p className="type-secondary text-muted">
          {alert.evidence.suite.name} · {alert.evidence.scorerName} ·{" "}
          {alert.evidence.qualityPassRateBps / 100}% passed ·{" "}
          {numberFormat.format(alert.evidence.resolvedTrials)} resolved trials
        </p>
        <div className="flex flex-wrap gap-2">
          <Link className="ui-button" href={evidenceLinks.comparison} prefetch={false}>
            Open exact benchmark configuration
          </Link>
          <Link className="ui-button" href={evidenceLinks.suite} prefetch={false}>
            Open frozen suite revision
          </Link>
        </div>
      </div>
      {rollbackHref || liveReportHref ? (
        <div className="flex flex-wrap gap-2">
          {rollbackHref ? (
            <Link className="ui-button-primary" href={rollbackHref} prefetch={false}>
              Review rollback
            </Link>
          ) : null}
          {liveReportHref ? (
            <Link className="ui-button" href={liveReportHref} prefetch={false}>
              View live canary outcomes
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
