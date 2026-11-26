"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { useRealtimeRecovery } from "@/features/wallie/realtime-recovery-context";
import {
  factoryInboxSchema,
  type FactoryInbox,
  type FactoryInboxItem,
  type FactoryInboxKind,
} from "@/lib/factories/inbox-schema";
import {
  workspaceInboxPath,
  workspaceSessionDetailPath,
  workspaceSessionsPath,
} from "@/lib/routes";
import { sessionReviewQuery } from "@/lib/sessions/review-link";
import {
  loadSupabaseBrowserClient,
  subscribeDeferredAuthenticatedChannel,
} from "@/lib/supabase/deferred-browser";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";

const ACCESS_RECHECK_MS = 30_000;
const INBOX_VIEWS = [
  { label: "All items", kind: undefined },
  { label: "Reviews", kind: "review" },
  { label: "Clarifications", kind: "clarification" },
] as const;

type InboxView =
  | { inbox: FactoryInbox; kind: "ready" }
  | { kind: "checking" | "offline" | "unavailable" | "error" };

type HiddenInboxKind = Exclude<InboxView["kind"], "ready">;

const HIDDEN_INBOX_MESSAGES: Record<HiddenInboxKind, string> = {
  checking: "Checking Inbox access…",
  offline: "You’re offline. Reconnect to refresh your Inbox.",
  unavailable: "Inbox unavailable. Refresh to check your access.",
  error: "Couldn’t load Inbox. Refresh to try again.",
};

class InboxRefreshError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Inbox unavailable.");
    this.status = status;
  }
}

function isInboxAccessDenied(error: unknown) {
  return error instanceof InboxRefreshError && [401, 403, 404].includes(error.status);
}

function isOnline() {
  return typeof navigator === "undefined" || navigator.onLine;
}

export function FactoryInboxPage({
  cursor,
  factoryId,
  factorySelector,
  initialInbox,
  initialNow,
  kind,
  memberId,
  workspaceId,
  workspaceSlug,
}: {
  cursor: string | null;
  factoryId: string | null;
  factorySelector?: ReactNode;
  initialInbox: FactoryInbox | null;
  initialNow: string;
  kind?: FactoryInboxKind;
  memberId: string;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const config = useSupabasePublicConfig();
  const { recovery } = useRealtimeRecovery();
  const [view, setView] = useState<InboxView>(() =>
    initialInbox ? { inbox: initialInbox, kind: "ready" } : { kind: "unavailable" },
  );
  const [manualRefresh, setManualRefresh] = useState<"idle" | "pending" | "success">("idle");
  const manualRequest = useRef<symbol | null>(null);
  const inbox = view.kind === "ready" ? view.inbox : null;
  const scope = { factory: factoryId ?? undefined, kind };
  const returnTo = workspaceInboxPath(workspaceSlug, { ...scope, cursor: cursor ?? undefined });

  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    let lastVerifiedAt = Date.parse(initialNow);
    const query = new URLSearchParams({ workspaceId });
    if (factoryId) query.set("factoryId", factoryId);
    if (kind) query.set("kind", kind);
    if (cursor) query.set("cursor", cursor);

    const key = `factory-inbox:${workspaceId}:${factoryId ?? "all"}`;
    const filter = factoryId ? `factory_id=eq.${factoryId}` : `workspace_id=eq.${workspaceId}`;
    const unregister = recovery.register({
      key,
      role: "page",
      required: true,
      async refresh(signal) {
        const request = ++requestSequence;
        const manual = manualRequest.current;
        const settleManual = (success: boolean) => {
          if (!active || !manual || manualRequest.current !== manual) return;
          manualRequest.current = null;
          setManualRefresh(success ? "success" : "idle");
        };
        const isCurrent = () => active && request === requestSequence;
        const hideIfCurrent = (kind: HiddenInboxKind) => {
          if (isCurrent()) setView({ kind });
        };
        const clearIfCurrent = () => {
          hideIfCurrent(isOnline() ? "checking" : "offline");
          settleManual(false);
        };
        signal.addEventListener("abort", clearIfCurrent, { once: true });
        // Hidden views move to checking while a read runs; fresh rows stay
        // visible so a revalidation never flashes the list empty.
        setView((current) => {
          if (current.kind === "ready") return current;
          const kind: HiddenInboxKind = isOnline() ? "checking" : "offline";
          return current.kind === kind ? current : { kind };
        });
        try {
          const response = await fetch(`/api/factories/inbox?${query}`, {
            cache: "no-store",
            signal,
          });
          if (!response.ok) throw new InboxRefreshError(response.status);
          const verified = factoryInboxSchema.parse(await response.json());
          if (isCurrent() && !signal.aborted) {
            lastVerifiedAt = Date.now();
            setView({ inbox: verified, kind: "ready" });
            settleManual(true);
          }
        } catch (error) {
          if (isCurrent()) {
            setView(
              !isOnline()
                ? { kind: "offline" }
                : signal.aborted
                  ? { kind: "checking" }
                  : isInboxAccessDenied(error)
                    ? { kind: "unavailable" }
                    : { kind: "error" },
            );
          }
          throw error;
        } finally {
          settleManual(false);
          signal.removeEventListener("abort", clearIfCurrent);
        }
      },
      subscribe(onStatus, isCurrent) {
        if (!config) return () => {};
        function invalidate() {
          if (isCurrent()) recovery.invalidate();
        }
        return subscribeDeferredAuthenticatedChannel(
          () => loadSupabaseBrowserClient(config),
          (supabase) =>
            supabase
              .channel(key)
              .on(
                "postgres_changes",
                { event: "UPDATE", schema: "public", table: "sessions", filter },
                invalidate,
              )
              .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "sessions", filter },
                invalidate,
              )
              .on(
                "postgres_changes",
                {
                  event: "UPDATE",
                  schema: "public",
                  table: "workspace_members",
                  filter: `id=eq.${memberId}`,
                },
                () => {
                  if (!isCurrent()) return;
                  hideSnapshot(isOnline() ? "checking" : "offline");
                  recovery.invalidate();
                },
              ),
          onStatus,
          isCurrent,
        );
      },
    });
    function recheck() {
      if (document.visibilityState !== "visible") return;
      if (!isOnline()) {
        hideSnapshot("offline");
        return;
      }
      if (Date.now() - lastVerifiedAt >= ACCESS_RECHECK_MS) hideSnapshot();
      recovery.invalidate();
    }
    function hideSnapshot(kind: HiddenInboxKind = "checking") {
      requestSequence++;
      setView((current) => (current.kind === kind ? current : { kind }));
    }
    function hideOffline() {
      manualRequest.current = null;
      setManualRefresh("idle");
      hideSnapshot("offline");
    }
    const interval = window.setInterval(recheck, ACCESS_RECHECK_MS);
    window.addEventListener("focus", recheck);
    window.addEventListener("offline", hideOffline);
    document.addEventListener("visibilitychange", recheck);
    if (!isOnline()) hideOffline();
    recovery.invalidate();
    return () => {
      active = false;
      unregister();
      window.clearInterval(interval);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("offline", hideOffline);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [config, cursor, factoryId, initialNow, kind, memberId, recovery, workspaceId]);

  const pending = manualRefresh === "pending";
  const unavailableFactory = view.kind === "unavailable" && factoryId !== null;
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={
          <>
            {factoryId === null || inbox ? factorySelector : null}
            <button
              aria-busy={pending}
              className="ui-button"
              disabled={pending || view.kind === "offline"}
              onClick={() => {
                if (manualRequest.current || !isOnline()) return;
                manualRequest.current = Symbol();
                setManualRefresh("pending");
                recovery.retry();
                recovery.invalidate();
              }}
              type="button"
            >
              <ActionButtonLabel idle="Refresh" pending={pending} pendingLabel="Refreshing…" />
            </button>
          </>
        }
        actionsRightOnDesktop
        title="Inbox"
      />
      <p role="status" className="sr-only">
        {pending
          ? "Refreshing Inbox…"
          : manualRefresh === "success" && inbox
            ? "Inbox is up to date."
            : ""}
      </p>
      <section aria-labelledby="inbox-pending" className="ui-sheet">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <h2 className="text-sm font-semibold text-foreground" id="inbox-pending">
            Needs your attention
          </h2>
          {inbox ? (
            <nav aria-label="Inbox item type" className="mt-3 flex flex-wrap gap-2">
              {INBOX_VIEWS.map(({ label, kind: option }) => {
                const count = option
                  ? inbox.counts[option]
                  : inbox.counts.review + inbox.counts.clarification;
                return (
                  <Link
                    aria-current={kind === option ? "page" : undefined}
                    className="ui-button min-h-11 gap-2 aria-[current=page]:border-border-strong aria-[current=page]:bg-control-muted aria-[current=page]:font-semibold sm:min-h-9"
                    href={workspaceInboxPath(workspaceSlug, { ...scope, kind: option })}
                    key={label}
                    prefetch={false}
                    scroll={false}
                  >
                    {label}{" "}
                    <span className="text-xs tabular-nums text-muted">
                      {count.toLocaleString("en-US")}
                    </span>
                  </Link>
                );
              })}
            </nav>
          ) : null}
        </div>
        {unavailableFactory ? (
          <InboxScopeRecovery
            kind={kind}
            message="Factory unavailable."
            workspaceSlug={workspaceSlug}
          />
        ) : view.kind !== "ready" ? (
          <p role="status" className="px-4 py-8 text-sm text-muted sm:px-5">
            {HIDDEN_INBOX_MESSAGES[view.kind]}
          </p>
        ) : view.inbox.items.length === 0 ? (
          factoryId ? (
            <InboxScopeRecovery
              kind={kind}
              message={
                cursor
                  ? "No items on this page."
                  : kind === "review"
                    ? "No pending reviews in this factory."
                    : kind === "clarification"
                      ? "No pending clarifications in this factory."
                      : "No pending reviews or clarifications in this factory."
              }
              workspaceSlug={workspaceSlug}
            />
          ) : cursor ? (
            <p className="px-4 py-8 text-sm text-muted sm:px-5">No items on this page.</p>
          ) : (
            <div className="px-4 py-8 text-sm sm:px-5">
              <p className="font-semibold text-foreground">
                {kind === "review"
                  ? "No pending reviews."
                  : kind === "clarification"
                    ? "No pending clarifications."
                    : "You’re all caught up."}
              </p>
              <p className="mt-1 text-muted">
                Reviews and clarification requests appear here when a session needs your attention.
              </p>
              <Link className="ui-button mt-4" href={workspaceSessionsPath(workspaceSlug)}>
                View sessions
              </Link>
            </div>
          )
        ) : (
          <ul className="divide-y divide-border">
            {view.inbox.items.map((item) => (
              <InboxRow
                initialNow={initialNow}
                item={item}
                key={item.sessionId}
                returnTo={returnTo}
                workspaceSlug={workspaceSlug}
              />
            ))}
          </ul>
        )}
        {inbox && (cursor || inbox.nextCursor) ? (
          <nav
            aria-label="Inbox pages"
            className="flex flex-wrap gap-2 border-t border-border px-4 py-3 sm:px-5"
          >
            {cursor ? (
              <Link
                className="ui-button"
                href={workspaceInboxPath(workspaceSlug, scope)}
                prefetch={false}
              >
                Back to newest
              </Link>
            ) : null}
            {inbox.nextCursor ? (
              <Link
                className="ui-button"
                href={workspaceInboxPath(workspaceSlug, {
                  ...scope,
                  cursor: inbox.nextCursor,
                })}
                prefetch={false}
              >
                Next page
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </PageContainer>
  );
}

export function FactoryInboxUnavailable({
  factorySelector,
  kind,
  workspaceSlug,
}: {
  factorySelector: ReactNode;
  kind?: FactoryInboxKind;
  workspaceSlug: string;
}) {
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader actions={factorySelector} actionsRightOnDesktop title="Inbox" />
      <section aria-label="Inbox availability" className="ui-sheet">
        <InboxScopeRecovery
          kind={kind}
          message="Factory unavailable."
          workspaceSlug={workspaceSlug}
        />
      </section>
    </PageContainer>
  );
}

function InboxScopeRecovery({
  kind,
  message,
  workspaceSlug,
}: {
  kind?: FactoryInboxKind;
  message: string;
  workspaceSlug: string;
}) {
  return (
    <div className="px-4 py-8 text-sm sm:px-5">
      <p className="text-muted" role="status">
        {message}
      </p>
      <Link className="ui-button mt-4" href={workspaceInboxPath(workspaceSlug, { kind })}>
        View all factories
      </Link>
    </div>
  );
}

function InboxRow({
  initialNow,
  item,
  returnTo,
  workspaceSlug,
}: {
  initialNow: string;
  item: FactoryInboxItem;
  returnTo: string;
  workspaceSlug: string;
}) {
  const clarification = item.kind === "clarification";
  const action = clarification ? "Answer clarification" : "Open review";
  return (
    <li className="grid min-w-0 items-start gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Status
            compact
            label={clarification ? "Clarification needed" : "Awaiting review"}
            value="awaiting_review"
          />
          {item.hasBlockingFeedback ? (
            <Status compact label="Blocking feedback" value="blocked" />
          ) : null}
        </div>
        <h3 className="mt-2 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
          {item.title}
        </h3>
        <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
          {item.factoryName} · {item.stageName} · Version {item.artifactVersion}
        </p>
        <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
          {item.sourceLabel}
          {" · "}
          <TimeDisplay initialNow={initialNow} value={item.occurredAt} variant="relative" />
        </p>
      </div>
      <Link
        aria-label={`${action} for ${item.title}`}
        className="ui-button min-h-11 justify-self-start sm:min-h-9 sm:justify-self-end"
        href={workspaceSessionDetailPath(workspaceSlug, item.sessionNumber, {
          ...sessionReviewQuery(item),
          returnTo,
        })}
        prefetch={false}
      >
        {action}
      </Link>
    </li>
  );
}
