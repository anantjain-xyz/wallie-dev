import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveDefaultSessionRepositoryId } from "@/features/sessions/repository-options";
import {
  agentProviderSupportsEffort,
  getRecommendedAgentModel,
  normalizeAgentProviderName,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS as defaults,
} from "@/lib/agent-config/contracts";
import { factoryAgentPromptSnapshotSchema } from "@/lib/factory-agents/contracts";
import { mapStageRow } from "@/lib/pipeline/stages";
import { loadWorkspaceSandboxSettings } from "@/lib/sandbox-connections/server";
import type { SandboxProvider } from "@/lib/sandbox/types";
import type { Database, Tables } from "@/lib/supabase/database.types";

import { loadFactoryDefinitionRepositories } from "./authority";
import type { CompiledFactoryDefinition } from "./compiler";
import { FACTORY_DEFINITION_SCHEMA_VERSION } from "./schema";
import { factorySettingsAgentSchema } from "./settings-contracts";
import { factoryStageDefinition } from "./stored-definition";

type Client = SupabaseClient<Database>;
export type FactoryBaselineSetup = {
  repositories: Awaited<ReturnType<typeof loadFactoryDefinitionRepositories>>;
  sandboxProvider: SandboxProvider;
};

export async function loadSettingsBaseline(
  client: Client,
  workspaceId: string,
  pipelineId: string,
  stageRows: Tables<"pipeline_stages">[],
  operatingRulesMd: string,
  factory: { id: string; is_default: boolean },
  setup?: FactoryBaselineSetup,
): Promise<CompiledFactoryDefinition | null> {
  const stages = stageRows.filter(({ archived_at }) => !archived_at);
  const initialSetup = !factory.is_default && !stages.length ? setup : undefined;
  if (!stages.length && !initialSetup) return null;
  const [repositories, profile, onboarding] = await Promise.all([
    setup?.repositories ?? loadFactoryDefinitionRepositories(client, workspaceId, factory.id),
    factory.is_default
      ? client
          .from("workspace_repository_profiles")
          .select("github_repository_id")
          .eq("workspace_id", workspaceId)
          .eq("is_primary", true)
          .maybeSingle()
      : null,
    factory.is_default
      ? client
          .from("workspace_onboarding")
          .select("selected_github_repository_id")
          .eq("workspace_id", workspaceId)
          .maybeSingle()
      : null,
  ]);
  if (profile?.error) throw profile.error;
  if (onboarding?.error) throw onboarding.error;
  const repositoryId = resolveDefaultSessionRepositoryId({
    primaryGithubRepositoryId: profile?.data?.github_repository_id ?? null,
    selectedGithubRepositoryId: onboarding?.data?.selected_github_repository_id ?? null,
    repositoryOptions: repositories
      .map(({ id, full_name: fullName }) => ({ id, fullName }))
      .sort(
        (left, right) =>
          left.fullName.localeCompare(right.fullName) || left.id.localeCompare(right.id),
      ),
  });
  if (!repositoryId) return null;

  const [execution, delivery, sandbox, agent, implementationAgent] = await Promise.all([
    initialSetup
      ? null
      : client
          .from("execution_policies")
          .select("current_revision_id")
          .eq("workspace_id", workspaceId)
          .maybeSingle(),
    initialSetup
      ? null
      : client
          .from("delivery_policies")
          .select("current_revision_id")
          .eq("workspace_id", workspaceId)
          .eq("pipeline_id", pipelineId)
          .maybeSingle(),
    initialSetup
      ? { activeProvider: initialSetup.sandboxProvider }
      : loadWorkspaceSandboxSettings(client, workspaceId),
    initialSetup
      ? null
      : client
          .from("workspace_agent_config")
          .select("key,value_json")
          .eq("workspace_id", workspaceId),
    client
      .from("factory_agent_prompt_revisions")
      .select("id, agent_id, prompt_md, prompt_sha256, factory_agents!inner(is_default)")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .eq("factory_agents.is_default", true)
      .eq("revision_number", 1)
      .single(),
  ]);
  if (execution?.error) throw execution.error;
  if (delivery?.error) throw delivery.error;
  if (agent?.error) throw agent.error;
  if (implementationAgent.error) throw implementationAgent.error;

  const agentConfig = agent?.data ?? [];
  const config = {
    ...defaults,
    ...Object.fromEntries(agentConfig.map(({ key, value_json }) => [key, value_json])),
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
    executionPolicyRevisionId: execution?.data?.current_revision_id ?? null,
    deliveryPolicyRevisionId: delivery?.data?.current_revision_id ?? null,
    skillIds: [],
    toolIds: [],
    operatingRuleStageIds: [],
    stages: stages.map((row) => ({
      ...factoryStageDefinition(mapStageRow(row)),
      previousStageIds: [],
    })),
    agent: factorySettingsAgentSchema.parse({
      provider,
      model:
        agentConfig.find(({ key }) => key === "agent_model")?.value_json ??
        getRecommendedAgentModel(provider),
      effort: agentProviderSupportsEffort(provider) ? config.agent_effort : null,
      concurrencyLimit: config.concurrency_limit,
      stallTimeoutMs: config.stall_timeout_ms,
      maxRetries: config.max_retries,
      maxTurns: config.max_turns,
    }),
  };
}
