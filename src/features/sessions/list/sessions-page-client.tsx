"use client";

import Link from "next/link";
import { useMemo, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import type { SessionListPageData } from "@/features/sessions/list/data";
import {
  formatSessionPhaseStatus,
  sessionPhaseStatusTone,
  type SessionFilterKey,
  type SessionListQueryState,
  type SessionSummary,
} from "@/features/sessions/types";
import { StatusChip } from "@/components/shared/status-chip";
import { SearchIcon } from "@/components/shared/icons";
import { workspaceSessionDetailPath, workspaceSessionsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type SessionsPageClientProps = {
  initialData: SessionListPageData;
};

function buildHref(
  base: string,
  state: Pick<SessionListQueryState, "stageSlug" | "query" | "scope">,
): string {
  const params = new URLSearchParams();
  if (state.stageSlug) params.set("stage", state.stageSlug);
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.scope !== "all") params.set("scope", state.scope);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const SCOPE_CHIPS: { key: SessionFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "has-pr", label: "Has PR" },
  { key: "archived", label: "Archived" },
];

export function SessionsPageClient({ initialData }: SessionsPageClientProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const workspaceSlug = initialData.workspace.slug;
  const basePath = workspaceSessionsPath(workspaceSlug);

  function updateQueryState(next: Partial<SessionListQueryState>) {
    const merged: SessionListQueryState = {
      query: next.query !== undefined ? next.query : initialData.queryState.query,
      scope: next.scope !== undefined ? next.scope : initialData.queryState.scope,
      stageSlug: next.stageSlug !== undefined ? next.stageSlug : initialData.queryState.stageSlug,
    };
    startTransition(() => {
      router.replace(buildHref(basePath, merged));
    });
  }

  function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = searchInputRef.current?.value ?? "";
    updateQueryState({ query: value });
  }

  const sessions = initialData.sessions;
  // Build the stage filter chips from whatever stages appear in the loaded
  // sessions. This keeps the chip set in sync with workspaces that have
  // edited their pipeline; we don't need to know the workspace's pipeline
  // shape at this layer.
  const stageGroups = useMemo(() => {
    const order: { name: string; slug: string }[] = [];
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const session of sessions) {
      if (!seen.has(session.currentStageSlug)) {
        seen.add(session.currentStageSlug);
        order.push({ name: session.currentStageName, slug: session.currentStageSlug });
      }
      counts.set(session.currentStageSlug, (counts.get(session.currentStageSlug) ?? 0) + 1);
    }
    return { counts, order };
  }, [sessions]);

  return (
    <PageContainer>
      <PageHeader
        title="Sessions"
        description="Every session in this workspace, across all pipeline stages."
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <form onSubmit={handleSearchSubmit} className="relative min-w-[220px] flex-1 max-w-md">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            key={initialData.queryState.query}
            ref={searchInputRef}
            type="search"
            defaultValue={initialData.queryState.query}
            placeholder="Search prompts, titles, Linear IDs"
            className="ui-input pl-8"
            aria-label="Search sessions"
          />
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          {SCOPE_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={cn(
                "ui-filter-chip",
                initialData.queryState.scope === chip.key && "ui-filter-chip-active",
              )}
              onClick={() => updateQueryState({ scope: chip.key })}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={cn(
              "ui-filter-chip",
              initialData.queryState.stageSlug === null && "ui-filter-chip-active",
            )}
            onClick={() => updateQueryState({ stageSlug: null })}
          >
            All stages
          </button>
          {stageGroups.order.map((stage) => (
            <button
              key={stage.slug}
              type="button"
              className={cn(
                "ui-filter-chip",
                initialData.queryState.stageSlug === stage.slug && "ui-filter-chip-active",
              )}
              onClick={() => updateQueryState({ stageSlug: stage.slug })}
            >
              {stage.name}
              <span className="ml-1 text-[10px] text-muted">
                {stageGroups.counts.get(stage.slug) ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="flex flex-col items-center rounded-[10px] border border-dashed border-border bg-surface-strong px-6 py-16 text-center">
          <p className="text-[14px] font-semibold text-foreground">No sessions match.</p>
          <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted">
            {initialData.totalCount === 0
              ? "Kick off your first session by clicking New session in the top nav."
              : "Adjust the stage, scope, or search to see more sessions."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface">
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} workspaceSlug={workspaceSlug} />
          ))}
        </ul>
      )}
    </PageContainer>
  );
}

function SessionRow({
  session,
  workspaceSlug,
}: {
  session: SessionSummary;
  workspaceSlug: string;
}) {
  return (
    <li className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-surface-muted md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted">#{session.number}</span>
          <Link
            href={workspaceSessionDetailPath(workspaceSlug, session.number)}
            className="truncate text-[14px] font-medium text-foreground hover:underline"
          >
            {session.title}
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span>{session.currentStageName}</span>
          <span>·</span>
          <StatusChip tone={sessionPhaseStatusTone(session.phaseStatus)}>
            {formatSessionPhaseStatus(session.phaseStatus)}
          </StatusChip>
          <span>·</span>
          <span>updated {relativeTime(session.updatedAt)}</span>
          {session.archivedAt ? (
            <>
              <span>·</span>
              <span className="text-muted">archived</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="shrink-0">
        <SessionConnections
          compact
          linearIssueId={session.linearIssueId}
          linearIssueUrl={session.linearIssueUrl}
          pullRequestCount={session.pullRequestCount}
          pullRequests={session.pullRequests}
        />
      </div>
    </li>
  );
}
