import "server-only";

import { notFound } from "next/navigation";

import {
  loadWorkspaceRunCatalogPage,
  RunCatalogCursorError,
  RunCatalogWorkspaceUnavailableError,
  type WorkspaceRunCatalogPage,
} from "@/features/wallie/run-catalog";
import type { RunCatalogQuery } from "@/features/wallie/run-catalog-contracts";
import { parseRunsListQuery, type RunsListSearchParams } from "@/features/wallie/runs-list-state";
import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";

export type RunsListState =
  | { kind: "ready"; page: WorkspaceRunCatalogPage }
  | { kind: "invalid-query" | "invalid-cursor" | "error" };

export type RunsListData = {
  workspaceSlug: string;
  query: RunCatalogQuery;
  state: RunsListState;
};

export async function loadRunsListData(
  workspaceSlug: string,
  searchParams: RunsListSearchParams,
  factoryId?: string,
): Promise<RunsListData> {
  const { supabase, workspace } = await loadWorkspaceLayoutContext(workspaceSlug);
  const parsed = parseRunsListQuery(searchParams);
  if (!parsed.success) {
    return { workspaceSlug: workspace.slug, query: {}, state: { kind: "invalid-query" } };
  }
  const common = { workspaceSlug: workspace.slug, query: parsed.data };
  try {
    const page = await loadWorkspaceRunCatalogPage({
      supabase,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      query: parsed.data,
      ...(factoryId ? { factoryId } : {}),
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
