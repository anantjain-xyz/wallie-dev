"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { useRealtimeRecovery } from "@/features/wallie/realtime-recovery-context";
import {
  factoryInboxSchema,
  type FactoryInbox,
  type FactoryInboxItem,
} from "@/lib/factories/inbox-schema";
import { workspaceInboxPath } from "@/lib/routes";
import { exactSessionReviewHref } from "@/lib/sessions/review-link";
import {
  loadSupabaseBrowserClient,
  subscribeDeferredAuthenticatedChannel,
} from "@/lib/supabase/deferred-browser";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";

const ACCESS_RECHECK_MS = 30_000;

export function FactoryInboxPage({
  cursor,
  factoryId,
  initialInbox,
  initialNow,
  memberId,
  workspaceId,
  workspaceSlug,
}: {
  cursor: string | null;
  factoryId: string | null;
  initialInbox: FactoryInbox | null;
  initialNow: string;
  memberId: string;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const config = useSupabasePublicConfig();
  const { recovery } = useRealtimeRecovery();
  const [inbox, setInbox] = useState(initialInbox);

  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    let lastVerifiedAt = Date.parse(initialNow);
    const query = new URLSearchParams({ workspaceId });
    if (factoryId) query.set("factoryId", factoryId);
    if (cursor) query.set("cursor", cursor);

    const key = `factory-inbox:${workspaceId}:${factoryId ?? "all"}`;
    const filter = factoryId ? `factory_id=eq.${factoryId}` : `workspace_id=eq.${workspaceId}`;
    const unregister = recovery.register({
      key,
      role: "page",
      required: true,
      async refresh(signal) {
        const request = ++requestSequence;
        const isCurrent = () => active && request === requestSequence;
        const clearIfCurrent = () => {
          if (isCurrent()) setInbox(null);
        };
        signal.addEventListener("abort", clearIfCurrent, { once: true });
        try {
          const response = await fetch(`/api/factories/inbox?${query}`, {
            cache: "no-store",
            signal,
          });
          if (!response.ok) throw new Error("Inbox unavailable.");
          const verified = factoryInboxSchema.parse(await response.json());
          if (isCurrent() && !signal.aborted) {
            lastVerifiedAt = Date.now();
            setInbox(verified);
          }
        } catch (error) {
          clearIfCurrent();
          throw error;
        } finally {
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
                  hideSnapshot();
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
      if (Date.now() - lastVerifiedAt >= ACCESS_RECHECK_MS) hideSnapshot();
      recovery.invalidate();
    }
    function hideSnapshot() {
      requestSequence++;
      setInbox(null);
    }
    const interval = window.setInterval(recheck, ACCESS_RECHECK_MS);
    window.addEventListener("focus", recheck);
    window.addEventListener("offline", hideSnapshot);
    document.addEventListener("visibilitychange", recheck);
    recovery.invalidate();
    return () => {
      active = false;
      unregister();
      window.clearInterval(interval);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("offline", hideSnapshot);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [config, cursor, factoryId, initialNow, memberId, recovery, workspaceId]);

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        actions={
          <button className="ui-button" onClick={() => recovery.retry()} type="button">
            Refresh
          </button>
        }
        actionsRightOnDesktop
        title="Inbox"
      />
      <section aria-labelledby="inbox-pending" className="ui-sheet">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <h2 className="text-sm font-semibold text-foreground" id="inbox-pending">
            Needs your attention
          </h2>
          {inbox ? (
            <p aria-live="polite" className="mt-1 text-xs text-muted">
              {inbox.counts.review.toLocaleString("en-US")} awaiting review
              {" · "}
              {inbox.counts.clarification.toLocaleString("en-US")}{" "}
              {inbox.counts.clarification === 1 ? "clarification" : "clarifications"}
            </p>
          ) : null}
        </div>
        {!inbox ? (
          <p role="status" className="px-4 py-8 text-sm text-muted sm:px-5">
            Inbox unavailable. Refresh to check your access.
          </p>
        ) : inbox.items.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted sm:px-5">
            {cursor ? "No items on this page." : "You’re all caught up."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {inbox.items.map((item) => (
              <InboxRow
                initialNow={initialNow}
                item={item}
                key={item.sessionId}
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
                href={workspaceInboxPath(workspaceSlug, { factory: factoryId ?? undefined })}
                prefetch={false}
              >
                Back to newest
              </Link>
            ) : null}
            {inbox.nextCursor ? (
              <Link
                className="ui-button"
                href={workspaceInboxPath(workspaceSlug, {
                  cursor: inbox.nextCursor,
                  factory: factoryId ?? undefined,
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

function InboxRow({
  initialNow,
  item,
  workspaceSlug,
}: {
  initialNow: string;
  item: FactoryInboxItem;
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
        href={exactSessionReviewHref(workspaceSlug, item.sessionNumber, item)}
        prefetch={false}
      >
        {action}
      </Link>
    </li>
  );
}
