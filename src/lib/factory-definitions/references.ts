import type { AgentProvider, SandboxProvider } from "@/lib/sandbox/types";
import type { FactoryAgentPromptSnapshot } from "@/lib/factory-agents/contracts";
import type { FactoryMcpManifest } from "@/lib/factory-mcp/manifest";
import type { ModelRoutingConfiguration } from "@/lib/model-routing/contracts";

export type FactoryReferenceEntry = {
  id: string;
  workspaceId: string;
  aliases?: readonly string[];
};

type DeliveryPolicyReference = FactoryReferenceEntry & { pipelineId: string };

type FactoryComponentReference = FactoryReferenceEntry & {
  agentProviders?: readonly AgentProvider[];
  sandboxProviders?: readonly SandboxProvider[];
};

export type FactoryMcpRevision = FactoryReferenceEntry &
  Omit<FactoryMcpManifest["servers"][number], "toolRevisionId" | "auth"> & {
    authKind: FactoryMcpManifest["servers"][number]["auth"]["kind"];
  };

export type FactoryMcpSecretBinding = FactoryReferenceEntry & {
  grantId: string;
  servicePrincipalId: string;
  agentId: string;
  toolRevisionId: string;
};

export type FactoryMcpExecutionGrant = FactoryReferenceEntry & {
  version: number;
  servicePrincipalId: string;
  toolIds: readonly string[];
};

export type QualifiedModelRoutingConfiguration = ModelRoutingConfiguration & {
  workspaceId: string;
  factoryId: string;
};

/** A caller supplies the eligible entries without loading secrets or contacting providers. */
export type FactoryDefinitionCatalog = {
  workspaceId: string;
  factoryId?: string;
  pipelines: readonly FactoryReferenceEntry[];
  repositories: readonly FactoryReferenceEntry[];
  executionPolicyRevisions: readonly FactoryReferenceEntry[];
  deliveryPolicyRevisions: readonly DeliveryPolicyReference[];
  skills: readonly FactoryComponentReference[];
  scorerRevisions?: readonly { id: string; workspaceId: string; factoryId: string }[];
  tools: readonly FactoryMcpRevision[];
  mcpSecretBindings?: readonly FactoryMcpSecretBinding[];
  mcpExecutionGrant?: FactoryMcpExecutionGrant;
  approvers: readonly FactoryReferenceEntry[];
  sandboxProviders: readonly SandboxProvider[];
  agentPromptRevisions?: readonly (FactoryReferenceEntry & FactoryAgentPromptSnapshot)[];
  modelRoutingConfigurations?: readonly QualifiedModelRoutingConfiguration[];
};

type FactoryReferenceResult<T> =
  | { ok: true; entry: T }
  | { ok: false; code: "missing_reference" | "ambiguous_reference" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeFactoryId(id: string): string {
  return UUID_PATTERN.test(id) ? id.toLowerCase() : id;
}

export function resolveFactoryReference<T extends FactoryReferenceEntry>(
  entries: readonly T[],
  workspaceId: string,
  reference: string,
): FactoryReferenceResult<T> {
  const normalizedId = normalizeFactoryId(reference);
  const normalizedWorkspaceId = normalizeFactoryId(workspaceId);
  const scoped = entries.filter(
    (entry) => normalizeFactoryId(entry.workspaceId) === normalizedWorkspaceId,
  );
  const exact = scoped.filter((entry) => normalizeFactoryId(entry.id) === normalizedId);
  const matches = exact.length
    ? exact
    : scoped.filter((entry) => entry.aliases?.includes(reference));
  const match = matches[0];
  if (!match) return { ok: false, code: "missing_reference" };
  if (
    matches.length > 1 ||
    scoped.some(
      (entry) => entry !== match && normalizeFactoryId(entry.id) === normalizeFactoryId(match.id),
    )
  ) {
    return { ok: false, code: "ambiguous_reference" };
  }
  return { ok: true, entry: match };
}

export function supportsFactoryComponent(
  entry: FactoryComponentReference,
  agentProvider: AgentProvider,
  sandboxProvider: SandboxProvider,
): boolean {
  return (
    (entry.agentProviders === undefined || entry.agentProviders.includes(agentProvider)) &&
    (entry.sandboxProviders === undefined || entry.sandboxProviders.includes(sandboxProvider))
  );
}
