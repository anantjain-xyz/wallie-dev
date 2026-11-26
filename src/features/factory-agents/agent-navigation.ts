import { z } from "zod";

import {
  resolveFactorySelection,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import { workspaceAgentDetailPath, workspaceRunsPath } from "@/lib/routes";

export const agentIdParam = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export function resolveAgentFactory(
  factories: readonly FactorySelectionOption[],
  requested?: string | string[],
) {
  const unscoped = requested === undefined || requested === "all";
  const selected = resolveFactorySelection(factories, unscoped ? undefined : requested, {
    useFirstVisible: factories.length === 1,
  });
  if (selected.kind === "factory") return selected;
  if (unscoped && factories.length > 0) return { kind: "choose" } as const;
  return { kind: "unavailable" } as const;
}

export function agentListQuery(query: { q?: string | string[]; after?: string | string[] }) {
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 120) : "";
  return {
    q: search && !search.includes("\u0000") ? search : undefined,
    after: agentIdParam.safeParse(query.after).data,
  };
}

export function agentPromptPath(
  workspaceSlug: string,
  agentId: string,
  query: Parameters<typeof workspaceAgentDetailPath>[2],
) {
  return `${workspaceAgentDetailPath(workspaceSlug, agentId, query)}#prompt-revision`;
}

export function agentRevisionRunsPath(
  workspaceSlug: string,
  factory: string,
  agentId: string,
  agentPromptRevisionId: string,
) {
  return workspaceRunsPath(workspaceSlug, { factory, agentId, agentPromptRevisionId });
}
