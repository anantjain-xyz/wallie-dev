import { notFound } from "next/navigation";
import { z } from "zod";

import { FactoryDefinitionEditor } from "@/features/factory-definition/definition-editor";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

const selectionSchema = z.union([
  z.object({ revision: z.string().uuid() }).strict(),
  z.object({ draft: z.string().uuid() }).strict(),
]);

export default async function FactoryDefinitionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ revision?: string | string[]; draft?: string | string[] }>;
}) {
  const { workspaceSlug } = await params;
  const [{ currentMember, supabase, workspace }, query] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    searchParams,
  ]);
  if (
    currentMember.kind !== "human" ||
    !currentMember.is_active ||
    (currentMember.role !== "owner" && currentMember.role !== "admin")
  ) {
    notFound();
  }
  const selection = selectionSchema.safeParse(query);
  const { data: repositories, error } = await supabase
    .from("github_repositories")
    .select("id,full_name,is_archived")
    .eq("workspace_id", workspace.id)
    .order("id");
  if (error) throw error;

  return (
    <FactoryDefinitionEditor
      repositories={repositories.map((repository) => ({
        id: repository.id,
        fullName: repository.full_name,
        isArchived: repository.is_archived,
      }))}
      selection={selection.success ? selection.data : null}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
    />
  );
}
