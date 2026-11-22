"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { z } from "zod";

import {
  proposalReviewCommandSchema,
  proposalReviewSaveSchema,
  type ProposalReviewAction,
  type ProposalReviewCommand,
} from "@/lib/factory-proposals/workbench-contracts";

const reviewError = z.object({ error: z.string() });
const storedReviewChanged = "wallie:pending-improvement-review";

function subscribeToStoredReview(listener: () => void) {
  window.addEventListener(storedReviewChanged, listener);
  return () => window.removeEventListener(storedReviewChanged, listener);
}

function readStoredReview(key: string) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseStoredReview(raw: string | null, revisionId: string) {
  if (raw === null) return null;
  try {
    const result = proposalReviewCommandSchema.safeParse(JSON.parse(raw));
    return result.success && result.data.proposalRevisionId === revisionId ? result.data : null;
  } catch {
    return null;
  }
}

export function ImprovementReviewForm({
  endpoint,
  proposalRevisionId,
  reviewerMemberId,
  reviewVersion,
  canReview,
}: {
  endpoint: string;
  proposalRevisionId: string;
  reviewerMemberId: string;
  reviewVersion: number;
  canReview: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [pendingInMemory, setPendingInMemory] = useState<ProposalReviewCommand | null>(null);
  const storageKey = `wallie:improvement-review:v1:${reviewerMemberId}:${endpoint}:${proposalRevisionId}`;
  const stored = useSyncExternalStore(
    subscribeToStoredReview,
    () => readStoredReview(storageKey),
    () => null,
  );
  const pending = pendingInMemory ?? parseStoredReview(stored, proposalRevisionId);
  const busy = saving || refreshing;

  function remember(command: ProposalReviewCommand | null) {
    try {
      if (command) window.sessionStorage.setItem(storageKey, JSON.stringify(command));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      // Keep the exact command usable on this page if the browser disables storage.
      setPendingInMemory(command);
      return;
    }
    setPendingInMemory(null);
    window.dispatchEvent(new Event(storedReviewChanged));
  }

  function refresh() {
    startRefresh(() => router.refresh());
  }

  function submit(action: ProposalReviewAction) {
    const text = note.trim();
    if (!canReview || pending || busy || conflict || (action === "comment" && !text)) return;

    const parsed = proposalReviewCommandSchema.safeParse({
      proposalRevisionId,
      expectedReviewVersion: reviewVersion,
      action,
      note: text,
      requestId: crypto.randomUUID(),
    });
    if (!parsed.success) {
      setMessage({ error: true, text: "Check the review note and try again." });
      return;
    }
    void send(parsed.data);
  }

  async function send(command: ProposalReviewCommand, retrying = false) {
    remember(command);
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const error = reviewError.safeParse(data);
        if (response.status === 409) {
          remember(null);
          setNote(command.note);
          setConflict(true);
        } else if (
          !retrying &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          remember(null);
        } else {
          throw new Error("The review response did not confirm the submission.");
        }
        setMessage({
          error: true,
          text: error.success ? error.data.error : "Could not save the proposal review.",
        });
        return;
      }
      const { event } = proposalReviewSaveSchema.parse(data);
      if (
        event.action !== command.action ||
        event.version !== command.expectedReviewVersion + 1 ||
        event.note !== command.note ||
        event.actorMemberId !== reviewerMemberId
      ) {
        throw new Error("The review response does not match the submitted action.");
      }
      remember(null);
      setNote("");
      setMessage({ error: false, text: "Review saved." });
      refresh();
    } catch {
      setMessage({
        error: true,
        text: "Could not confirm the review was saved. Retry this review.",
      });
    } finally {
      setSaving(false);
    }
  }

  function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit("comment");
  }

  if (!canReview && !pending && !message) return null;

  return (
    <div className="space-y-3">
      {canReview && !pending ? (
        <form className="space-y-3" onSubmit={submitComment}>
          <label className="type-label grid gap-2">
            Review note
            <textarea
              className="ui-input min-h-24 w-full resize-y"
              value={note}
              maxLength={4_000}
              disabled={busy || conflict}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className="ui-button ui-button-primary"
              type="submit"
              disabled={busy || conflict || !note.trim()}
            >
              Add comment
            </button>
            <button
              className="ui-button"
              type="button"
              disabled={busy || conflict}
              onClick={() => submit("investigate")}
            >
              Investigate
            </button>
            <button
              className="ui-button"
              type="button"
              disabled={busy || conflict}
              onClick={() => submit("revise")}
            >
              Request revision
            </button>
            <button
              className="ui-button"
              type="button"
              disabled={busy || conflict}
              onClick={() => submit("dismiss")}
            >
              Dismiss proposal
            </button>
          </div>
        </form>
      ) : null}
      {message ? (
        <p
          className="type-secondary [overflow-wrap:anywhere]"
          role={message.error ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
      {pending ? (
        <div className="space-y-2">
          {!message ? (
            <p className="type-secondary" role="status">
              {busy ? "Confirming the review…" : "A review is awaiting confirmation."}
            </p>
          ) : null}
          <button
            className="ui-button"
            type="button"
            disabled={busy}
            onClick={() => void send(pending, true)}
          >
            Retry review
          </button>
        </div>
      ) : null}
      {conflict ? (
        <button
          className="ui-button"
          type="button"
          disabled={refreshing}
          onClick={() => {
            setConflict(false);
            setMessage(null);
            refresh();
          }}
        >
          Reload review
        </button>
      ) : null}
    </div>
  );
}
