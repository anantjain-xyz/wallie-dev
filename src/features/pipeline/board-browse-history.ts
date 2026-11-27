import {
  PIPELINE_SEARCH_MAX_LENGTH,
  PIPELINE_STATUS_FILTERS,
  type PipelineStatusFilter,
} from "@/features/pipeline/types";

type BoardHistoryState = {
  scope: string;
  searchQuery?: string;
  laneKey?: string;
};

export function parseBoardStatus(
  value: string | string[] | null | undefined,
): PipelineStatusFilter {
  return PIPELINE_STATUS_FILTERS.find((status) => status === value) ?? "all";
}

export function readBoardBrowseHistory(pathname: string, factory: string) {
  if (window.location.pathname !== pathname) return null;
  const stored = window.history.state?.wallieBoard as BoardHistoryState | undefined;
  const entry = stored?.scope === `${pathname}?${factory}` ? stored : undefined;
  const statuses = new URLSearchParams(window.location.search).getAll("status");
  return {
    searchQuery: entry?.searchQuery ?? "",
    laneKey: entry?.laneKey,
    status: parseBoardStatus(statuses.length === 1 ? statuses[0] : undefined),
  };
}

export function writeBoardBrowseHistory(
  pathname: string,
  factory: string,
  changes: Omit<BoardHistoryState, "scope"> & { status?: PipelineStatusFilter },
) {
  const url = new URL(window.location.href);
  if (url.pathname !== pathname) return;
  const scope = `${pathname}?${factory}`;
  const stored = window.history.state?.wallieBoard as BoardHistoryState | undefined;
  const { status, ...entry } = changes;
  const next = { ...(stored?.scope === scope ? stored : undefined), ...entry, scope };
  if (next.searchQuery) next.searchQuery = next.searchQuery.slice(0, PIPELINE_SEARCH_MAX_LENGTH);
  if (status === "all" && url.searchParams.has("status")) url.searchParams.delete("status");
  else if (
    status &&
    status !== "all" &&
    (url.searchParams.getAll("status").length !== 1 || url.searchParams.get("status") !== status)
  )
    url.searchParams.set("status", status);
  window.history.replaceState(
    { wallieBoard: next },
    "",
    url.href === window.location.href ? undefined : url,
  );
}
