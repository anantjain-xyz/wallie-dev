import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

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
    sandboxProvider: sandboxProviderSchema,
    sandboxConnectionRevision: z.string().uuid(),
    credentialBindingId: z.string().uuid().nullable(),
    implementationAgent: factoryAgentPromptSnapshotSchema.omit({ promptMd: true }),
  })
  .refine(
    ({ configuration, implementationAgent }) =>
      configuration.agentId === implementationAgent.agentId,
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
  // Comparison axes may qualify a different harness and native model from the
  // source revision. Use normalized provider defaults for options the axis did not measure.
  return resolveFactoryExecutionProfile(
    {
      ...definition,
      agent: { provider: routing.configuration.harness, model: routing.modelName },
      sandboxProvider: routing.sandboxProvider,
      implementationAgent: routing.implementationAgent,
      credentialBindingId: routing.credentialBindingId ?? undefined,
    },
    creatorMemberId,
  );
}
