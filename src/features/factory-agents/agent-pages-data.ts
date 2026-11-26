import "server-only";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import {
  listFactoryAgentPromptRevisions,
  searchFactoryAgentDirectory,
} from "@/lib/factory-agents/service";
import { resolveFactoryExecutionProfile } from "@/lib/factory-definitions/execution-profile";
import { factoryWritableRepositoryIds } from "@/lib/factory-definitions/repository-bindings";
import {
  selectCurrentFactoryActivation,
  selectStoredFactoryDefinition,
} from "@/lib/factory-definitions/storage";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";

import { resolveAgentFactory } from "./agent-navigation";

export async function loadAgentPageScope(workspaceSlug: string, factoryQuery?: string | string[]) {
  const [{ currentMember, supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const selected = resolveAgentFactory(factories, factoryQuery);
  if (selected.kind !== "factory") return { factories, selection: selected.kind, scope: null };

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
    factories,
    selection: selected.kind,
    scope: {
      workspaceId: workspace.id,
      factory,
      supabase,
      canEditDefinition,
      canEditPrompt: canEditDefinition || membership?.data?.role === "manager",
    },
  };
}

type Scope = NonNullable<Awaited<ReturnType<typeof loadAgentPageScope>>["scope"]>;
const promptRevisionColumns = "id, agent_id, revision_number, prompt_md, prompt_sha256, created_at";

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
  if (!revision) throw new Error("The published factory definition is unavailable.");

  const definition = readVerifiedFactoryDefinition(
    revision.definition_json,
    revision.canonical_digest,
  );
  if (!definition) throw new Error("The saved factory definition is invalid.");
  return { definition, revisionId: revision.id };
}

export async function loadAgentsList(
  scope: Scope,
  { afterId, search }: { afterId?: string; search?: string },
) {
  const [page, published] = await Promise.all([
    searchFactoryAgentDirectory(scope.supabase, {
      workspaceId: scope.workspaceId,
      factoryId: scope.factory.id,
      limit: 30,
      afterId,
      search,
    }),
    loadPublishedDefinition(scope),
  ]);
  return {
    ...page,
    implementationAgentId: published?.definition.implementationAgent?.agentId ?? null,
    usesFactoryDefault: Boolean(published && !published.definition.implementationAgent),
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
  const scopedRevisions = () =>
    supabase
      .from("factory_agent_prompt_revisions")
      .select(promptRevisionColumns)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .eq("agent_id", agentId);
  const [page, first, requested, published] = await Promise.all([
    listFactoryAgentPromptRevisions(supabase, {
      ...agentScope,
      limit: 20,
      beforeRevisionNumber: before,
    }),
    before ? listFactoryAgentPromptRevisions(supabase, { ...agentScope, limit: 1 }) : null,
    revisionId ? scopedRevisions().eq("id", revisionId).maybeSingle() : null,
    loadPublishedDefinition(scope),
  ]);
  if (requested?.error) throw requested.error;
  if (revisionId && !requested?.data) return null;

  const explicitBinding = published?.definition.implementationAgent;
  const usesFactoryDefault = Boolean(published && !explicitBinding && agent.is_default);
  const isPublishedAgent = explicitBinding?.agentId === agentId || usesFactoryDefault;
  const bound = isPublishedAgent
    ? (requested?.data?.id === explicitBinding?.promptRevisionId && requested?.data) ||
      page.revisions.find((revision) =>
        explicitBinding
          ? revision.id === explicitBinding.promptRevisionId
          : revision.revision_number === 1,
      )
    : null;
  const [bindings, boundOutsidePage] = await Promise.all([
    published && isPublishedAgent ? loadPublishedAgentBindings(scope, published) : null,
    isPublishedAgent && !bound
      ? (explicitBinding
          ? scopedRevisions().eq("id", explicitBinding.promptRevisionId)
          : scopedRevisions().eq("revision_number", 1)
        ).maybeSingle()
      : null,
  ]);
  if (boundOutsidePage?.error) throw boundOutsidePage.error;
  const publishedPrompt = bound || boundOutsidePage?.data || null;
  return {
    agent,
    ...page,
    latest: (first ?? page).revisions[0] ?? null,
    selected: requested?.data ?? (!before ? publishedPrompt : null) ?? page.revisions[0] ?? null,
    hasPublishedDefinition: Boolean(published),
    usesFactoryDefault,
    publishedPrompt,
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
  const toolRefs = definition.mcpManifest?.servers ?? [];
  const profile = resolveFactoryExecutionProfile(definition);
  const authority = profile.credentialAuthority;
  const [repositories, skills, grant, tools] = await Promise.all([
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
    authority.kind === "service"
      ? supabase
          .from("factory_execution_grants")
          .select("version, revoked_at, expires_at, github_repository_id, service_principals(name)")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .eq("id", authority.grantId)
          .maybeSingle()
      : null,
    toolRefs.length
      ? supabase
          .from("factory_mcp_servers")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .in(
            "id",
            toolRefs.map(({ serverId }) => serverId),
          )
      : null,
  ]);
  if (repositories.error) throw repositories.error;
  if (skills?.error) throw skills.error;
  const names = new Map(repositories.data.map((row) => [row.id, row.full_name]));
  const toolNames = new Map(tools?.data?.map((row) => [row.id, row.name]));
  const publishedGrant = grant?.data;
  return {
    revisionId,
    profile,
    grant: publishedGrant
      ? {
          principal: publishedGrant.service_principals?.name ?? null,
          repository: names.get(publishedGrant.github_repository_id) ?? null,
          version: publishedGrant.version,
          status: publishedGrant.revoked_at
            ? "Revoked"
            : Date.parse(publishedGrant.expires_at) <= Date.now()
              ? "Expired"
              : null,
        }
      : null,
    repositories: {
      writable: writes.map((id) => ({ id, name: names.get(id) ?? "Repository unavailable" })),
      context: reads.map((id) => ({ id, name: names.get(id) ?? "Repository unavailable" })),
    },
    skills: (skills?.data ?? []).map((row) => ({
      id: row.id,
      version: row.revision_number,
      name: row.factory_skills.name,
    })),
    tools: toolRefs.map(({ serverId, serverSlug, revisionNumber, operations }) => ({
      serverId,
      serverSlug,
      name: toolNames.get(serverId),
      revisionNumber,
      operations,
    })),
  };
}

export type PublishedAgentBindings = Awaited<ReturnType<typeof loadPublishedAgentBindings>>;
