import "server-only";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveFactorySelection } from "@/features/factories/factory-selection";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import { listFactoryAgents, listFactoryAgentPromptRevisions } from "@/lib/factory-agents/service";
import { resolveFactoryExecutionProfile } from "@/lib/factory-definitions/execution-profile";
import { factoryWritableRepositoryIds } from "@/lib/factory-definitions/repository-bindings";
import {
  selectCurrentFactoryActivation,
  selectStoredFactoryDefinition,
} from "@/lib/factory-definitions/storage";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";

export async function loadAgentPageScope(workspaceSlug: string, factoryQuery?: string | string[]) {
  const [{ currentMember, supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const selected = resolveFactorySelection(factories, factoryQuery);
  if (selected.kind !== "factory") return null;

  const { factory } = selected;
  const operator = isWorkspaceOperator(currentMember);
  const canEditDefinition = operator && factory.status === "active";
  const membership =
    !operator &&
    factory.status === "active" &&
    currentMember.kind === "human" &&
    currentMember.is_active
      ? await supabase
          .from("factory_members")
          .select("role")
          .eq("workspace_id", workspace.id)
          .eq("factory_id", factory.id)
          .eq("member_id", currentMember.id)
          .is("revoked_at", null)
          .maybeSingle()
      : null;
  if (membership?.error) throw membership.error;

  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    factory,
    supabase,
    canEditDefinition,
    canEditPrompt: canEditDefinition || membership?.data?.role === "manager",
  };
}

type Scope = NonNullable<Awaited<ReturnType<typeof loadAgentPageScope>>>;

async function loadPublishedDefinition({ supabase, workspaceId, factory }: Scope) {
  const { data: activation, error: activationError } = await selectCurrentFactoryActivation(
    supabase,
    workspaceId,
    factory.id,
  );
  if (activationError) throw activationError;
  if (!activation) return null;

  const { data: revision, error } = await selectStoredFactoryDefinition(
    supabase,
    workspaceId,
    factory.id,
    {
      kind: "revision",
      id: activation.revision_id,
    },
  );
  if (error) throw error;
  if (!revision) return null;

  const definition = readVerifiedFactoryDefinition(
    revision.definition_json,
    revision.canonical_digest,
  );
  if (!definition) throw new Error("The saved factory definition is invalid.");
  return { definition, revisionId: revision.id };
}

export async function loadAgentsList(scope: Scope, afterId?: string) {
  const [page, published] = await Promise.all([
    listFactoryAgents(scope.supabase, {
      workspaceId: scope.workspaceId,
      factoryId: scope.factory.id,
      limit: 30,
      afterId,
    }),
    loadPublishedDefinition(scope),
  ]);
  return {
    ...page,
    implementationAgentId: published?.definition.implementationAgent?.agentId ?? null,
  };
}

export async function loadAgentDetail(
  scope: Scope,
  { agentId, revisionId, before }: { agentId: string; revisionId?: string; before?: number },
) {
  const { supabase, workspaceId, factory } = scope;
  const { data: agent, error } = await supabase
    .from("factory_agents")
    .select("id, name, slug, is_default")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factory.id)
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw error;
  if (!agent) return null;

  const agentScope = { workspaceId, factoryId: factory.id, agentId };
  const [page, first, selected, published] = await Promise.all([
    listFactoryAgentPromptRevisions(supabase, {
      ...agentScope,
      limit: 20,
      beforeRevisionNumber: before,
    }),
    before ? listFactoryAgentPromptRevisions(supabase, { ...agentScope, limit: 1 }) : null,
    revisionId
      ? supabase
          .from("factory_agent_prompt_revisions")
          .select("id, agent_id, revision_number, prompt_md, prompt_sha256, created_at")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .eq("agent_id", agentId)
          .eq("id", revisionId)
          .maybeSingle()
      : null,
    loadPublishedDefinition(scope),
  ]);
  if (selected?.error) throw selected.error;
  if (revisionId && !selected?.data) return null;

  const bindings =
    published?.definition.implementationAgent?.agentId === agentId
      ? await loadPublishedAgentBindings(scope, published)
      : null;
  return {
    agent,
    ...page,
    latest: (first ?? page).revisions[0] ?? null,
    selected: selected?.data ?? page.revisions[0] ?? null,
    bindings,
  };
}

async function loadPublishedAgentBindings(
  scope: Scope,
  published: NonNullable<Awaited<ReturnType<typeof loadPublishedDefinition>>>,
) {
  const { supabase, workspaceId, factory } = scope;
  const { definition, revisionId } = published;
  const writes = factoryWritableRepositoryIds(definition);
  const reads = definition.readContextRepositoryIds ?? [];
  const [repositories, skills] = await Promise.all([
    supabase
      .from("github_repositories")
      .select("id, full_name")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .in("id", [...writes, ...reads]),
    definition.skillIds.length
      ? supabase
          .from("factory_skill_revisions")
          .select("id, revision_number, factory_skills!inner(name)")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in("id", definition.skillIds)
      : null,
  ]);
  if (repositories.error) throw repositories.error;
  if (skills?.error) throw skills.error;
  const names = new Map(repositories.data.map((row) => [row.id, row.full_name]));
  return {
    revisionId,
    promptRevisionId: definition.implementationAgent?.promptRevisionId ?? null,
    profile: resolveFactoryExecutionProfile(definition),
    repositories: {
      writable: writes.map((id) => ({ id, name: names.get(id) ?? "Repository unavailable" })),
      context: reads.map((id) => ({ id, name: names.get(id) ?? "Repository unavailable" })),
    },
    skills: (skills?.data ?? []).map((row) => ({
      id: row.id,
      version: row.revision_number,
      name: row.factory_skills.name,
    })),
    tools: (definition.mcpManifest?.servers ?? []).map(
      ({ serverId, serverSlug, revisionNumber, operations }) => ({
        serverId,
        serverSlug,
        revisionNumber,
        operations,
      }),
    ),
  };
}

export type PublishedAgentBindings = Awaited<ReturnType<typeof loadPublishedAgentBindings>>;
