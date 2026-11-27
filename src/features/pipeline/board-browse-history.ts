import {
  PIPELINE_SEARCH_MAX_LENGTH,
  PIPELINE_STATUS_FILTERS,
  type PipelineStatusFilter,
} from "@/features/pipeline/types";

export type BoardBrowseStage = { key: string; origin: "manual" | "automatic" };
type BoardBrowseState = { searchQuery?: string; stage?: BoardBrowseStage };
export type BoardBrowseChanges = BoardBrowseState & { status?: PipelineStatusFilter };

type BoardHistoryScope = { factory: string; pathname: string; viewerId: string };
const entries = new Map<string, BoardBrowseState & { scope: string }>();

if (typeof window !== "undefined") window.addEventListener("pagehide", () => entries.clear());

function findEntry(scope: string) {
  const key: unknown = window.history.state?.wallieBoard;
  if (typeof key !== "string") return undefined;
  const value = entries.get(key);
  return value?.scope === scope ? { key, value } : undefined;
}

export function parseBoardStatus(
  value: string | string[] | null | undefined,
): PipelineStatusFilter {
  return PIPELINE_STATUS_FILTERS.find((status) => status === value) ?? "all";
}

export function readBoardBrowseHistory({ factory, pathname, viewerId }: BoardHistoryScope) {
  if (window.location.pathname !== pathname) return null;
  const entry = findEntry(JSON.stringify([pathname, factory, viewerId]));
  const statuses = new URLSearchParams(window.location.search).getAll("status");
  return {
    entryKey: entry?.key,
    searchQuery: entry?.value.searchQuery ?? "",
    stage: entry?.value.stage,
    status: parseBoardStatus(statuses.length === 1 ? statuses[0] : undefined),
  };
}

export function writeBoardBrowseHistory(
  { factory, pathname, viewerId }: BoardHistoryScope,
  changes: BoardBrowseChanges,
  mode: "push" | "replace" = "replace",
) {
  const url = new URL(window.location.href);
  if (url.pathname !== pathname) return;
  const scope = JSON.stringify([pathname, factory, viewerId]);
  const stored = findEntry(scope);
  const key =
    (mode === "replace" && stored?.key) || crypto.getRandomValues(new Uint32Array(4)).join("-");
  const { status, ...entry } = changes;
  const next = { ...stored?.value, ...entry, scope };
  if (next.searchQuery) next.searchQuery = next.searchQuery.slice(0, PIPELINE_SEARCH_MAX_LENGTH);
  entries.set(key, next);
  if (status === "all" && url.searchParams.has("status")) url.searchParams.delete("status");
  else if (
    status &&
    status !== "all" &&
    (url.searchParams.getAll("status").length !== 1 || url.searchParams.get("status") !== status)
  )
    url.searchParams.set("status", status);
  const destination = url.href === window.location.href ? undefined : url;
  if (mode === "push") window.history.pushState({ wallieBoard: key }, "", url);
  else if (!stored || destination)
    window.history.replaceState({ wallieBoard: key }, "", destination);
  return key;
}
