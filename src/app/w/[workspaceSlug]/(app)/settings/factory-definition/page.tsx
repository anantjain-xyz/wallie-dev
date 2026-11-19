import { notFound } from "next/navigation";
import { z } from "zod";

import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { FactoryDefinitionEditor } from "@/features/factory-definition/definition-editor";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import { loadFactoryDefinitionRepositories } from "@/lib/factory-definitions/authority";
import { loadFactoryEditorReferenceOptions } from "@/lib/factory-definitions/editor-reference-options";
import { selectFactory } from "@/lib/factory-definitions/storage";

const idSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
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
    factory?: string | string[];
    implementationAgent?: string | string[];
    scorerRevision?: string | string[];
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
  const { factory: factoryQuery, implementationAgent, scorerRevision, ...target } = query;
  const factoryId = idSchema.optional().safeParse(factoryQuery);
  if (!factoryId.success) return <FactoryUnavailable title="Factory definition" />;
  const selection = selectionSchema.safeParse(target);
  const { data: factory, error } = await selectFactory(supabase, workspace.id, factoryId.data);
  if (error) throw error;
  if (!factory) return <FactoryUnavailable title="Factory definition" />;

  const prompt = idSchema.safeParse(implementationAgent);
  const requestedScorer = selection.success ? undefined : idSchema.safeParse(scorerRevision).data;
  const [repositories, referenceOptions, { data: agent, error: agentError }] = await Promise.all([
    loadFactoryDefinitionRepositories(supabase, workspace.id, factory.id),
    loadFactoryEditorReferenceOptions(supabase, workspace.id, factory.id, requestedScorer),
    prompt.success && !selection.success
      ? supabase
          .from("factory_agent_prompt_revisions")
          .select("id, agent_id")
          .eq("workspace_id", workspace.id)
          .eq("factory_id", factory.id)
          .eq("id", prompt.data)
          .maybeSingle()
      : { data: null, error: null },
  ]);
  if (agentError) throw agentError;
  if (implementationAgent !== undefined && !agent && !selection.success) notFound();
  if (
    scorerRevision !== undefined &&
    !selection.success &&
    !referenceOptions.scorers.some(({ id }) => id === requestedScorer)
  ) {
    notFound();
  }

  return (
    <FactoryDefinitionEditor
      key={`${factory.id}:${agent?.id ?? ""}:${requestedScorer ?? ""}`}
      factoryId={factoryId.data}
      factoryName={factory.name}
      initialAgent={agent ? { agentId: agent.agent_id, promptRevisionId: agent.id } : undefined}
      initialScorerRevisionId={requestedScorer}
      referenceOptions={referenceOptions}
      repositories={repositories
        .map(({ id, full_name }) => ({ id, fullName: full_name, isArchived: false }))
        .sort((left, right) => left.fullName.localeCompare(right.fullName))}
      selection={selection.success ? selection.data : null}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
    />
  );
}
