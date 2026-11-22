import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { agentConfigValueSchemas } from "@/lib/agent-config/contracts";
import { factoryAgentPromptSnapshotSchema } from "@/lib/factory-agents/contracts";
import { resolveFactoryExecutionProfile } from "@/lib/factory-definitions/execution-profile";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";
import type { Database, Tables } from "@/lib/supabase/database.types";

import { modelRoutingConfigurationSchema } from "./contracts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const routedExecutionSchema = z
  .strictObject({
    version: z.literal(1),
    configuration: modelRoutingConfigurationSchema,
    benchmarkCandidateKey: digest,
    definitionDigest: digest,
    modelName: z.string().min(1),
    effort: agentConfigValueSchemas.agent_effort.nullable(),
    sandboxProvider: sandboxProviderSchema,
    sandboxConnectionRevision: z.string().uuid(),
    credentialBindingId: z.string().uuid().nullable(),
    implementationAgent: factoryAgentPromptSnapshotSchema.omit({ promptMd: true }),
  })
  .refine(
    ({ configuration, effort, implementationAgent }) =>
      configuration.agentId === implementationAgent.agentId &&
      (configuration.harness === "codex" || effort === null),
  );

export type RoutedFactoryExecution = z.infer<typeof routedExecutionSchema>;

export async function loadRoutedFactoryExecution(
  client: Pick<SupabaseClient<Database>, "rpc">,
  session: Pick<
    Tables<"sessions">,
    "id" | "workspace_id" | "factory_id" | "execute_pinned_definition"
  >,
): Promise<RoutedFactoryExecution | null> {
  if (!session.execute_pinned_definition) return null;
  const { data, error } = await client.rpc("get_session_factory_routing_execution", {
    p_workspace_id: session.workspace_id,
    p_factory_id: session.factory_id,
    p_session_id: session.id,
  });
  if (error) throw error;
  return data === null ? null : routedExecutionSchema.parse(data);
}

export function resolveRoutedFactoryExecutionProfile(
  definition: Parameters<typeof resolveFactoryExecutionProfile>[0],
  routing: RoutedFactoryExecution | null | undefined,
  creatorMemberId?: string | null,
) {
  if (!routing) return resolveFactoryExecutionProfile(definition, creatorMemberId);
  // Qualified replay and this profile share the Codex default when effort is unset.
  return resolveFactoryExecutionProfile(
    {
      ...definition,
      agent: {
        provider: routing.configuration.harness,
        model: routing.modelName,
        effort: routing.effort,
      },
      sandboxProvider: routing.sandboxProvider,
      implementationAgent: routing.implementationAgent,
      credentialBindingId: routing.credentialBindingId ?? undefined,
    },
    creatorMemberId,
  );
}
