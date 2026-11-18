import { notFound } from "next/navigation";
import { z } from "zod";

import { FactoryDefinitionEditor } from "@/features/factory-definition/definition-editor";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import { loadFactoryDefinitionRepositories } from "@/lib/factory-definitions/authority";
import { selectDefaultFactory } from "@/lib/factory-definitions/storage";

const selectionSchema = z.union([
  z.object({ revision: z.string().uuid(), test: z.string().uuid().optional() }).strict(),
  z.object({ draft: z.string().uuid(), test: z.string().uuid().optional() }).strict(),
]);

export default async function FactoryDefinitionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{
    revision?: string | string[];
    draft?: string | string[];
    test?: string | string[];
  }>;
}) {
  const { workspaceSlug } = await params;
  const [{ currentMember, supabase, workspace }, query] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    searchParams,
  ]);
  if (!isWorkspaceOperator(currentMember)) {
    notFound();
  }
  const selection = selectionSchema.safeParse(query);
  const { data: factory, error } = await selectDefaultFactory(supabase, workspace.id);
  if (error) throw error;
  const repositories = factory
    ? await loadFactoryDefinitionRepositories(supabase, workspace.id, factory.id)
    : [];

  return (
    <FactoryDefinitionEditor
      repositories={repositories
        .map(({ id, full_name }) => ({ id, fullName: full_name, isArchived: false }))
        .sort((left, right) => left.fullName.localeCompare(right.fullName))}
      selection={selection.success ? selection.data : null}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
    />
  );
}
