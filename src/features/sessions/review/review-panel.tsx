"use client";

import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PencilIcon } from "@/components/shared/icons/pencil-icon";
import { XIcon } from "@/components/shared/icons/x-icon";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";
import { cn } from "@/lib/utils";

import type { ArtifactSourceAnchor } from "./source-anchor";
import {
  reviewReadOnlyMessage,
  type ReviewReadOnlyReason,
  type ReviewSessionReadOnlyReason,
} from "./comment-access";
import { subscribeArtifactFeedbackSubmissions } from "./submission-events";
import type {
  ArtifactReviewComment,
  ArtifactReviewThread,
  ReviewCommentListPayload,
  ReviewCursor,
  ReviewThreadListPayload,
} from "./types";

export type ArtifactReviewPanelProps = {
  sessionId: string;
  artifactId: string;
  artifactVersion: number;
  initialThreadId?: string;
  sourceSelectionRevision?: number;
  panelId?: string;
  syncLocation?: boolean;
  historical: boolean;
  readOnlyReason?: ReviewSessionReadOnlyReason | null;
  anchor: ArtifactSourceAnchor | null;
  onClearAnchor: () => void;
  onClose?: () => void;
  openerRef?: RefObject<HTMLElement | null>;
  inline?: {
    open: boolean;
    scrollRef: RefObject<HTMLDivElement | null>;
    request: PassageThreadRequest | null;
    onRevealThread: (thread: ArtifactReviewThread) => void;
    onClearPassage: () => void;
    onThreadsChange: (snapshot: Pick<ReviewThreadListPayload, "threads" | "counts">) => void;
    onReadOnlyReasonChange: (reason: ReviewReadOnlyReason | null) => void;
    passageMessage: string | null;
  };
};

export type PassageThreadRequest =
  | { kind: "thread"; thread: ArtifactReviewThread }
  | { kind: "passage"; ids: string[] };

type LoadedReviewSnapshot = ReviewThreadListPayload & { knownCoverageIds: Set<string> };

const buttonClass =
  "min-h-11 rounded-[4px] border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-control-muted disabled:cursor-wait disabled:opacity-60";
const fieldClass =
  "w-full rounded-[4px] border border-border bg-surface px-3 py-2 text-sm text-foreground";
const inlineLinkClass =
  "inline-flex min-h-11 items-center text-xs font-medium text-accent hover:underline";

function pageQuery(cursor: ReviewCursor | null): string {
  const params = new URLSearchParams();
  if (cursor) {
    params.set("cursorCreatedAt", cursor.createdAt);
    params.set("cursorId", cursor.id);
  }
  return params.toString();
}

class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function reviewRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new ReviewRequestError(
      payload?.error ?? "Could not save review. Your draft is retained.",
      response.status,
    );
  if (!payload) throw new Error("Review response was empty. Please retry.");
  return payload as T;
}

function mergeRows<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const result = new Map(previous.map((row) => [row.id, row]));
  for (const row of incoming) result.set(row.id, row);
  return [...result.values()];
}

function threadQuote(thread: ArtifactReviewThread): string {
  const anchor = thread.anchor;
  return anchor &&
    typeof anchor === "object" &&
    !Array.isArray(anchor) &&
    typeof anchor.quote === "string"
    ? anchor.quote
    : "Artifact text";
}

function initialThreadId(): string | null {
  return typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("reviewThread");
}

/** One exact artifact's review surface. Drafts never depend on realtime snapshots. */
export function ArtifactReviewPanel({
  sessionId,
  artifactId,
  artifactVersion,
  initialThreadId: initialSelectionId,
  sourceSelectionRevision,
  panelId = "artifact-review-panel",
  syncLocation = true,
  historical,
  readOnlyReason: parentReadOnlyReason = null,
  anchor,
  onClearAnchor,
  onClose,
  openerRef,
  inline,
}: ArtifactReviewPanelProps) {
  const baseUrl = `/api/sessions/${sessionId}/reviews`;
  const headingId = useId();
  const composerId = useId();
  const replyId = useId();
  const reasonId = useId();
  const [snapshot, setSnapshot] = useState<LoadedReviewSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initialSelectionId ?? initialThreadId(),
  );
  const [comments, setComments] = useState<ArtifactReviewComment[]>([]);
  const [commentCursor, setCommentCursor] = useState<ReviewCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState<string | null>(null);
  const [commentLoadError, setCommentLoadError] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<ReviewReadOnlyReason | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"discussion" | "blocking">("discussion");
  const [reply, setReply] = useState("");
  const [editingTarget, setEditingTarget] = useState<{ id: string; revision: number } | null>(null);
  const editingId = editingTarget?.id ?? null;
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [threadFilter, setThreadFilter] = useState<"open" | "closed">("open");
  const [passageThreadIds, setPassageThreadIds] = useState<string[] | null>(null);
  const inFlight = useRef(false);
  const requestMemory = useRef(new Map<string, Record<string, unknown>>());
  const threadDrafts = useRef(
    new Map<
      string,
      { reply: string; editingTarget: { id: string; revision: number } | null; reason: string }
    >(),
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const selectedRef = useRef(selectedId);
  const focusReplyAfterSave = useRef(false);
  const mounted = useRef(true);
  const threadLoadSequence = useRef(0);
  const fullThreadRefreshInFlight = useRef(false);
  const commentLoadSequence = useRef(0);
  const config = useSupabasePublicConfig();
  selectedRef.current = selectedId;
  const selectedThread = snapshot?.threads.find((thread) => thread.id === selectedId) ?? null;
  const loadError = threadLoadError ?? commentLoadError;
  const readOnlyReason =
    parentReadOnlyReason ??
    permissionError ??
    (snapshot ? snapshot.viewer.readOnlyReason : "loading");
  const readOnly = readOnlyReason !== null;
  const inlineOpen = inline?.open;
  const scrollRef = inline?.scrollRef;
  const onRevealThread = inline?.onRevealThread;
  const onClearPassage = inline?.onClearPassage;
  const onThreadsChange = inline?.onThreadsChange;
  const onReadOnlyReasonChange = inline?.onReadOnlyReasonChange;
  const threadRequest = inline?.request;
  const composing = Boolean(anchor && !readOnly);
  const showThreadList = !inline || (!composing && !selectedId);
  const readingThread = inline && selectedId && !composing;

  useEffect(() => {
    if (snapshot) onThreadsChange?.(snapshot);
  }, [onThreadsChange, snapshot]);

  useLayoutEffect(() => {
    onReadOnlyReasonChange?.(readOnlyReason);
  }, [onReadOnlyReasonChange, readOnlyReason]);

  useLayoutEffect(() => {
    if (inlineOpen && scrollRef?.current) scrollRef.current.scrollTop = 0;
  }, [anchor, inlineOpen, scrollRef, selectedId]);

  useEffect(() => {
    if (inlineOpen && !composing) headingRef.current?.focus({ preventScroll: true });
  }, [composing, inlineOpen, selectedId]);

  const lastRevealedThread = useRef<string | null>(null);
  useEffect(() => {
    if (!inlineOpen || !selectedThread || composing) {
      lastRevealedThread.current = null;
      return;
    }
    if (lastRevealedThread.current !== selectedThread.id) {
      lastRevealedThread.current = selectedThread.id;
      onRevealThread?.(selectedThread);
    }
  }, [composing, inlineOpen, onRevealThread, selectedThread]);

  const loadThreads = useCallback(
    async (cursor: ReviewCursor | null = null) => {
      // A later page cannot supersede the accepted-receipt refresh of earlier
      // coverage, even before React renders the disabled pagination control.
      if (cursor && fullThreadRefreshInFlight.current) return;
      if (!cursor) {
        fullThreadRefreshInFlight.current = true;
        setLoading(true);
      }
      const sequence = ++threadLoadSequence.current;
      try {
        const params = new URLSearchParams(pageQuery(cursor));
        params.set("artifactId", artifactId);
        const next = await reviewRequest<ReviewThreadListPayload>(`${baseUrl}?${params}`);
        const knownCoverageIds = new Set(next.threads.map((thread) => thread.id));
        const selected = selectedRef.current;
        let linkedThreadError: string | null = null;
        if (selected && !next.threads.some((thread) => thread.id === selected)) {
          try {
            const exact = await reviewRequest<{
              thread: ArtifactReviewThread;
              submittedThreadRevision?: number | null;
            }>(`${baseUrl}/${encodeURIComponent(selected)}`);
            if (exact.thread.artifact_id === artifactId) {
              next.threads = mergeRows(next.threads, [exact.thread]);
              if (exact.submittedThreadRevision === null) knownCoverageIds.add(exact.thread.id);
              else if (
                typeof exact.submittedThreadRevision === "number" &&
                Number.isSafeInteger(exact.submittedThreadRevision) &&
                exact.submittedThreadRevision > 0
              ) {
                knownCoverageIds.add(exact.thread.id);
                next.submittedThreadRevisions = {
                  ...next.submittedThreadRevisions,
                  [exact.thread.id]: exact.submittedThreadRevision,
                };
              }
            }
          } catch {
            linkedThreadError = "The linked thread is unavailable. Other comments are shown below.";
          }
        }
        if (!mounted.current || sequence !== threadLoadSequence.current) return;
        setSnapshot((current) => ({
          ...next,
          knownCoverageIds:
            cursor && current
              ? new Set([...current.knownCoverageIds, ...knownCoverageIds])
              : knownCoverageIds,
          threads: cursor && current ? mergeRows(current.threads, next.threads) : next.threads,
          submittedThreadRevisions:
            cursor && current
              ? { ...current.submittedThreadRevisions, ...next.submittedThreadRevisions }
              : next.submittedThreadRevisions,
        }));
        setThreadLoadError(linkedThreadError);
        setPermissionError(null);
      } catch (error) {
        if (mounted.current && sequence === threadLoadSequence.current) {
          setThreadLoadError(
            error instanceof Error ? error.message : "Could not load review threads.",
          );
          setPermissionError(
            error instanceof ReviewRequestError && [401, 403].includes(error.status)
              ? "unauthorized"
              : "unavailable",
          );
        }
      } finally {
        if (mounted.current && sequence === threadLoadSequence.current) {
          if (!cursor) fullThreadRefreshInFlight.current = false;
          setLoading(false);
        }
      }
    },
    [artifactId, baseUrl],
  );

  const loadComments = useCallback(
    async (threadId: string, cursor: ReviewCursor | null = null) => {
      const sequence = ++commentLoadSequence.current;
      setCommentsLoading(true);
      try {
        const next = await reviewRequest<ReviewCommentListPayload>(
          `${baseUrl}/${encodeURIComponent(threadId)}/comments?${pageQuery(cursor)}`,
        );
        if (
          !mounted.current ||
          sequence !== commentLoadSequence.current ||
          selectedRef.current !== threadId
        )
          return;
        setComments((current) => (cursor ? mergeRows(current, next.comments) : next.comments));
        setCommentCursor(next.nextCursor);
        setCommentLoadError(null);
        return next.comments;
      } catch (error) {
        if (
          mounted.current &&
          sequence === commentLoadSequence.current &&
          selectedRef.current === threadId
        )
          setCommentLoadError(error instanceof Error ? error.message : "Could not load comments.");
      } finally {
        if (mounted.current && sequence === commentLoadSequence.current) setCommentsLoading(false);
      }
    },
    [baseUrl],
  );

  useEffect(() => {
    mounted.current = true;
    void loadThreads();
    return () => {
      mounted.current = false;
    };
  }, [loadThreads]);

  useEffect(() => {
    if (selectedId) void loadComments(selectedId);
  }, [loadComments, selectedId]);

  useEffect(
    () =>
      subscribeArtifactFeedbackSubmissions({ sessionId, artifactId }, () => {
        setSnapshot((current) => (current ? { ...current, knownCoverageIds: new Set() } : current));
        void loadThreads();
      }),
    [artifactId, loadThreads, sessionId],
  );

  useEffect(() => {
    if (anchor && !readOnly && inlineOpen !== false) {
      composerRef.current?.focus({ preventScroll: inlineOpen === true });
    }
  }, [anchor, inlineOpen, readOnly]);

  useEffect(() => {
    if (selectedThread && focusReplyAfterSave.current) {
      replyRef.current?.focus();
      focusReplyAfterSave.current = false;
    }
  }, [selectedThread]);

  useEffect(() => {
    if (!config) return;
    const supabase = createSupabaseBrowserClient(config);
    function refresh() {
      void loadThreads();
      if (selectedRef.current) void loadComments(selectedRef.current);
    }
    const channel = supabase
      .channel(`artifact-review:${sessionId}:${artifactId}:${panelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "artifact_review_threads",
          filter: `session_id=eq.${sessionId}`,
        },
        refresh,
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") refresh();
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [artifactId, config, loadComments, loadThreads, panelId, sessionId]);

  const chooseThreadId = useCallback(
    (threadId: string | null) => {
      if (inFlight.current || threadId === selectedId) return;
      if (selectedId) threadDrafts.current.set(selectedId, { reply, editingTarget, reason });
      const draft = threadId ? threadDrafts.current.get(threadId) : undefined;
      selectedRef.current = threadId;
      setSelectedId(threadId);
      setComments([]);
      setCommentCursor(null);
      setCommentLoadError(null);
      setEditingTarget(draft?.editingTarget ?? null);
      setReply(draft?.reply ?? "");
      setReason(draft?.reason ?? "");
      setSaveError(null);
      if (syncLocation) {
        const url = new URL(window.location.href);
        if (threadId) {
          url.searchParams.set("reviewThread", threadId);
          url.searchParams.set("artifactId", artifactId);
          url.searchParams.set("artifactVersion", String(artifactVersion));
        } else {
          url.searchParams.delete("reviewThread");
        }
        window.history.replaceState(window.history.state, "", url);
      }
    },
    [artifactId, artifactVersion, editingTarget, reason, reply, selectedId, syncLocation],
  );

  const handledSourceSelection = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (
      !initialSelectionId ||
      sourceSelectionRevision === undefined ||
      handledSourceSelection.current === sourceSelectionRevision ||
      pending
    )
      return;
    chooseThreadId(initialSelectionId);
    handledSourceSelection.current = sourceSelectionRevision;
    // The requested blocker can be outside the first page after a Realtime reload.
    void loadThreads();
  }, [chooseThreadId, initialSelectionId, loadThreads, pending, sourceSelectionRevision]);

  const handledThreadRequest = useRef<PassageThreadRequest | null>(null);
  useEffect(() => {
    if (!threadRequest || handledThreadRequest.current === threadRequest || pending) return;
    handledThreadRequest.current = threadRequest;
    if (threadRequest.kind === "passage") {
      setPassageThreadIds(threadRequest.ids);
      chooseThreadId(null);
      onClearPassage?.();
    } else {
      setPassageThreadIds(null);
      chooseThreadId(threadRequest.thread.id);
      if (selectedId === threadRequest.thread.id) onRevealThread?.(threadRequest.thread);
    }
  }, [chooseThreadId, onClearPassage, onRevealThread, pending, selectedId, threadRequest]);

  function chooseThread(thread: ArtifactReviewThread) {
    if (inline && thread.id === selectedId && !pending) onRevealThread?.(thread);
    chooseThreadId(thread.id);
  }

  function showAllThreads() {
    setPassageThreadIds(null);
    if (selectedThread) setThreadFilter(selectedThread.status === "open" ? "open" : "closed");
    chooseThreadId(null);
    onClearPassage?.();
    headingRef.current?.focus({ preventScroll: true });
  }

  async function mutate<T>(
    url: string,
    method: "POST" | "PATCH",
    payload: Record<string, unknown>,
    fingerprint: string,
  ): Promise<T | null> {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(true);
    setSaveError(null);
    if (!requestMemory.current.has(fingerprint)) {
      requestMemory.current.set(fingerprint, { ...payload, requestId: crypto.randomUUID() });
    }
    try {
      const result = await reviewRequest<T>(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestMemory.current.get(fingerprint)),
      });
      if (!mounted.current) return null;
      requestMemory.current.delete(fingerprint);
      return result;
    } catch (error) {
      let message =
        error instanceof Error ? error.message : "Could not save review. Your draft is retained.";
      if (error instanceof ReviewRequestError && error.status >= 400 && error.status < 500) {
        // The server rejected this intent. Keep the prose but refresh its CAS
        // revision before a fresh request. Network/5xx retries keep their key.
        requestMemory.current.delete(fingerprint);
        const [, refreshedComments] = await Promise.all([
          loadThreads(),
          selectedRef.current ? loadComments(selectedRef.current) : Promise.resolve(undefined),
        ]);
        let refreshedTarget = refreshedComments?.find(
          (comment) => comment.id === payload.commentId,
        );
        // The edit may have started on a later page. Its current revision must
        // come from an exact lookup, not whichever page realtime just loaded.
        if (typeof payload.commentId === "string" && selectedRef.current) {
          try {
            const exact = await reviewRequest<ReviewCommentListPayload>(
              `${baseUrl}/${encodeURIComponent(selectedRef.current)}/comments?${new URLSearchParams({ commentId: payload.commentId })}`,
            );
            refreshedTarget = exact.comments.find((comment) => comment.id === payload.commentId);
            if (!refreshedTarget)
              message =
                "This comment is unavailable. Your edit is retained; cancel it to choose another comment.";
          } catch {
            refreshedTarget = undefined;
            message =
              "Could not refresh this comment. Your edit is retained. Retry the save to refresh it again.";
          }
        }
        if (refreshedTarget && mounted.current) {
          const target = refreshedTarget;
          setEditingTarget({ id: target.id, revision: target.revision });
          setComments((current) => mergeRows(current, [target]));
        }
      }
      if (mounted.current) setSaveError(message);
      return null;
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function submitThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!anchor || readOnly || !body.trim()) return;
    const payload = { artifactId, artifactVersion, anchor, kind, body };
    const result = await mutate<{ thread: ArtifactReviewThread }>(
      baseUrl,
      "POST",
      payload,
      JSON.stringify(payload),
    );
    if (!result) return;
    focusReplyAfterSave.current = true;
    setBody("");
    setKind("discussion");
    onClearAnchor();
    setSnapshot((current) =>
      current ? { ...current, threads: mergeRows(current.threads, [result.thread]) } : current,
    );
    chooseThread(result.thread);
    setAnnouncement("Comment saved. No agent execution was started.");
    void loadThreads();
    queueMicrotask(() => replyRef.current?.focus());
  }

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedThread || readOnly || !reply.trim()) return;
    const edited = editingTarget;
    const payload = edited
      ? { body: reply, commentId: edited.id, expectedRevision: edited.revision }
      : { body: reply };
    const result = await mutate<{ comment: ArtifactReviewComment }>(
      `${baseUrl}/${selectedThread.id}/comments`,
      edited ? "PATCH" : "POST",
      payload,
      JSON.stringify({ threadId: selectedThread.id, editingId, body: reply }),
    );
    if (!result) return;
    // An older in-flight comment page cannot replace this acknowledged save.
    commentLoadSequence.current += 1;
    setCommentsLoading(false);
    setComments((current) => mergeRows(current, [result.comment]));
    setReply("");
    setEditingTarget(null);
    threadDrafts.current.delete(selectedThread.id);
    setAnnouncement(edited ? "Comment updated." : "Reply saved.");
    void loadThreads();
    queueMicrotask(() => replyRef.current?.focus());
  }

  async function transition(status: "open" | "resolved" | "superseded") {
    if (!selectedThread || readOnly || !reason.trim()) return;
    const payload = { expectedRevision: selectedThread.revision, status, reason };
    const result = await mutate<{ thread: ArtifactReviewThread }>(
      `${baseUrl}/${selectedThread.id}`,
      "PATCH",
      payload,
      JSON.stringify({ threadId: selectedThread.id, status, reason }),
    );
    if (!result) return;
    setSnapshot((current) =>
      current ? { ...current, threads: mergeRows(current.threads, [result.thread]) } : current,
    );
    setReason("");
    setAnnouncement(status === "open" ? "Thread reopened." : `Thread ${status}.`);
    void loadThreads();
  }

  const canTransition =
    !readOnly &&
    selectedThread &&
    (snapshot?.viewer.canReview ||
      (selectedThread.kind === "discussion" &&
        selectedThread.author_member_id === snapshot?.viewer.memberId));
  const compactReply = Boolean(inline && !editingId);
  const visibleThreads = snapshot?.threads.filter((thread) => {
    if (!inline) return true;
    if (passageThreadIds) return passageThreadIds.includes(thread.id);
    return (thread.status === "open") === (threadFilter === "open");
  });

  return (
    <aside
      aria-labelledby={headingId}
      id={panelId}
      className={cn(
        "min-w-0 bg-surface p-3 sm:p-4",
        !inline && "rounded-[6px] border border-border",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2",
          inline &&
            "sticky top-0 z-10 -mx-3 -mt-3 mb-3 border-b border-border bg-surface px-3 py-2 sm:-mx-4 sm:-mt-4 sm:px-4",
        )}
      >
        <div>
          <h4
            className={cn(
              "text-sm font-semibold text-foreground",
              inline && "focus:outline-none",
              readingThread && "sr-only",
            )}
            id={headingId}
            ref={headingRef}
            tabIndex={inline ? -1 : undefined}
          >
            Comments <span className="text-muted">({snapshot?.counts.total ?? "…"})</span>
          </h4>
          {readingThread ? (
            <div className="flex flex-wrap items-center gap-x-2">
              <button
                className={inlineLinkClass}
                disabled={pending}
                onClick={showAllThreads}
                type="button"
              >
                <span aria-hidden="true" className="mr-1.5">
                  ←
                </span>{" "}
                All threads
              </button>
              <span className="text-xs text-muted">
                v{artifactVersion}
                {historical ? " · Historical artifact" : ""}
              </span>
            </div>
          ) : inline ? (
            <p className="text-xs text-muted">
              Version {artifactVersion}
              {historical ? " · Historical artifact" : ""}
            </p>
          ) : null}
        </div>
        {onClose ? (
          <button
            aria-label="Close comments"
            className={
              inline
                ? "flex size-11 shrink-0 items-center justify-center rounded-[4px] border border-border text-muted hover:bg-control-muted"
                : buttonClass
            }
            onClick={() => {
              onClose();
              if (!inline) queueMicrotask(() => openerRef?.current?.focus());
            }}
            type="button"
          >
            {inline ? <XIcon className="size-4" /> : "Close comments"}
          </button>
        ) : null}
      </div>
      {!inline ? (
        <p className="mt-1 text-xs text-muted">
          Version {artifactVersion}
          {historical ? " · Historical artifact" : ""}
        </p>
      ) : null}
      {snapshot && showThreadList ? (
        <p className="mt-1 text-xs text-muted">
          {snapshot.counts.open} open · {snapshot.counts.blocking} blocking requests
        </p>
      ) : null}
      {readOnlyReason ? (
        <p className="mt-3 rounded-[4px] bg-control-muted p-2 text-xs text-muted">
          {reviewReadOnlyMessage(readOnlyReason)}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
      {loading ? (
        <p className="mt-3 text-xs text-muted" role="status">
          Loading comments…
        </p>
      ) : null}
      {loadError ? (
        <div className="mt-3 text-xs text-danger" role="alert">
          {loadError}{" "}
          <button
            className={buttonClass}
            onClick={() => {
              void loadThreads();
              if (selectedId) void loadComments(selectedId);
            }}
            type="button"
          >
            Retry loading
          </button>
        </div>
      ) : null}
      {saveError ? (
        <p className="mt-3 text-xs text-danger" role="alert">
          {saveError} Your draft is retained. Retry the same save.
        </p>
      ) : null}
      {anchor && !readOnly ? (
        <form
          className={cn("space-y-3", inline ? "" : "mt-4 border-b border-border pb-4")}
          onSubmit={(event) => {
            void submitThread(event);
          }}
        >
          <p className="text-xs font-semibold text-foreground">New comment on selected text</p>
          <blockquote
            tabIndex={0}
            className="max-h-36 overflow-auto whitespace-pre-wrap break-words border-l-2 border-accent pl-2 text-xs text-muted"
          >
            {anchor.quote}
          </blockquote>
          <label className="block text-xs text-muted" htmlFor={`${composerId}-kind`}>
            Comment type
          </label>
          <select
            className={cn(fieldClass, "min-h-11", inline && "max-lg:text-base")}
            disabled={pending}
            id={`${composerId}-kind`}
            onChange={(event) =>
              setKind(event.target.value === "blocking" ? "blocking" : "discussion")
            }
            value={kind}
          >
            <option value="discussion">Discussion</option>
            <option value="blocking">Blocking request</option>
          </select>
          {inline && kind === "blocking" ? (
            <p className="text-xs text-warning">
              This request blocks approval until a reviewer closes it.
            </p>
          ) : null}
          <label className="block text-xs text-muted" htmlFor={composerId}>
            Comment
          </label>
          <textarea
            ref={composerRef}
            className={cn(fieldClass, inline && "max-lg:text-base")}
            disabled={pending}
            id={composerId}
            maxLength={10000}
            onChange={(event) => setBody(event.target.value)}
            required
            rows={4}
            value={body}
          />
          <div className="flex flex-wrap gap-2">
            <button
              aria-busy={pending}
              className={cn(buttonClass, "border-accent bg-accent-soft text-accent")}
              disabled={pending || !body.trim()}
              type="submit"
            >
              <ActionButtonLabel idle="Save comment" pending={pending} pendingLabel="Saving…" />
            </button>
            <button
              className={buttonClass}
              disabled={pending}
              onClick={() => {
                onClearAnchor();
                setBody("");
                setKind("discussion");
                openerRef?.current?.focus();
              }}
              type="button"
            >
              Cancel new comment
            </button>
          </div>
        </form>
      ) : !inline && !readOnly && snapshot ? (
        <p className="mt-3 text-xs text-muted">
          Select artifact text or use “Comment on a block” to start a thread.
        </p>
      ) : null}
      {inline && showThreadList && snapshot ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {passageThreadIds ? (
            <>
              <button
                className={buttonClass}
                disabled={pending}
                onClick={showAllThreads}
                type="button"
              >
                All threads
              </button>
              <span className="text-xs text-muted">Threads on this passage</span>
            </>
          ) : (
            (["open", "closed"] as const).map((filter) => (
              <button
                className={cn(
                  buttonClass,
                  filter === threadFilter && "border-accent bg-accent-soft text-accent",
                )}
                key={filter}
                aria-pressed={filter === threadFilter}
                onClick={() => setThreadFilter(filter)}
                type="button"
              >
                {filter === "open"
                  ? `Open ${snapshot.counts.open}`
                  : `Closed ${snapshot.counts.total - snapshot.counts.open}`}
              </button>
            ))
          )}
        </div>
      ) : null}
      {showThreadList && snapshot?.threads.length === 0 ? (
        <p className="mt-4 text-xs text-muted">No comments on this artifact yet.</p>
      ) : null}
      {inline &&
      showThreadList &&
      snapshot &&
      snapshot.threads.length > 0 &&
      !visibleThreads?.length &&
      !loading ? (
        <p className="mt-4 text-xs text-muted">
          {snapshot.nextCursor
            ? "No matching threads on this page."
            : `No ${threadFilter} threads.`}
        </p>
      ) : null}
      {showThreadList && snapshot ? (
        <ul aria-label="Artifact review threads" className="mt-4 space-y-2">
          {visibleThreads?.map((thread) => (
            <li key={thread.id}>
              <button
                aria-current={selectedId === thread.id ? "true" : undefined}
                disabled={pending}
                className={cn(
                  "min-h-11 w-full rounded-[4px] border p-2 text-left",
                  selectedId === thread.id
                    ? "border-accent bg-accent-soft"
                    : "border-border hover:bg-control-muted",
                )}
                onClick={() => chooseThread(thread)}
                type="button"
              >
                <span className="block text-xs font-semibold text-foreground">
                  {thread.kind === "blocking" ? "Blocking request" : "Discussion"} · {thread.status}
                </span>
                <span className="mt-1 line-clamp-2 block whitespace-pre-wrap break-words text-xs text-muted">
                  {threadQuote(thread)}
                </span>
                <span className="mt-1 block text-xs text-muted">{thread.author_label}</span>
                <span className="mt-1 block text-xs text-muted">
                  {!snapshot.knownCoverageIds.has(thread.id)
                    ? "Submission status unavailable"
                    : snapshot.submittedThreadRevisions?.[thread.id] === undefined
                      ? "Not submitted"
                      : snapshot.submittedThreadRevisions[thread.id] < thread.revision
                        ? "Unsent changes"
                        : "Submitted"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {showThreadList && !passageThreadIds && snapshot?.nextCursor ? (
        <button
          className={cn(buttonClass, "mt-3")}
          disabled={loading || pending}
          onClick={() => {
            void loadThreads(snapshot.nextCursor);
          }}
          type="button"
        >
          Load more threads
        </button>
      ) : null}
      {selectedId && !selectedThread && snapshot && !snapshot.nextCursor ? (
        <p className="mt-3 text-xs text-muted">This thread is unavailable on this artifact.</p>
      ) : null}
      {selectedThread && (!inline || !composing) ? (
        <section
          aria-label="Selected review thread"
          className={cn("space-y-3", !inline && "mt-4 border-t border-border pt-4")}
        >
          <div
            className={cn("flex flex-wrap items-center justify-between gap-2", inline && "gap-y-0")}
          >
            <h5
              className={cn(
                "text-xs font-semibold text-foreground",
                inline && "rounded-[4px] bg-control-muted px-1.5 py-0.5",
                inline &&
                  selectedThread.kind === "blocking" &&
                  selectedThread.status === "open" &&
                  "bg-warning-soft text-warning",
              )}
            >
              {inline
                ? selectedThread.kind === "blocking"
                  ? "Blocking request"
                  : "Discussion"
                : "Thread"}{" "}
              · {selectedThread.status}
            </h5>
            {onRevealThread ? (
              <button
                className={inlineLinkClass}
                onClick={() => onRevealThread(selectedThread)}
                type="button"
              >
                Jump to passage
              </button>
            ) : null}
            <a
              className={inline ? inlineLinkClass : cn(buttonClass, "inline-flex items-center")}
              href={`?${new URLSearchParams({ ...(typeof window === "undefined" ? {} : Object.fromEntries(new URLSearchParams(window.location.search))), artifactId, artifactStage: selectedThread.stage_slug, artifactVersion: String(artifactVersion), reviewThread: selectedThread.id })}`}
            >
              Thread link
            </a>
          </div>
          {inline?.passageMessage ? (
            <p className="text-xs text-muted" role="status">
              {inline.passageMessage}
            </p>
          ) : null}
          <blockquote
            tabIndex={0}
            className={cn(
              "max-h-36 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs text-muted",
              inline && "max-h-24 border-accent bg-accent-soft p-2 text-foreground",
            )}
          >
            {threadQuote(selectedThread)}
          </blockquote>
          {commentsLoading ? (
            <p className="text-xs text-muted" role="status">
              Loading thread…
            </p>
          ) : null}
          <ol aria-label="Thread comments" className="space-y-3">
            {comments.map((comment) => (
              <li
                className={cn(
                  "min-w-0",
                  inline && "flex flex-wrap items-center justify-between gap-x-2",
                )}
                key={comment.id}
              >
                <p className="text-xs font-semibold text-foreground">
                  {comment.author_label}
                  {comment.revision > 1 ? (
                    <span className="font-normal text-muted"> · Edited</span>
                  ) : null}
                </p>
                <p
                  className={cn(
                    "mt-1 whitespace-pre-wrap break-words text-sm text-foreground",
                    inline && "order-last mt-0 w-full",
                  )}
                >
                  {comment.body}
                </p>
                {!readOnly && comment.author_member_id === snapshot?.viewer.memberId ? (
                  <button
                    aria-label="Edit comment"
                    className={
                      inline
                        ? "flex size-11 items-center justify-center rounded-[4px] text-muted hover:bg-control-muted"
                        : cn(buttonClass, "mt-1")
                    }
                    disabled={pending}
                    onClick={() => {
                      setEditingTarget({ id: comment.id, revision: comment.revision });
                      setReply(comment.body);
                      setSaveError(null);
                      replyRef.current?.focus();
                    }}
                    type="button"
                  >
                    {inline ? <PencilIcon className="size-3.5" /> : "Edit comment"}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {commentCursor ? (
            <button
              className={buttonClass}
              onClick={() => {
                void loadComments(selectedThread.id, commentCursor);
              }}
              type="button"
            >
              Load more comments
            </button>
          ) : null}
          {!readOnly ? (
            <form
              className={cn(
                "space-y-2",
                compactReply && "grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 space-y-0",
              )}
              onSubmit={(event) => {
                void submitReply(event);
              }}
            >
              <label
                className={cn("block text-xs text-muted", compactReply && "col-span-2")}
                htmlFor={replyId}
              >
                {editingId ? "Edit your comment" : "Reply to thread"}
              </label>
              <textarea
                ref={replyRef}
                className={cn(fieldClass, inline && "max-lg:text-base")}
                disabled={pending}
                id={replyId}
                maxLength={10000}
                onChange={(event) => setReply(event.target.value)}
                required
                rows={inline ? 2 : 3}
                value={reply}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  aria-busy={pending}
                  className={buttonClass}
                  disabled={pending || !reply.trim()}
                  type="submit"
                >
                  {pending ? "Saving…" : editingId ? "Save edit" : "Save reply"}
                </button>
                {editingId ? (
                  <button
                    className={buttonClass}
                    disabled={pending}
                    onClick={() => {
                      setEditingTarget(null);
                      setReply("");
                      replyRef.current?.focus();
                    }}
                    type="button"
                  >
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </form>
          ) : null}
          {canTransition ? (
            <div className="space-y-2 border-t border-border pt-3">
              <label className="block text-xs text-muted" htmlFor={reasonId}>
                Reason for changing thread status
              </label>
              <textarea
                className={cn(fieldClass, inline && "max-lg:text-base")}
                disabled={pending}
                id={reasonId}
                maxLength={10000}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                value={reason}
              />
              <div className="flex flex-wrap gap-2">
                {selectedThread.status === "open" ? (
                  <>
                    <button
                      className={buttonClass}
                      disabled={pending || !reason.trim()}
                      onClick={() => {
                        void transition("resolved");
                      }}
                      type="button"
                    >
                      Resolve thread
                    </button>
                    <button
                      className={buttonClass}
                      disabled={pending || !reason.trim()}
                      onClick={() => {
                        void transition("superseded");
                      }}
                      type="button"
                    >
                      Supersede thread
                    </button>
                  </>
                ) : (
                  <button
                    className={buttonClass}
                    disabled={pending || !reason.trim()}
                    onClick={() => {
                      void transition("open");
                    }}
                    type="button"
                  >
                    Reopen thread
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
