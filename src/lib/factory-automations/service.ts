import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import {
  automationAdmissionControlSchema,
  type AutomationAdmissionControlCommand,
} from "./admission-control-contracts";
import {
  factoryAutomationListSchema,
  factoryAutomationSnapshotSchema,
  type createFactoryAutomationSchema,
  type factoryAutomationPathSchema,
  type factoryAutomationReadQuerySchema,
  type FactoryAutomationCommand,
} from "./contracts";
import { automationDryRunResponseSchema, type AutomationDryRunRequest } from "./dry-run-contracts";

type Client = SupabaseClient<Database>;
type AutomationScope = z.output<typeof factoryAutomationPathSchema>;
type FactoryScope = Omit<AutomationScope, "automationId">;
type ActorScope = FactoryScope & { actorUserId: string };

export async function listFactoryAutomations(
  client: Client,
  scope: FactoryScope,
  afterId?: AutomationScope["automationId"],
) {
  const { data, error } = await client.rpc("list_factory_automations", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    ...(afterId ? { p_after_id: afterId } : {}),
  });
  if (error) throw error;
  return data === null ? null : factoryAutomationListSchema.parse(data);
}

export async function readFactoryAutomation(
  client: Client,
  scope: AutomationScope,
  { revisionId }: z.output<typeof factoryAutomationReadQuerySchema>,
) {
  const { data, error } = await client.rpc("read_factory_automation", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_automation_id: scope.automationId,
    ...(revisionId ? { p_selected_revision_id: revisionId } : {}),
  });
  if (error) throw error;
  return data === null ? null : factoryAutomationSnapshotSchema.parse(data);
}

export async function dryRunFactoryAutomation(
  client: Client,
  scope: AutomationScope,
  input: AutomationDryRunRequest,
) {
  const { data, error } = await client.rpc("dry_run_factory_automation", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_automation_id: scope.automationId,
    p_revision_id: input.revisionId,
    p_event: input.event,
  });
  if (error) throw error;
  return data === null ? null : automationDryRunResponseSchema.parse(data);
}

export async function readAutomationAdmissionControl(client: Client, scope: AutomationScope) {
  const { data, error } = await client.rpc("read_factory_automation_admission_control", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_automation_id: scope.automationId,
  });
  if (error) throw error;
  return data === null ? null : automationAdmissionControlSchema.parse(data);
}

export async function configureAutomationAdmission(
  client: Client,
  scope: AutomationScope & ActorScope,
  command: AutomationAdmissionControlCommand,
) {
  const { data, error } = await client.rpc("configure_factory_automation_admission", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorUserId,
    p_automation_id: scope.automationId,
    p_expected_generation: command.expectedGeneration,
    p_paused: command.paused,
    p_max_concurrent_sessions: command.maxConcurrentSessions,
  });
  if (error) throw error;
  return automationAdmissionControlSchema.parse(data);
}

export async function createFactoryAutomation(
  client: Client,
  scope: ActorScope,
  { automationId, definition }: z.output<typeof createFactoryAutomationSchema>,
) {
  const { data, error } = await client.rpc("create_factory_automation", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorUserId,
    p_automation_id: automationId,
    p_definition: definition,
  });
  if (error) throw error;
  return factoryAutomationSnapshotSchema.parse(data);
}

export async function mutateFactoryAutomation(
  client: Client,
  scope: AutomationScope & ActorScope,
  command: FactoryAutomationCommand,
) {
  const params = {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorUserId,
    p_automation_id: scope.automationId,
    p_expected_revision_id: command.expectedRevisionId,
  };
  let result;
  switch (command.action) {
    case "save":
      result = await client.rpc("save_factory_automation_draft", {
        ...params,
        p_definition: command.definition,
      });
      break;
    case "publish":
      result = await client.rpc("publish_factory_automation", params);
      break;
    case "archive":
      result = await client.rpc("archive_factory_automation", {
        ...params,
        p_expected_publication: command.expectedPublication,
      });
      break;
  }
  if (result.error) throw result.error;
  return factoryAutomationSnapshotSchema.parse(result.data);
}
