import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSandboxProviderContract } from "@/lib/sandbox/provider-contract";
import { getEnabledSandboxProviders } from "@/lib/sandbox-connections/server";
import type { Database } from "@/lib/supabase/database.types";

import type { CompiledFactoryDefinition } from "./compiler";
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

export async function loadFactoryDefinitionCatalog(
  admin: AdminClient,
  { workspaceId, factoryId }: { workspaceId: string; factoryId: string },
): Promise<FactoryDefinitionCatalog> {
  const [pipelines, repositories, installation, executionPolicies, deliveryPolicies, approvers] =
    await Promise.all([
      collectCatalogRows((from, to) =>
        admin
          .from("pipelines")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .order("id")
          .range(from, to),
      ),
      collectCatalogRows((from, to) =>
        admin
          .from("github_repositories")
          .select("id, full_name, github_installation_id")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("is_archived", false)
          .order("id")
          .range(from, to),
      ),
      admin
        .from("github_installations")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("suspended", false)
        .maybeSingle(),
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
    ]);
  if (installation.error) throw installation.error;

  return {
    workspaceId,
    pipelines: pipelines.map(({ id, name }) => ({ id, workspaceId, aliases: [name] })),
    repositories: repositories
      .filter(({ github_installation_id }) => github_installation_id === installation.data?.id)
      .map(({ id, full_name }) => ({ id, workspaceId, aliases: [full_name] })),
    executionPolicyRevisions: executionPolicies.map(({ id }) => ({ id, workspaceId })),
    deliveryPolicyRevisions: deliveryPolicies.map(({ id, pipeline_id }) => ({
      id,
      workspaceId,
      pipelineId: pipeline_id,
    })),
    approvers: approvers.map(({ id }) => ({ id, workspaceId })),
    // Setup receipts prove a repository owns a bundled onboarding snapshot.
    // Factories gain individual skill and tool grants with the registry in M03.
    skills: [],
    tools: [],
    sandboxProviders: getEnabledSandboxProviders(),
  };
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
