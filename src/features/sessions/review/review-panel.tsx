"use client";

import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";
import { cn } from "@/lib/utils";

import type { ArtifactSourceAnchor } from "./source-anchor";
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
  historical: boolean;
  readOnly?: boolean;
  anchor: ArtifactSourceAnchor | null;
  onClearAnchor: () => void;
  onClose?: () => void;
  openerRef?: RefObject<HTMLElement | null>;
};

const buttonClass =
  "min-h-11 rounded-[4px] border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-control-muted disabled:cursor-wait disabled:opacity-60";
const fieldClass =
  "w-full rounded-[4px] border border-border bg-surface px-3 py-2 text-sm text-foreground";

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
  historical,
  readOnly: parentReadOnly = false,
  anchor,
  onClearAnchor,
  onClose,
  openerRef,
}: ArtifactReviewPanelProps) {
  const baseUrl = `/api/sessions/${sessionId}/reviews`;
  const headingId = useId();
  const composerId = useId();
  const replyId = useId();
  const reasonId = useId();
  const [snapshot, setSnapshot] = useState<ReviewThreadListPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialThreadId);
  const [comments, setComments] = useState<ArtifactReviewComment[]>([]);
  const [commentCursor, setCommentCursor] = useState<ReviewCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"discussion" | "blocking">("discussion");
  const [reply, setReply] = useState("");
  const [editingTarget, setEditingTarget] = useState<{ id: string; revision: number } | null>(null);
  const editingId = editingTarget?.id ?? null;
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const requestMemory = useRef(new Map<string, Record<string, unknown>>());
  const threadDrafts = useRef(
    new Map<
      string,
      { reply: string; editingTarget: { id: string; revision: number } | null; reason: string }
    >(),
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const selectedRef = useRef(selectedId);
  const focusReplyAfterSave = useRef(false);
  const mounted = useRef(true);
  const threadLoadSequence = useRef(0);
  const commentLoadSequence = useRef(0);
  const config = useSupabasePublicConfig();
  selectedRef.current = selectedId;
  const selectedThread = snapshot?.threads.find((thread) => thread.id === selectedId) ?? null;
  const readOnly = parentReadOnly || (snapshot?.viewer.readOnly ?? true);

  const loadThreads = useCallback(
    async (cursor: ReviewCursor | null = null) => {
      const sequence = ++threadLoadSequence.current;
      try {
        const params = new URLSearchParams(pageQuery(cursor));
        params.set("artifactId", artifactId);
        const next = await reviewRequest<ReviewThreadListPayload>(`${baseUrl}?${params}`);
        const selected = selectedRef.current;
        let linkedThreadError: string | null = null;
        if (selected && !next.threads.some((thread) => thread.id === selected)) {
          try {
            const exact = await reviewRequest<{ thread: ArtifactReviewThread }>(
              `${baseUrl}/${encodeURIComponent(selected)}`,
            );
            if (exact.thread.artifact_id === artifactId)
              next.threads = mergeRows(next.threads, [exact.thread]);
          } catch {
            linkedThreadError = "The linked thread is unavailable. Other comments are shown below.";
          }
        }
        if (!mounted.current || sequence !== threadLoadSequence.current) return;
        setSnapshot((current) => ({
          ...next,
          threads: cursor && current ? mergeRows(current.threads, next.threads) : next.threads,
        }));
        setLoadError(linkedThreadError);
      } catch (error) {
        if (mounted.current && sequence === threadLoadSequence.current)
          setLoadError(error instanceof Error ? error.message : "Could not load review threads.");
      } finally {
        if (mounted.current && sequence === threadLoadSequence.current) setLoading(false);
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
        setLoadError(null);
        return next.comments;
      } catch (error) {
        if (mounted.current && sequence === commentLoadSequence.current)
          setLoadError(error instanceof Error ? error.message : "Could not load comments.");
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

  useEffect(() => {
    if (anchor && !readOnly) composerRef.current?.focus();
  }, [anchor, readOnly]);

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
      .channel(`artifact-review:${sessionId}:${artifactId}`)
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
  }, [artifactId, config, loadComments, loadThreads, sessionId]);

  function chooseThread(thread: ArtifactReviewThread) {
    if (inFlight.current || thread.id === selectedId) return;
    if (selectedId) threadDrafts.current.set(selectedId, { reply, editingTarget, reason });
    const draft = threadDrafts.current.get(thread.id);
    selectedRef.current = thread.id;
    setSelectedId(thread.id);
    setComments([]);
    setCommentCursor(null);
    setEditingTarget(draft?.editingTarget ?? null);
    setReply(draft?.reply ?? "");
    setReason(draft?.reason ?? "");
    setSaveError(null);
    const url = new URL(window.location.href);
    url.searchParams.set("reviewThread", thread.id);
    url.searchParams.set("artifactId", artifactId);
    url.searchParams.set("artifactVersion", String(artifactVersion));
    window.history.replaceState(window.history.state, "", url);
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

  return (
    <aside
      aria-labelledby={headingId}
      id="artifact-review-panel"
      className="min-w-0 rounded-[6px] border border-border bg-surface p-3 sm:p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground" id={headingId}>
          Comments <span className="text-muted">({snapshot?.counts.total ?? "…"})</span>
        </h4>
        {onClose ? (
          <button
            className={buttonClass}
            onClick={() => {
              onClose();
              queueMicrotask(() => openerRef?.current?.focus());
            }}
            type="button"
          >
            Close comments
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted">
        Version {artifactVersion}
        {historical ? " · Historical artifact" : ""}
      </p>
      {snapshot ? (
        <p className="mt-1 text-xs text-muted">
          {snapshot.counts.open} open · {snapshot.counts.blocking} blocking requests
        </p>
      ) : null}
      {readOnly && snapshot ? (
        <p className="mt-3 rounded-[4px] bg-control-muted p-2 text-xs text-muted">
          This session is archived. Comments are read-only.
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
          className="mt-4 space-y-3 border-b border-border pb-4"
          onSubmit={(event) => {
            void submitThread(event);
          }}
        >
          <p className="text-xs font-semibold text-foreground">New comment on selected text</p>
          <blockquote className="max-h-36 overflow-auto whitespace-pre-wrap break-words border-l-2 border-accent pl-2 text-xs text-muted">
            {anchor.quote}
          </blockquote>
          <label className="block text-xs text-muted" htmlFor={`${composerId}-kind`}>
            Comment type
          </label>
          <select
            className={cn(fieldClass, "min-h-11")}
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
          <label className="block text-xs text-muted" htmlFor={composerId}>
            Comment
          </label>
          <textarea
            ref={composerRef}
            className={fieldClass}
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
                openerRef?.current?.focus();
              }}
              type="button"
            >
              Cancel new comment
            </button>
          </div>
        </form>
      ) : !readOnly && snapshot ? (
        <p className="mt-3 text-xs text-muted">
          Select artifact text or use “Comment on a block” to start a thread.
        </p>
      ) : null}
      {snapshot?.threads.length === 0 ? (
        <p className="mt-4 text-xs text-muted">No comments on this artifact yet.</p>
      ) : null}
      <ul aria-label="Artifact review threads" className="mt-4 space-y-2">
        {snapshot?.threads.map((thread) => (
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
            </button>
          </li>
        ))}
      </ul>
      {snapshot?.nextCursor ? (
        <button
          className={cn(buttonClass, "mt-3")}
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
      {selectedThread ? (
        <section
          aria-label="Selected review thread"
          className="mt-4 space-y-3 border-t border-border pt-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="text-xs font-semibold text-foreground">
              Thread · {selectedThread.status}
            </h5>
            <a
              className={cn(buttonClass, "inline-flex items-center")}
              href={`?${new URLSearchParams({ ...(typeof window === "undefined" ? {} : Object.fromEntries(new URLSearchParams(window.location.search))), artifactId, artifactVersion: String(artifactVersion), reviewThread: selectedThread.id })}`}
            >
              Thread link
            </a>
          </div>
          <blockquote className="max-h-36 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs text-muted">
            {threadQuote(selectedThread)}
          </blockquote>
          {commentsLoading ? (
            <p className="text-xs text-muted" role="status">
              Loading thread…
            </p>
          ) : null}
          <ol aria-label="Thread comments" className="space-y-3">
            {comments.map((comment) => (
              <li className="min-w-0" key={comment.id}>
                <p className="text-xs font-semibold text-foreground">
                  {comment.author_label}
                  {comment.revision > 1 ? (
                    <span className="font-normal text-muted"> · Edited</span>
                  ) : null}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                  {comment.body}
                </p>
                {!readOnly && comment.author_member_id === snapshot?.viewer.memberId ? (
                  <button
                    className={cn(buttonClass, "mt-1")}
                    disabled={pending}
                    onClick={() => {
                      setEditingTarget({ id: comment.id, revision: comment.revision });
                      setReply(comment.body);
                      setSaveError(null);
                      replyRef.current?.focus();
                    }}
                    type="button"
                  >
                    Edit comment
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
              className="space-y-2"
              onSubmit={(event) => {
                void submitReply(event);
              }}
            >
              <label className="block text-xs text-muted" htmlFor={replyId}>
                {editingId ? "Edit your comment" : "Reply to thread"}
              </label>
              <textarea
                ref={replyRef}
                className={fieldClass}
                disabled={pending}
                id={replyId}
                maxLength={10000}
                onChange={(event) => setReply(event.target.value)}
                required
                rows={3}
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
                className={fieldClass}
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
