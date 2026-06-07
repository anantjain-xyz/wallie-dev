"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { shouldShowOnboardingResumeCta } from "@/features/onboarding/flow";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import { SessionPhaseStatusLabel } from "@/features/sessions/components/session-phase-status-label";
import { updateSessionTitleFromClient } from "@/features/sessions/client";
import type { SessionListPageData } from "@/features/sessions/list/data";
import {
  type SessionFilterKey,
  type SessionListQueryState,
  type SessionSummary,
} from "@/features/sessions/types";
import { CheckIcon, PencilIcon, SearchIcon, XIcon } from "@/components/shared/icons";
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

export type SessionTitleEditKeyIntent = "cancel" | "save";

export function getSessionTitleEditKeyIntent(key: string): SessionTitleEditKeyIntent | null {
  if (key === "Enter") return "save";
  if (key === "Escape") return "cancel";
  return null;
}

export function SessionsPageClient({ initialData }: SessionsPageClientProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const workspaceSlug = initialData.workspace.slug;
  const basePath = workspaceSessionsPath(workspaceSlug);
  const shouldResumeSetup = shouldShowOnboardingResumeCta(initialData.onboarding);

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
      <PageHeader title="Sessions" />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <form
          onSubmit={handleSearchSubmit}
          className="relative w-full flex-none sm:max-w-md sm:flex-1 sm:min-w-[220px]"
        >
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
              ? shouldResumeSetup
                ? "Finish workspace setup before starting the first session."
                : "Start your first session from the top nav."
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
  const router = useRouter();
  const detailHref = workspaceSessionDetailPath(workspaceSlug, session.number);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(session.title);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(session.title);
    if (!isEditing) {
      setDraftTitle(session.title);
    }
  }, [isEditing, session.title]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  function beginEditing() {
    setDraftTitle(title);
    setError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    if (isSaving) return;
    setDraftTitle(title);
    setError(null);
    setIsEditing(false);
  }

  async function saveTitle() {
    if (isSaving) return;

    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setError("Title is required.");
      return;
    }

    if (nextTitle === title) {
      setDraftTitle(title);
      setError(null);
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const result = await updateSessionTitleFromClient({
        sessionId: session.id,
        title: nextTitle,
      });
      setTitle(result.title);
      setDraftTitle(result.title);
      setIsEditing(false);
      router.refresh();
    } catch (caught) {
      setDraftTitle(title);
      setError(caught instanceof Error ? caught.message : "Failed to update session title.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleTitleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveTitle();
  }

  function handleTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const intent = getSessionTitleEditKeyIntent(event.key);
    if (!intent) return;

    event.preventDefault();
    event.stopPropagation();

    if (intent === "save") {
      void saveTitle();
      return;
    }

    cancelEditing();
  }

  return (
    <li className="relative flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-surface-strong sm:px-5 md:flex-row md:items-center">
      <Link
        href={detailHref}
        className="absolute inset-0 z-10 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="sr-only">
          Open session #{session.number}: {title}
        </span>
      </Link>

      <div className="pointer-events-none relative z-20 flex min-w-0 flex-1 flex-col gap-1">
        {isEditing ? (
          <form
            onSubmit={handleTitleSubmit}
            className="pointer-events-auto relative z-30 flex min-w-0 flex-col gap-1"
          >
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2">
              <span className="font-mono text-[11px] text-muted">#{session.number}</span>
              <input
                ref={inputRef}
                value={draftTitle}
                onChange={(event) => {
                  setDraftTitle(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={handleTitleKeyDown}
                disabled={isSaving}
                className="ui-input h-8 min-w-0 px-2 py-1 text-[14px] font-medium"
                aria-label={`Title for session #${session.number}`}
              />
              <button
                type="submit"
                className="ui-icon-button h-8 w-8"
                disabled={isSaving}
                aria-label={`Save title for session #${session.number}`}
              >
                <CheckIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="ui-icon-button h-8 w-8"
                onClick={cancelEditing}
                disabled={isSaving}
                aria-label={`Cancel title edit for session #${session.number}`}
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            {isSaving ? (
              <p role="status" className="pl-[38px] text-[11px] text-muted">
                Saving...
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="pl-[38px] text-[11px] text-danger">
                {error}
              </p>
            ) : null}
          </form>
        ) : (
          <div className="flex min-w-0 items-start gap-2 md:items-center">
            <span className="font-mono text-[11px] text-muted">#{session.number}</span>
            <span className="line-clamp-2 min-w-0 text-[14px] font-medium text-foreground md:block md:truncate">
              {title}
            </span>
            <button
              type="button"
              className="ui-icon-button pointer-events-auto relative z-30 h-6 w-6 shrink-0"
              onClick={beginEditing}
              aria-label={`Edit title for session #${session.number}`}
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span>{session.currentStageName}</span>
          <span>·</span>
          <SessionPhaseStatusLabel status={session.phaseStatus} />
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

      <div className="pointer-events-none relative z-20 shrink-0">
        <SessionConnections
          className="pointer-events-auto"
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
