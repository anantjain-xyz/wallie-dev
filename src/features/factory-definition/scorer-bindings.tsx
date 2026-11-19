import Link from "next/link";

import { PageSection } from "@/components/ui/page-shell";
import type { FactoryEditorContent } from "@/lib/factory-definitions/editor-contracts";
import type { FactoryEditorScorerReferenceOption } from "@/lib/factory-definitions/editor-reference-options";
import { FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION } from "@/lib/factory-definitions/schema";
import { workspaceScorersPath } from "@/lib/routes";

export function FactoryScorerBindings({
  definitions,
  factoryId,
  options,
  workspaceSlug,
}: {
  definitions: { label: string; content: FactoryEditorContent | null }[];
  factoryId?: string;
  options: readonly FactoryEditorScorerReferenceOption[];
  workspaceSlug: string;
}) {
  const rows = definitions.flatMap(({ label, content }) => {
    if (!content) return [];
    const { bundle } = content;
    return [
      {
        label,
        ids:
          bundle.schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
            ? bundle.scorerRevisionIds
            : [],
      },
    ];
  });
  if (!rows.some(({ ids }) => ids.length > 0)) return null;
  const labels = new Map(options.map(({ id, label }) => [id, label]));
  return (
    <PageSection anchorId="scorer-bindings" title="Scorer bindings">
      <dl className="ui-sheet divide-y divide-border">
        {rows.map(({ label, ids }) => (
          <div className="space-y-1.5 p-4" key={label}>
            <dt className="type-annotation text-muted">{label}</dt>
            <dd className="min-w-0 text-sm">
              {ids.length ? (
                <ul className="space-y-1">
                  {ids.map((id) => (
                    <li className="break-all" key={id}>
                      <Link
                        className="text-accent underline underline-offset-2"
                        href={workspaceScorersPath(workspaceSlug, {
                          factory: factoryId,
                          revision: id,
                        })}
                      >
                        {labels.get(id) ?? id}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                "None"
              )}
            </dd>
          </div>
        ))}
      </dl>
    </PageSection>
  );
}
