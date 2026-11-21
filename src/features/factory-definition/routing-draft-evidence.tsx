import Link from "next/link";

import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import type { RoutingDraftEvidence } from "@/lib/model-routing/draft-contracts";
import { workspaceBenchmarkComparisonPath, workspaceBenchmarkSuitePath } from "@/lib/routes";

export function RoutingDraftEvidencePanel({
  evidence,
  factoryId,
  workspaceSlug,
}: {
  evidence: RoutingDraftEvidence;
  factoryId?: string;
  workspaceSlug: string;
}) {
  const { suite, constraints } = evidence;
  const comparisonPath = workspaceBenchmarkComparisonPath(
    workspaceSlug,
    suite.id,
    evidence.experimentId,
    {
      factory: factoryId,
      scorerRevisionId: evidence.scorerRevisionId,
      qualityFloorPercent: constraints.qualityFloorBps / 100,
      minResolvedTrials: constraints.minResolvedTrials,
      routingCandidateKey: evidence.candidateKey,
    },
  );
  const suitePath = workspaceBenchmarkSuitePath(workspaceSlug, suite.id, {
    factory: factoryId,
    revision: suite.revisionId,
  });

  return (
    <PageSection anchorId="routing-draft-evidence" title="Routing draft evidence" className="mb-6">
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <p className="type-secondary text-muted">
          {evidence.taskClassName} was proposed using {evidence.scorerName} on the frozen{" "}
          {suite.purpose} suite
          {evidence.isRecommended ? " and met the criteria for recommendation." : "."}
        </p>
        <MetadataList className="flex flex-wrap gap-4">
          <MetadataItem
            label="Measured pass rate"
            value={evidence.qualityPassRateBps / 100 + "%"}
          />
          <MetadataItem label="Quality floor" value={constraints.qualityFloorBps / 100 + "%"} />
          <MetadataItem label="Resolved trials" value={evidence.resolvedTrials} />
          <MetadataItem label="Minimum resolved trials" value={constraints.minResolvedTrials} />
          <MetadataItem label="Measured mean cost" value={"$" + evidence.measuredMeanCostUsd} />
          {constraints.maxMeanCostUsd === null ? null : (
            <MetadataItem label="Mean cost ceiling" value={"$" + constraints.maxMeanCostUsd} />
          )}
          <MetadataItem
            label="p95 wall latency"
            value={
              evidence.p95WallLatencyMs === null ? "Unavailable" : evidence.p95WallLatencyMs + " ms"
            }
          />
          {constraints.maxLatencyMs === null ? null : (
            <MetadataItem
              label="p95 wall latency ceiling"
              value={constraints.maxLatencyMs + " ms"}
            />
          )}
        </MetadataList>
        <div className="flex flex-wrap gap-2">
          <Link
            className="ui-button"
            href={comparisonPath + "#frontier-configuration-" + evidence.candidateKey}
          >
            Open exact comparison configuration
          </Link>
          <Link className="ui-button" href={suitePath}>
            Open frozen suite revision
          </Link>
        </div>
      </div>
    </PageSection>
  );
}
