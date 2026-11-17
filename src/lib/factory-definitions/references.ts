import type { AgentProvider, SandboxProvider } from "@/lib/sandbox/types";
import type { FactoryAgentPromptSnapshot } from "@/lib/factory-agents/contracts";

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

/** A caller supplies the eligible entries without loading secrets or contacting providers. */
export type FactoryDefinitionCatalog = {
  workspaceId: string;
  pipelines: readonly FactoryReferenceEntry[];
  repositories: readonly FactoryReferenceEntry[];
  executionPolicyRevisions: readonly FactoryReferenceEntry[];
  deliveryPolicyRevisions: readonly DeliveryPolicyReference[];
  skills: readonly FactoryComponentReference[];
  tools: readonly FactoryComponentReference[];
  approvers: readonly FactoryReferenceEntry[];
  sandboxProviders: readonly SandboxProvider[];
  agentPromptRevisions?: readonly (FactoryReferenceEntry & FactoryAgentPromptSnapshot)[];
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
