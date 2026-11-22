import { Status } from "@/components/ui/status";
import type { CompiledFactoryDefinition } from "@/lib/factory-definitions/compiler";
import {
  compareFactoryDefinitions,
  type FactoryDiffValue,
  type FactoryFieldDifference,
} from "@/lib/factory-definitions/semantic-diff";
import { cn } from "@/lib/utils";

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
      {value.map((entry) => (
        <li key={entry}>{entry}</li>
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
}: {
  changes: readonly FactoryFieldDifference[];
  beforeLabel: string;
  afterLabel: string;
}) {
  return (
    <ul className="divide-y divide-border">
      {changes.map((change) => (
        <li className="py-3 first:pt-0 last:pb-0" key={change.label}>
          <p className="text-[13px] font-medium text-foreground">{change.label}</p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            {[
              { label: beforeLabel, value: change.before },
              { label: afterLabel, value: change.after },
            ].map(({ label, value }, index) => (
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
                  <DiffValue value={value} />
                </dd>
              </div>
            ))}
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
}: {
  before: CompiledFactoryDefinition | null;
  after: CompiledFactoryDefinition | null;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  return (
    <FactorySemanticDiffComparison
      comparison={after && compareFactoryDefinitions(before, after)}
      beforeLabel={beforeLabel}
      afterLabel={afterLabel}
    />
  );
}

export function FactorySemanticDiffComparison({
  comparison,
  beforeLabel,
  afterLabel,
}: {
  comparison: ReturnType<typeof compareFactoryDefinitions> | null;
  beforeLabel: string;
  afterLabel: string;
}) {
  const fieldLabels = { beforeLabel, afterLabel };

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
