import {
  agentProviderSupportsEffort,
  modelMatchesProvider,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  RECOMMENDED_AGENT_EFFORT,
} from "@/lib/agent-config/contracts";
import { unavailableMcpAdapterReason } from "@/lib/factory-mcp/adapter-readiness";

import type { CompiledFactoryDefinition } from "./compiler";

type DefinedAgent = CompiledFactoryDefinition["agent"];
type ExecutionProfileDefinition = Pick<
  CompiledFactoryDefinition,
  "sandboxProvider" | "executionGrant" | "credentialBindingId" | "mcpManifest"
> & {
  agent: Pick<DefinedAgent, "provider" | "model"> &
    Partial<Pick<DefinedAgent, "effort" | "maxTurns">>;
  implementationAgent?: Pick<
    NonNullable<CompiledFactoryDefinition["implementationAgent"]>,
    "agentId"
  >;
};

type CredentialAuthority =
  | { kind: "human"; memberId: string | null }
  | {
      kind: "service";
      grantId: string;
      grantVersion: number;
      bindingId: string | null;
      agentId: string | null;
    };

/** Resolve configured execution semantics before checking any current credentials. */
export function resolveFactoryExecutionProfile(
  definition: ExecutionProfileDefinition,
  creatorMemberId?: string | null,
) {
  const { agent, sandboxProvider, executionGrant, credentialBindingId, implementationAgent } =
    definition;
  const { model, provider } = agent;
  const credentialAuthority: CredentialAuthority = executionGrant
    ? {
        kind: "service",
        grantId: executionGrant.id,
        grantVersion: executionGrant.version,
        bindingId: credentialBindingId ?? null,
        agentId: implementationAgent?.agentId ?? null,
      }
    : { kind: "human", memberId: creatorMemberId ?? null };
  const mcpUnavailable = definition.mcpManifest?.servers.length
    ? unavailableMcpAdapterReason(provider)
    : undefined;

  return {
    provider,
    model,
    effort: agentProviderSupportsEffort(provider)
      ? (agent.effort ?? RECOMMENDED_AGENT_EFFORT)
      : null,
    maxTurns:
      provider === "claude-code"
        ? (agent.maxTurns ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.max_turns)
        : null,
    sandboxProvider,
    credentialAuthority,
    unavailableReason: modelMatchesProvider(provider, model)
      ? (mcpUnavailable ?? null)
      : "Choose a model supported by the configured agent in Factory Definition.",
  };
}

export type FactoryExecutionProfile = ReturnType<typeof resolveFactoryExecutionProfile>;
