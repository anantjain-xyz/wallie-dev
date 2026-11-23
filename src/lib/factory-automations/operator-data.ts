import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadFactoryDefinitionRepositories } from "@/lib/factory-definitions/authority";
import type { Database } from "@/lib/supabase/database.types";

import {
  automationHistorySchema,
  automationSetupSchema,
  type AutomationHistoryCursor,
  type AutomationSetupOptions,
} from "./operator-contracts";

type Client = SupabaseClient<Database>;
type FactoryScope = { workspaceId: string; factoryId: string };
const lookupTimeoutMs = 8_000;

export async function loadFactoryAutomationSetup(
  client: Client,
  scope: FactoryScope,
): Promise<AutomationSetupOptions | null> {
  const { workspaceId, factoryId } = scope;
  const signal = AbortSignal.timeout(lookupTimeoutMs);
  const params = { p_workspace_id: workspaceId, p_factory_id: factoryId };
  const [setup, repositories, workflows] = await Promise.all([
    client.rpc("read_factory_automation_setup", params).abortSignal(signal),
    loadFactoryDefinitionRepositories(client, workspaceId, factoryId, signal),
    client.rpc("list_factory_workflow_intake_options", params).abortSignal(signal),
  ]);
  if (setup.error) throw setup.error;
  if (workflows.error) throw workflows.error;
  if (setup.data === null) return null;
  const { assignment } = automationSetupSchema.parse(setup.data);
  return {
    assignment,
    repositories: repositories.map(({ id, full_name }) => ({ id, name: full_name })),
    workflows: workflows.data.flatMap(
      ({ definition_digest, workflow_id, activation_id, display_name }) =>
        assignment?.definitionDigest === definition_digest
          ? [{ id: workflow_id, activationId: activation_id, name: display_name }]
          : [],
    ),
  };
}

export async function listFactoryAutomationOccurrenceHistory(
  client: Client,
  scope: FactoryScope & { automationId: string },
  cursor?: AutomationHistoryCursor,
) {
  const { data, error } = await client
    .rpc("list_factory_automation_occurrence_history", {
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_automation_id: scope.automationId,
      ...(cursor ? { p_before_recorded_at: cursor.recordedAt, p_before_id: cursor.id } : {}),
    })
    .abortSignal(AbortSignal.timeout(lookupTimeoutMs));
  if (error) throw error;
  return data === null ? null : automationHistorySchema.parse(data);
}
