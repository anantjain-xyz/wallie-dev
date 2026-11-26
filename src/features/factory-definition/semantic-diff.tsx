import { Status } from "@/components/ui/status";
import type { CompiledFactoryDefinition } from "@/lib/factory-definitions/compiler";
import {
  grantReferenceKey,
  routingConfigurationKey,
  type NamedReference,
  type ReferenceKind,
} from "@/lib/factory-definitions/named-reference-contracts";
import {
  compareFactoryDefinitions,
  type FactoryDiffValue,
  type FactoryFieldDifference,
} from "@/lib/factory-definitions/semantic-diff";
import { cn } from "@/lib/utils";

import { displayedReference, findReference, ReferenceDetails } from "./named-references";

const changeStatuses = {
  added: { value: "approved", label: "Added" },
  changed: { value: "needs_attention", label: "Changed" },
  removed: { value: "archived", label: "Removed" },
} as const;

function DiffValue({ value }: { value: FactoryDiffValue }) {
  if (value === null || value === "") return <span className="text-muted">None</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "string") return value;
  return value.length ? (
    <ul className="space-y-1">
      {value.map((entry, index) => (
        <li key={`${index}:${entry}`}>{entry}</li>
      ))}
    </ul>
  ) : (
    <span className="text-muted">None</span>
  );
}

function FieldChanges({
  changes,
  beforeLabel,
  afterLabel,
  display,
}: {
  changes: readonly FactoryFieldDifference[];
  beforeLabel: string;
  afterLabel: string;
  display?: (label: string, value: FactoryDiffValue, side: number) => FactoryDiffValue;
}) {
  return (
    <ul className="divide-y divide-border">
      {changes.map((change) => (
        <li className="py-3 first:pt-0 last:pb-0" key={change.label}>
          <p className="text-[13px] font-medium text-foreground">
            {change.label === "Approver member IDs" ? "Approvers" : change.label}
          </p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            {[
              { label: beforeLabel, value: change.before },
              { label: afterLabel, value: change.after },
            ].map(({ label, value }, index) => {
              const named = display ? display(change.label, value, index) : value;
              return (
                <div
                  className="min-w-0 rounded-[4px] border border-border bg-sheet p-2.5"
                  key={index}
                >
                  <dt className="text-xs font-medium text-muted">{label}</dt>
                  <dd
                    className={cn(
                      "mt-1 text-xs text-foreground [overflow-wrap:anywhere]",
                      change.multiline && "max-h-52 overflow-y-auto whitespace-pre-wrap font-mono",
                    )}
                    tabIndex={change.multiline ? 0 : undefined}
                  >
                    <DiffValue value={named} />
                  </dd>
                  {named !== value && value !== null ? (
                    <ReferenceDetails
                      value={Array.isArray(value) ? value.join("\n") : String(value)}
                    />
                  ) : null}
                </div>
              );
            })}
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function FactorySemanticDiff({
  before,
  after,
  beforeLabel = "Published",
  afterLabel = "Candidate",
  references,
  repositories,
}: {
  before: CompiledFactoryDefinition | null;
  after: CompiledFactoryDefinition | null;
  beforeLabel?: string;
  afterLabel?: string;
  references?: Partial<Record<ReferenceKind, NamedReference[]>>;
  repositories?: readonly { id: string; fullName: string }[];
}) {
  function display(label: string, value: FactoryDiffValue, side: number): FactoryDiffValue {
    if (value === null || (!references && !repositories)) return value;
    const bundle = side === 0 ? before : after;
    const name = (kind: ReferenceKind, id: string, fallback: string) =>
      displayedReference(findReference(references?.[kind] ?? [], id), fallback);
    const repositoryName = (id: string) =>
      repositories?.find((repo) => repo.id === id)?.fullName ?? "Repository unavailable";
    const prompt = bundle?.implementationAgent;
    const grant = bundle?.executionGrant;
    switch (label) {
      case "Pipeline":
        return name("pipeline", String(value), "Pipeline unavailable");
      case "Execution policy revision":
        return name("executionPolicy", String(value), "Policy revision unavailable");
      case "Delivery policy revision":
        return name("deliveryPolicy", String(value), "Policy revision unavailable");
      case "Agent prompt revision":
      case "Implementation agent":
        return prompt
          ? name(
              "implementationAgent",
              prompt.promptRevisionId,
              "Agent prompt revision unavailable",
            )
          : value;
      case "Default writable repository":
        return repositoryName(String(value));
      case "Other writable repositories":
      case "Read-only context repositories":
        return Array.isArray(value) ? value.map(repositoryName) : value;
      case "Service execution grant":
        return grant
          ? name(
              "grants",
              grantReferenceKey(grant.id, grant.version),
              `Grant unavailable · v${grant.version}`,
            )
          : value;
      case "Service credential binding":
        return "Saved service credential binding";
      case "Approver member IDs":
        return Array.isArray(value)
          ? value.map((id) => name("approvers", id, "Workspace member unavailable"))
          : value;
      case "Skills":
        return Array.isArray(value)
          ? value.map((id) => name("skills", id, "Skill revision unavailable"))
          : value;
      case "Scorers":
        return Array.isArray(value)
          ? value.map((id) => name("scorers", id, "Scorer revision unavailable"))
          : value;
      case "External context documents":
        return (
          bundle?.contextDocuments?.map(({ sourceId, revisionId }) =>
            displayedReference(
              references?.context?.find(
                (option) => option.sourceId === sourceId && option.id === revisionId,
              ),
              "Context revision unavailable",
            ),
          ) ?? value
        );
      case "MCP bindings":
        return (
          bundle?.mcpManifest?.servers.map((server) => {
            const tool = name(
              "tools",
              server.toolRevisionId,
              `${server.serverSlug} · Revision ${server.revisionNumber}`,
            );
            const auth =
              server.auth.kind === "bearer"
                ? name("bindings", server.auth.secretBindingId, "Credential binding unavailable")
                : "No authentication";
            return `${tool} · ${server.operations.join(", ")} · ${auth}`;
          }) ?? value
        );
      case "Model routing policy": {
        const policy = bundle?.modelRouting;
        if (!policy) return value;
        const qualification = (configuration: Parameters<typeof routingConfigurationKey>[0]) =>
          name(
            "routing",
            routingConfigurationKey(configuration),
            `${configuration.modelKey} · Qualification no longer available`,
          );
        const requirements = ({
          qualityFloorBps,
          minResolvedTrials,
          maxMeanCostUsd,
          maxLatencyMs,
          minConfidenceBps,
        }: (typeof policy.rules)[number]["constraints"]) =>
          [
            `quality ≥ ${qualityFloorBps / 100}%`,
            `trials ≥ ${minResolvedTrials}`,
            maxMeanCostUsd === null ? null : `mean cost ≤ $${maxMeanCostUsd}`,
            maxLatencyMs === null ? null : `p95 latency ≤ ${maxLatencyMs} ms`,
            minConfidenceBps === null ? null : `confidence ≥ ${minConfidenceBps / 100}%`,
          ]
            .filter(Boolean)
            .join(", ");
        return [
          ...policy.taskClasses.map(({ name, slug }) => `${name} · ${slug}`),
          ...policy.rules.map(({ taskClassId, configuration, onUnavailable, constraints }) => {
            const task = policy.taskClasses.find(({ id }) => id === taskClassId);
            const fallback =
              onUnavailable.kind === "fallback"
                ? qualification(onUnavailable.configuration)
                : "Escalate";
            return `${task?.name ?? "Rule"}: ${qualification(configuration)} · ${requirements(constraints)} · Fallback: ${fallback}`;
          }),
          `Unmatched tasks: ${policy.onUnmatched.kind === "fallback" ? `${qualification(policy.onUnmatched.configuration)} · ${requirements(policy.onUnmatched.constraints)}` : "Escalate"}`,
        ];
      }
      case "Operating rule stage references":
      case "Previous stage references":
        return Array.isArray(value)
          ? value.map(
              (id) => bundle?.stages.find((stage) => stage.id === id)?.name ?? "Stage unavailable",
            )
          : value;
      default:
        return value;
    }
  }
  return (
    <FactorySemanticDiffComparison
      comparison={after && compareFactoryDefinitions(before, after)}
      beforeLabel={beforeLabel}
      afterLabel={afterLabel}
      display={display}
    />
  );
}

export function FactorySemanticDiffComparison({
  comparison,
  beforeLabel,
  afterLabel,
  display,
}: {
  comparison: ReturnType<typeof compareFactoryDefinitions> | null;
  beforeLabel: string;
  afterLabel: string;
  display?: Parameters<typeof FieldChanges>[0]["display"];
}) {
  const fieldLabels = { beforeLabel, afterLabel, display };

  return (
    <div className="min-w-0 space-y-4">
      {!comparison ? (
        <p className="type-secondary text-muted">Validate a candidate to compare its settings.</p>
      ) : !comparison.fields.length && !comparison.stages.length ? (
        <p className="type-secondary text-muted">These definitions have matching settings.</p>
      ) : (
        <>
          {comparison.fields.length ? (
            <div className="rounded-[6px] border border-border bg-surface px-4 py-3">
              <FieldChanges changes={comparison.fields} {...fieldLabels} />
            </div>
          ) : null}
          {comparison.stages.length ? (
            <ul aria-label="Stage changes" className="space-y-2">
              {comparison.stages.map((stage) => (
                <li
                  className="min-w-0 rounded-[6px] border border-border bg-surface"
                  key={stage.id}
                >
                  <details>
                    <summary className="min-h-11 cursor-pointer px-4 py-3 text-[13px] font-medium text-foreground [overflow-wrap:anywhere]">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span>{stage.name}</span>
                        <Status compact {...changeStatuses[stage.kind]} />
                      </span>
                    </summary>
                    <div className="space-y-3 border-t border-border px-4 py-3">
                      {stage.kind === "changed" ? (
                        stage.orderChanged && (
                          <p className="text-xs text-muted">
                            {stage.beforePosition === stage.afterPosition
                              ? `Relative order changed at position ${stage.afterPosition}.`
                              : `Position ${stage.beforePosition} → ${stage.afterPosition}`}
                          </p>
                        )
                      ) : (
                        <p className="text-xs text-muted">Position {stage.position}</p>
                      )}
                      <FieldChanges changes={stage.fields} {...fieldLabels} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
