import Link from "next/link";

import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import type { RunInspectorRoutingDecision } from "@/features/wallie/run-inspector-data";
import type { RunInspectorNames } from "@/features/wallie/run-inspector-names";
import { RunTechnicalDetails } from "@/features/wallie/run-technical-details";
import { RUN_PROVIDER_LABELS } from "@/features/wallie/runs-list-state";
import { routingDecisionReasonLabels } from "@/lib/model-routing/decision-contracts";
import {
  workspaceBenchmarkComparisonPath,
  workspaceBenchmarkSuitePath,
  workspaceFactoryDefinitionPath,
} from "@/lib/routes";

const selectedSourceLabels = {
  primary: "Primary configuration",
  rule_fallback: "Rule fallback",
  unmatched_fallback: "Unmatched-task fallback",
};

export function RunRoutingDecisionInspection({
  canOpenPolicy,
  result,
  workspaceSlug,
  execution,
  names,
}: {
  canOpenPolicy: boolean;
  result: Extract<RunInspectorRoutingDecision, { kind: "recorded" }>;
  workspaceSlug: string;
  execution?: { name: string; provider: string };
  names?: RunInspectorNames;
}) {
  const { decision, factoryId, canManageFactory, taskClassName, benchmarkEvidence, override } =
    result.receipt;
  const selected = decision.disposition === "selected";
  const shadow = decision.mode === "shadow";
  const evidence = canManageFactory ? benchmarkEvidence : null;
  const revisionPath = workspaceFactoryDefinitionPath(workspaceSlug, {
    factory: factoryId,
    revision: decision.policyRevisionId,
  });

  return (
    <PageSection
      anchorId="routing-decision"
      title="Routing decision"
      tagline={
        decision.mode === "active"
          ? "Reviewed routing recorded at admission. The execution profile records what ran."
          : "Shadow evaluation recorded at admission. The execution profile records what ran."
      }
      statusBadge={
        shadow ? (
          <Status label="Shadow only — not applied" value="not_started" />
        ) : override ? (
          <Status label="Override recorded" value="healthy" />
        ) : selected ? (
          <Status label={selectedSourceLabels[decision.source]} value="healthy" />
        ) : (
          <Status label="Escalated" value="needs_attention" />
        )
      }
    >
      <div className="ui-sheet min-w-0 divide-y divide-border">
        <div className="p-4 sm:p-5">
          <MetadataList>
            {execution ? (
              <MetadataItem label="Ran with" value={`${execution.provider} · ${execution.name}`} />
            ) : null}
            {shadow && !selected ? (
              <MetadataItem label="Shadow result" value="Would escalate" />
            ) : null}
            {shadow && selected ? (
              <MetadataItem label="Suggested route" value={selectedSourceLabels[decision.source]} />
            ) : null}
            <MetadataItem label="Task class" value={taskClassName ?? "Unmatched"} />
            <MetadataItem label="Reason" value={routingDecisionReasonLabels[decision.reason]} />
            {decision.initialReason ? (
              <MetadataItem
                label="Fallback reason"
                value={routingDecisionReasonLabels[decision.initialReason]}
              />
            ) : null}
            <MetadataItem
              label="Policy revision"
              value={
                canOpenPolicy && canManageFactory ? (
                  <Link
                    className="underline underline-offset-4"
                    href={revisionPath}
                    prefetch={false}
                  >
                    Open recorded policy revision
                  </Link>
                ) : (
                  "Recorded revision"
                )
              }
            />
          </MetadataList>
        </div>
        {selected ? (
          <div className="space-y-3 p-4 sm:p-5">
            <h3 className="type-label">
              {shadow
                ? "Would select"
                : override
                  ? "Policy recommendation"
                  : "Qualified configuration"}
            </h3>
            <MetadataList>
              <MetadataItem label="Model" value={decision.configuration.modelKey} />
              <MetadataItem
                label="Harness"
                value={
                  RUN_PROVIDER_LABELS[decision.configuration.harness] ??
                  decision.configuration.harness
                }
              />
              <MetadataItem
                label="Worker runtime"
                value={decision.configuration.workerRuntime === "node" ? "Node.js" : "Workerd"}
              />
              <MetadataItem
                label="Implementation agent"
                value={
                  names?.agents[decision.configuration.agentId] ?? "Recorded agent unavailable"
                }
              />
            </MetadataList>
          </div>
        ) : null}
        {override ? (
          <div className="space-y-3 p-4 sm:p-5">
            <h3 className="type-label">One-task override</h3>
            <MetadataList>
              <MetadataItem label="Reason" value={override.reason} />
              <MetadataItem
                label="Override by"
                value={
                  names?.members[override.actorMemberId]?.label ?? "Member details unavailable"
                }
              />
              <MetadataItem label="Selected target" value={selectedSourceLabels[override.target]} />
              <MetadataItem label="Model" value={override.configuration.modelKey} />
              <MetadataItem
                label="Harness"
                value={RUN_PROVIDER_LABELS[override.configuration.harness]}
              />
              <MetadataItem
                label="Worker runtime"
                value={override.configuration.workerRuntime === "node" ? "Node.js" : "Workerd"}
              />
            </MetadataList>
          </div>
        ) : null}
        {selected ? (
          <div className="space-y-3 p-4 sm:p-5">
            <h3 className="type-label">Benchmark justification</h3>
            <MetadataList>
              {evidence ? (
                <>
                  <MetadataItem label="Frozen suite" value={evidence.suite.name} />
                  <MetadataItem label="Scorer" value={evidence.scorerName} />
                  <MetadataItem
                    label="Measured pass rate"
                    value={`${evidence.qualityPassRateBps / 100}%`}
                  />
                  <MetadataItem label="Resolved trials" value={evidence.resolvedTrials} />
                  <MetadataItem
                    label="Measured mean cost"
                    value={`$${evidence.measuredMeanCostUsd}`}
                  />
                  {evidence.p95WallLatencyMs !== null ? (
                    <MetadataItem
                      label="p95 wall latency"
                      value={`${evidence.p95WallLatencyMs} ms`}
                    />
                  ) : null}
                </>
              ) : null}
            </MetadataList>
            {evidence ? (
              <div className="flex flex-wrap gap-2">
                <Link
                  className="ui-button"
                  href={`${workspaceBenchmarkComparisonPath(
                    workspaceSlug,
                    evidence.suite.id,
                    evidence.experimentId,
                    {
                      factory: factoryId,
                      scorerRevisionId: evidence.scorerRevisionId,
                      qualityFloorPercent: evidence.constraints.qualityFloorBps / 100,
                      minResolvedTrials: evidence.constraints.minResolvedTrials,
                      routingCandidateKey: evidence.candidateKey,
                    },
                  )}#frontier-configuration-${evidence.candidateKey}`}
                  prefetch={false}
                >
                  Open exact comparison configuration
                </Link>
                <Link
                  className="ui-button"
                  href={workspaceBenchmarkSuitePath(workspaceSlug, evidence.suite.id, {
                    factory: factoryId,
                    revision: evidence.suite.revisionId,
                  })}
                  prefetch={false}
                >
                  Open frozen suite revision
                </Link>
              </div>
            ) : (
              <p className="type-secondary text-muted">
                {canManageFactory
                  ? "This decision has no retained benchmark proposal receipt."
                  : "Benchmark proposal details require permission to manage this factory."}
              </p>
            )}
          </div>
        ) : null}
        <RunTechnicalDetails
          entries={[
            ["Policy revision ID", decision.policyRevisionId],
            ["Policy digest", decision.policyDigest],
            ["Task class key", decision.taskClassSlug],
            ["Rule ID", decision.ruleId],
            ["Suggested agent ID", selected ? decision.configuration.agentId : null],
            [
              "Definition revision ID",
              selected ? decision.configuration.definitionRevisionId : null,
            ],
            ["Qualification ID", selected ? decision.configuration.qualificationId : null],
            ["Experiment ID", selected ? decision.configuration.experimentId : null],
            ["Candidate key", selected ? decision.benchmarkCandidateKey : null],
            ["Scorer revision ID", selected ? decision.configuration.scorerRevisionId : null],
            ["Override actor ID", override?.actorMemberId],
            ["Override candidate key", override?.benchmarkCandidateKey],
          ]}
        />
      </div>
    </PageSection>
  );
}
