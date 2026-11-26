import {
  contextDocumentReferenceSchema,
  type ContextDocumentReference,
} from "@/lib/factory-context/contracts";
import { workspaceFactoryDefinitionPath } from "@/lib/routes";

export const factoryContextHandoffKeys = ["contextSource", "contextRevision"] as const;
export type FactoryContextHandoffQuery = Partial<
  Record<(typeof factoryContextHandoffKeys)[number], string | string[]>
>;

export function parseFactoryContextHandoff({
  contextSource,
  contextRevision,
}: FactoryContextHandoffQuery) {
  return contextDocumentReferenceSchema.safeParse({
    sourceId: contextSource,
    revisionId: contextRevision,
  });
}

export function factoryContextPinHref(
  workspaceSlug: string,
  factoryId: string,
  reference: ContextDocumentReference,
) {
  return `${workspaceFactoryDefinitionPath(workspaceSlug, { factory: factoryId })}&${new URLSearchParams(
    {
      contextSource: reference.sourceId,
      contextRevision: reference.revisionId,
    },
  )}#definition-context-documents`;
}
