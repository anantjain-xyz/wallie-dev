import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  loadSessionRepositoryOptionsWithPrimary,
  resolveDefaultSessionRepositoryId,
} from "@/features/sessions/repository-options";
import {
  agentProviderSupportsEffort,
  getRecommendedAgentModel,
  normalizeAgentProviderName,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS as defaults,
} from "@/lib/agent-config/contracts";
import { factoryAgentPromptSnapshotSchema } from "@/lib/factory-agents/contracts";
import { mapStageRow } from "@/lib/pipeline/stages";
import { loadWorkspaceSandboxSettings } from "@/lib/sandbox-connections/server";
import type { Database, Tables } from "@/lib/supabase/database.types";

import type { CompiledFactoryDefinition } from "./compiler";
import { FACTORY_DEFINITION_SCHEMA_VERSION } from "./schema";
import { factorySettingsAgentSchema } from "./settings-contracts";
import { factoryStageDefinition } from "./stored-definition";

type Client = SupabaseClient<Database>;

export async function loadSettingsBaseline(
  client: Client,
  workspaceId: string,
  pipelineId: string,
  stageRows: Tables<"pipeline_stages">[],
  operatingRulesMd: string,
  factoryId: string,
): Promise<CompiledFactoryDefinition | null> {
  const [installation, repositories, onboarding] = await Promise.all([
    client
      .from("github_installations")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("suspended", false)
      .maybeSingle(),
    loadSessionRepositoryOptionsWithPrimary({ supabase: client, workspaceId }),
    client
      .from("workspace_onboarding")
      .select("selected_github_repository_id")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);
  if (installation.error) throw installation.error;
  if (onboarding.error) throw onboarding.error;
  if (!installation.data) return null;
  const repositoryId = resolveDefaultSessionRepositoryId({
    ...repositories,
    selectedGithubRepositoryId: onboarding.data?.selected_github_repository_id ?? null,
  });
  if (!repositoryId) return null;

  const [repository, execution, delivery, sandbox, agent, implementationAgent] = await Promise.all([
    client
      .from("github_repositories")
      .select("id")
      .eq("id", repositoryId)
      .eq("workspace_id", workspaceId)
      .eq("github_installation_id", installation.data.id)
      .eq("is_archived", false)
      .maybeSingle(),
    client
      .from("execution_policies")
      .select("current_revision_id")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    client
      .from("delivery_policies")
      .select("current_revision_id")
      .eq("workspace_id", workspaceId)
      .eq("pipeline_id", pipelineId)
      .maybeSingle(),
    loadWorkspaceSandboxSettings(client, workspaceId),
    client.from("workspace_agent_config").select("key,value_json").eq("workspace_id", workspaceId),
    client
      .from("factory_agent_prompt_revisions")
      .select("id, agent_id, prompt_md, prompt_sha256, factory_agents!inner(is_default)")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("factory_agents.is_default", true)
      .eq("revision_number", 1)
      .single(),
  ]);
  if (repository.error) throw repository.error;
  if (execution.error) throw execution.error;
  if (delivery.error) throw delivery.error;
  if (agent.error) throw agent.error;
  if (implementationAgent.error) throw implementationAgent.error;
  if (!repository.data) return null;

  const config = {
    ...defaults,
    ...Object.fromEntries(agent.data.map(({ key, value_json }) => [key, value_json])),
  };
  const provider = normalizeAgentProviderName(config.agent_provider) ?? defaults.agent_provider;
  return {
    schemaVersion: FACTORY_DEFINITION_SCHEMA_VERSION,
    kind: "serial",
    implementationAgent: factoryAgentPromptSnapshotSchema.parse({
      agentId: implementationAgent.data.agent_id,
      promptRevisionId: implementationAgent.data.id,
      promptMd: implementationAgent.data.prompt_md,
      promptSha256: implementationAgent.data.prompt_sha256,
    }),
    pipelineId,
    repositoryId,
    operatingRulesMd,
    sandboxProvider: sandbox.activeProvider,
    executionPolicyRevisionId: execution.data?.current_revision_id ?? null,
    deliveryPolicyRevisionId: delivery.data?.current_revision_id ?? null,
    skillIds: [],
    toolIds: [],
    operatingRuleStageIds: [],
    stages: stageRows
      .filter(({ archived_at }) => !archived_at)
      .map((row) => ({ ...factoryStageDefinition(mapStageRow(row)), previousStageIds: [] })),
    agent: factorySettingsAgentSchema.parse({
      provider,
      model:
        agent.data.find(({ key }) => key === "agent_model")?.value_json ??
        getRecommendedAgentModel(provider),
      effort: agentProviderSupportsEffort(provider) ? config.agent_effort : null,
      concurrencyLimit: config.concurrency_limit,
      stallTimeoutMs: config.stall_timeout_ms,
      maxRetries: config.max_retries,
      maxTurns: config.max_turns,
    }),
  };
}
