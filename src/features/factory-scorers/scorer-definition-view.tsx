import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import { scorerEvidenceLabels } from "@/features/factory-scorers/scorer-evidence-labels";
import type { FactoryScorerDefinition } from "@/lib/factory-scorers/contracts";

export function ScorerDefinitionView({ definition }: { definition: FactoryScorerDefinition }) {
  const { rubric, scoring, requiredEvidence } = definition;
  const higherIsBetter = scoring.kind === "numeric" && scoring.direction === "higher_is_better";
  return (
    <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
      <MetadataList>
        <MetadataItem
          label="Required evidence"
          value={requiredEvidence.map((kind) => scorerEvidenceLabels[kind]).join(", ")}
        />
        <MetadataItem
          label="Score scale"
          value={scoring.kind === "boolean" ? "Boolean" : "Numeric"}
        />
        {scoring.kind === "boolean" ? (
          <MetadataItem label="Passing value" value={scoring.passValue ? "True" : "False"} />
        ) : (
          <>
            <MetadataItem label="Score range" value={`${scoring.min} to ${scoring.max}`} />
            <MetadataItem
              label="Pass threshold"
              value={`${higherIsBetter ? "At least" : "At most"} ${scoring.passThreshold}`}
            />
            <MetadataItem
              label="Fail threshold"
              value={`${higherIsBetter ? "At most" : "At least"} ${scoring.failThreshold}`}
            />
          </>
        )}
      </MetadataList>
      <div className="space-y-1.5">
        <h3 className="type-label text-foreground">Rubric</h3>
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border bg-control-muted p-3 text-sm text-foreground">
          <code>{rubric}</code>
        </pre>
      </div>
    </div>
  );
}
