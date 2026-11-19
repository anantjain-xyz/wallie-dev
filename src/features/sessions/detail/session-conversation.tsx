"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";

import { MarkdownContent } from "@/components/shared/markdown-content";
import { TimeDisplay } from "@/components/shared/time-display";
import {
  conversationSourceHref,
  type SessionConversationMessage,
  type SessionConversationPage,
} from "@/lib/sessions/conversation-contracts";

type ConversationRequest =
  | { direction: "latest" }
  | { direction: "before" | "after"; cursor: string };

type ConversationView =
  | { status: "idle" | "unavailable"; page: null }
  | { status: "loading"; page: SessionConversationPage | null; checkingAccess: boolean }
  | {
      status: "error";
      page: SessionConversationPage | null;
      request: ConversationRequest;
      checkingAccess: boolean;
    }
  | { status: "ready"; page: SessionConversationPage };

function mergeConversationPage(
  previous: SessionConversationPage | null,
  incoming: SessionConversationPage,
  direction: ConversationRequest["direction"],
): SessionConversationPage {
  if (!previous || direction === "latest") return incoming;

  const messages = new Map(previous.messages.map((message) => [message.sequence, message]));
  for (const message of incoming.messages) messages.set(message.sequence, message);

  return {
    ...incoming,
    messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence),
    newerCursor: direction === "before" ? previous.newerCursor : incoming.newerCursor,
    olderCursor: direction === "before" ? incoming.olderCursor : previous.olderCursor,
  };
}

export function useSessionConversation(sessionId: string) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ConversationView>({ status: "idle", page: null });
  const activeRequest = useRef<AbortController | null>(null);

  async function load(initialRequest: ConversationRequest, checkingAccess: boolean) {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;

    let request = initialRequest;
    let page = view.page;
    setView({ status: "loading", page, checkingAccess });

    try {
      for (;;) {
        const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/conversation`;
        const query =
          request.direction === "latest"
            ? ""
            : `?${new URLSearchParams({ [request.direction]: request.cursor })}`;
        const response = await fetch(`${endpoint}${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) {
          setView({ status: "unavailable", page: null });
          return;
        }
        if (!response.ok) throw new Error("Conversation request failed.");

        // This same-origin endpoint only emits HTML from the canonical renderer.
        const incoming: SessionConversationPage = await response.json();
        if (controller.signal.aborted) return;
        page = mergeConversationPage(page, incoming, request.direction);
        if (request.direction !== "after" || !incoming.hasMoreNewer) {
          setView({ status: "ready", page });
          return;
        }
        if (incoming.newerCursor === request.cursor) {
          throw new Error("Conversation cursor did not advance.");
        }
        request = { direction: "after", cursor: incoming.newerCursor };
      }
    } catch {
      if (!controller.signal.aborted) setView({ status: "error", page, request, checkingAccess });
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function loadNewer() {
    const cursor = view.page?.newerCursor;
    void load(cursor ? { direction: "after", cursor } : { direction: "latest" }, true);
  }

  const handleReconnect = useEffectEvent(() => loadNewer());
  useEffect(() => {
    if (!open) return;
    const onOnline = () => handleReconnect();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [open]);
  useEffect(() => () => activeRequest.current?.abort(), []);

  return {
    open,
    view,
    toggle: () => {
      if (open) activeRequest.current?.abort();
      else loadNewer();
      setOpen(!open);
    },
    loadOlder: () => {
      const cursor = view.page?.olderCursor;
      if (cursor) void load({ direction: "before", cursor }, false);
    },
    retry: () => {
      if (view.status === "error") void load(view.request, view.checkingAccess);
    },
  };
}

const authorKinds = {
  agent: "Agent",
  service: "Service principal",
  system: "System",
  user: "User",
} satisfies Record<SessionConversationMessage["kind"], string>;

export function SessionConversationPanel({
  initialNow,
  view,
  loadOlder,
  retry,
}: Pick<ReturnType<typeof useSessionConversation>, "view" | "loadOlder" | "retry"> & {
  initialNow: string;
}) {
  const loading = view.status === "loading";
  const checkingAccess =
    (view.status === "loading" || view.status === "error") && view.checkingAccess;
  const page = checkingAccess ? null : view.page;

  return (
    <section
      aria-label="Conversation"
      aria-busy={loading}
      className="mt-3 min-w-0 space-y-3 rounded-[6px] border border-border bg-sheet p-4"
    >
      {view.status === "unavailable" ? (
        <p role="status" className="text-xs text-muted">
          Conversation unavailable.
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-xs text-muted">
          Loading conversation…
        </p>
      ) : null}
      {view.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-xs text-danger">
            Could not load the conversation.
          </p>
          <button type="button" className="ui-button min-h-9 text-xs" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}
      {page?.sources.length ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
          <span className="text-muted">Sources</span>
          <ul aria-label="Conversation sources" className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {page.sources.map((source) => {
              const href = conversationSourceHref(source.url);
              return (
                <li key={source.id} className="max-w-full [overflow-wrap:anywhere]">
                  {href ? (
                    <a
                      className="text-accent hover:underline"
                      href={href}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {source.label}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <span className="text-muted">{source.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {page?.olderCursor ? (
        <button
          type="button"
          className="ui-button min-h-9 text-xs"
          disabled={loading}
          onClick={loadOlder}
        >
          Load older messages
        </button>
      ) : null}
      {page?.messages.length ? (
        <ol aria-label="Conversation messages" className="divide-y divide-border">
          {page.messages.map((message) => (
            <li key={message.sequence} className="min-w-0 space-y-1.5 py-3 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span className="font-medium text-foreground [overflow-wrap:anywhere]">
                  {message.authorLabel}
                </span>
                {message.authorLabel !== authorKinds[message.kind] ? (
                  <span className="text-muted">{authorKinds[message.kind]}</span>
                ) : null}
                <TimeDisplay
                  absoluteStyle="short"
                  className="text-muted"
                  initialNow={initialNow}
                  value={message.createdAt}
                />
              </div>
              <MarkdownContent
                html={message.bodyHtml}
                className="min-w-0 text-sm [overflow-wrap:anywhere]"
              />
              {message.bodyTruncated ? (
                <p className="text-xs text-muted">Read the full prompt under Original request.</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : page ? (
        <p className="text-xs text-muted">No messages yet.</p>
      ) : null}
    </section>
  );
}
