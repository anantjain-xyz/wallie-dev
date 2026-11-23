import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import {
  factoryAutomationListSchema,
  factoryAutomationSnapshotSchema,
  type createFactoryAutomationSchema,
  type factoryAutomationPathSchema,
  type factoryAutomationReadQuerySchema,
  type FactoryAutomationCommand,
} from "./contracts";

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
