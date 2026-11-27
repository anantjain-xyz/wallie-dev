import "server-only";

import { notFound } from "next/navigation";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  loadWorkspaceRunCatalogPage,
  RunCatalogCursorError,
  RunCatalogWorkspaceUnavailableError,
  type WorkspaceRunCatalogPage,
} from "@/features/wallie/run-catalog";
import type { RunCatalogQuery } from "@/features/wallie/run-catalog-contracts";
import {
  loadRunPromptFilterLabel,
  loadRunSessionOptions,
  loadRunStageOptions,
  type RunSessionOption,
  type RunStageOption,
} from "@/features/wallie/runs-list-options";
import { parseRunsListQuery, type RunsListSearchParams } from "@/features/wallie/runs-list-state";
import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";

export type RunsListState =
  | { kind: "ready"; page: WorkspaceRunCatalogPage }
  | { kind: "invalid-query" | "invalid-cursor" | "error" };

export type RunsListData = {
  workspaceId: string;
  workspaceSlug: string;
  query: RunCatalogQuery;
  state: RunsListState;
  sessionOption?: RunSessionOption | null;
  stages?: RunStageOption[] | null;
  promptFilterLabel?: string | null;
  factoryNames?: Record<string, string>;
};

export async function loadRunsListData(
  workspaceSlug: string,
  searchParams: RunsListSearchParams,
  factoryId?: string,
): Promise<RunsListData> {
  const { supabase, workspace } = await loadWorkspaceLayoutContext(workspaceSlug);
  const parsed = parseRunsListQuery(searchParams);
  const scope = { supabase, workspaceId: workspace.id, factoryId };
  const query = parsed.data ?? {};
  const [sessionOption, stages, promptFilterLabel, factories] = await Promise.all([
    query.sessionId
      ? loadRunSessionOptions(scope, { sessionId: query.sessionId })
          .then(([option]) => option ?? null)
          .catch(() => null)
      : null,
    loadRunStageOptions(scope).catch(() => null),
    loadRunPromptFilterLabel(scope, query).catch(() => null),
    factoryId === undefined ? loadWorkspaceFactoryOptions(workspaceSlug) : undefined,
  ]);
  const common = {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    query,
    sessionOption,
    stages,
    promptFilterLabel,
    factoryNames: factories && Object.fromEntries(factories.map(({ id, name }) => [id, name])),
  };
  if (!parsed.success) return { ...common, state: { kind: "invalid-query" } };
  try {
    const page = await loadWorkspaceRunCatalogPage({
      ...scope,
      workspaceSlug: workspace.slug,
      query: parsed.data,
    });
    return { ...common, state: { kind: "ready", page } };
  } catch (error) {
    if (error instanceof RunCatalogWorkspaceUnavailableError) notFound();
    return {
      ...common,
      state: { kind: error instanceof RunCatalogCursorError ? "invalid-cursor" : "error" },
    };
  }
}
