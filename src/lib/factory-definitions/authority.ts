import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { factoryAgentPromptSnapshotSchema } from "@/lib/factory-agents/contracts";
import { factorySkillRevisionIdSchema } from "@/lib/factory-skills/contracts";
import { getSandboxProviderContract } from "@/lib/sandbox/provider-contract";
import { getEnabledSandboxProviders } from "@/lib/sandbox-connections/server";
import type { Database } from "@/lib/supabase/database.types";

import type { CompiledFactoryDefinition } from "./compiler";
import { loadFactoryMcpCatalog, type FactoryMcpCatalogSelection } from "./mcp-catalog";
import type { FactoryDefinitionCatalog } from "./references";

type AdminClient = SupabaseClient<Database>;
type CatalogPage<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

// Supabase caps each response. Policy revision history can outgrow one page
// while older immutable definitions still refer to those revisions.
async function collectCatalogRows<T>(fetchPage: (from: number, to: number) => CatalogPage<T>) {
  const rows: T[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export async function loadFactoryDefinitionRepositories(
  client: Pick<AdminClient, "from">,
  workspaceId: string,
  factoryId: string,
) {
  const [repositories, installation] = await Promise.all([
    collectCatalogRows((from, to) =>
      client
        .from("github_repositories")
        .select("id, full_name, github_installation_id")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("is_archived", false)
        .order("id")
        .range(from, to),
    ),
    client
      .from("github_installations")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("suspended", false)
      .maybeSingle(),
  ]);
  if (installation.error) throw installation.error;
  return repositories.filter(
    ({ github_installation_id }) => github_installation_id === installation.data?.id,
  );
}

export async function loadFactoryDefinitionCatalog(
  admin: AdminClient,
  {
    workspaceId,
    factoryId,
    agentPromptRevisionId,
    skillRevisionIds,
    scorerRevisionIds,
    ...mcpSelection
  }: FactoryMcpCatalogSelection & {
    workspaceId: string;
    factoryId: string;
    agentPromptRevisionId?: string;
    skillRevisionIds?: readonly string[];
    scorerRevisionIds?: readonly string[];
  },
): Promise<FactoryDefinitionCatalog> {
  const [
    pipelines,
    repositories,
    executionPolicies,
    deliveryPolicies,
    approvers,
    agentPrompts,
    skillRevisions,
    scorerRevisions,
    mcpCatalog,
  ] = await Promise.all([
    collectCatalogRows((from, to) =>
      admin
        .from("pipelines")
        .select("id, name")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .order("id")
        .range(from, to),
    ),
    loadFactoryDefinitionRepositories(admin, workspaceId, factoryId),
    collectCatalogRows((from, to) =>
      admin
        .from("execution_policy_revisions")
        .select("id")
        .eq("workspace_id", workspaceId)
        .order("id")
        .range(from, to),
    ),
    collectCatalogRows((from, to) =>
      admin
        .from("delivery_policy_revisions")
        .select("id, pipeline_id")
        .eq("workspace_id", workspaceId)
        .order("id")
        .range(from, to),
    ),
    collectCatalogRows((from, to) =>
      admin
        .from("workspace_members")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("kind", "human")
        .eq("is_active", true)
        .order("id")
        .range(from, to),
    ),
    loadSelectedAgentPromptRevision(admin, workspaceId, factoryId, agentPromptRevisionId),
    loadSelectedSkillRevisions(admin, workspaceId, factoryId, skillRevisionIds ?? []),
    loadSelectedScorerRevisions(admin, workspaceId, factoryId, scorerRevisionIds ?? []),
    loadFactoryMcpCatalog(admin, { workspaceId, factoryId, ...mcpSelection }),
  ]);
  return {
    workspaceId,
    factoryId,
    pipelines: pipelines.map(({ id, name }) => ({ id, workspaceId, aliases: [name] })),
    repositories: repositories.map(({ id, full_name }) => ({
      id,
      workspaceId,
      aliases: [full_name],
    })),
    executionPolicyRevisions: executionPolicies.map(({ id }) => ({ id, workspaceId })),
    deliveryPolicyRevisions: deliveryPolicies.map(({ id, pipeline_id }) => ({
      id,
      workspaceId,
      pipelineId: pipeline_id,
    })),
    approvers: approvers.map(({ id }) => ({ id, workspaceId })),
    agentPromptRevisions: agentPrompts.map(({ id, agent_id, prompt_md, prompt_sha256 }) => ({
      id,
      workspaceId,
      ...factoryAgentPromptSnapshotSchema.parse({
        agentId: agent_id,
        promptRevisionId: id,
        promptMd: prompt_md,
        promptSha256: prompt_sha256,
      }),
    })),
    skills: skillRevisions.map(({ id }) => ({ id, workspaceId })),
    scorerRevisions: scorerRevisions.map(({ id, workspace_id, factory_id }) => ({
      id,
      workspaceId: workspace_id,
      factoryId: factory_id,
    })),
    ...mcpCatalog,
    sandboxProviders: getEnabledSandboxProviders(),
  };
}

async function loadSelectedSkillRevisions(
  admin: AdminClient,
  workspaceId: string,
  factoryId: string,
  references: readonly string[],
) {
  const ids = [
    ...new Set(
      references.flatMap((reference) => {
        const id = factorySkillRevisionIdSchema.safeParse(reference);
        return id.success ? [id.data] : [];
      }),
    ),
  ];
  if (ids.length === 0) return [];
  const { data, error } = await admin
    .from("factory_skill_revisions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .is("revoked_at", null)
    .in("id", ids);
  if (error) throw error;
  return data;
}

async function loadSelectedScorerRevisions(
  admin: AdminClient,
  workspaceId: string,
  factoryId: string,
  revisionIds: readonly string[],
) {
  if (revisionIds.length === 0) return [];
  const { data, error } = await admin
    .from("factory_scorer_revisions")
    .select("id, workspace_id, factory_id")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .in("id", revisionIds);
  if (error) throw error;
  return data;
}

async function loadSelectedAgentPromptRevision(
  admin: AdminClient,
  workspaceId: string,
  factoryId: string,
  revisionId: string | undefined,
) {
  if (!revisionId) return [];
  const { data, error } = await admin
    .from("factory_agent_prompt_revisions")
    .select("id, agent_id, prompt_md, prompt_sha256")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", revisionId)
    .limit(1);
  if (error) throw error;
  return data;
}

export function factoryActivationRequirements(bundle: CompiledFactoryDefinition): {
  enabledSandboxProviders: string[];
  requiredProbes: string[];
} {
  const probes = getSandboxProviderContract(bundle.sandboxProvider).capabilityProbes;
  return {
    enabledSandboxProviders: getEnabledSandboxProviders(),
    requiredProbes: [
      ...new Set([...probes.required, ...probes.requiredByAgent[bundle.agent.provider]]),
    ],
  };
}
