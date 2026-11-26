"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type FormEvent,
} from "react";
import { z } from "zod";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import {
  proposalReviewCommandSchema,
  proposalReviewSaveSchema,
  type ProposalReviewAction,
  type ProposalReviewCommand,
} from "@/lib/factory-proposals/workbench-contracts";

const reviewError = z.object({ error: z.string() });
const storedReviewChanged = "wallie:pending-improvement-review";
const draftSchema = z.array(
  z.object({
    revisionId: factoryProposalUuidSchema,
    revisionNumber: z.number().int().positive(),
    note: z.string().min(1).max(4_000),
  }),
);
type Draft = z.infer<typeof draftSchema>[number];
type DraftFallback = { key: string; drafts: Draft[] };
type ReviewTarget = { revisionId: string; version: number };
const actionLabels: Record<ProposalReviewAction, string> = {
  comment: "Add comment",
  investigate: "Mark for investigation",
  revise: "Request revision",
  dismiss: "Dismiss revision",
};

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

function parseDrafts(raw: string | null): Draft[] {
  try {
    return raw === null ? [] : (draftSchema.safeParse(JSON.parse(raw)).data ?? []);
  } catch {
    return [];
  }
}

export function ImprovementReviewForm({
  endpoint,
  proposalRevisionId,
  revisionNumber,
  reviewerMemberId,
  reviewVersion,
  canReview,
}: {
  endpoint: string;
  proposalRevisionId: string;
  revisionNumber: number;
  reviewerMemberId: string;
  reviewVersion: number;
  canReview: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState({ revisionId: proposalRevisionId, note: "" });
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [dismissTarget, setDismissTarget] = useState<ReviewTarget | null>(null);
  const [conflict, setConflict] = useState<ReviewTarget | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [pendingInMemory, setPendingInMemory] = useState<ProposalReviewCommand | null>(null);
  const [draftsInMemory, setDraftsInMemory] = useState<DraftFallback | null>(null);
  const draftFallback = useRef<DraftFallback | null>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const recovery = useRef<HTMLDivElement>(null);
  const draftFieldId = useId();
  const scopeKey = `wallie:improvement-review:v1:${reviewerMemberId}:${endpoint}`;
  const storageKey = `${scopeKey}:${proposalRevisionId}`;
  const draftKey = `${scopeKey}:conflicts`;
  const stored = useSyncExternalStore(
    subscribeToStoredReview,
    () => readStoredReview(storageKey),
    () => null,
  );
  const pending =
    pendingInMemory?.proposalRevisionId === proposalRevisionId
      ? pendingInMemory
      : parseStoredReview(stored, proposalRevisionId);
  const storedDrafts = useSyncExternalStore(
    subscribeToStoredReview,
    () => readStoredReview(draftKey),
    () => null,
  );
  const drafts =
    draftsInMemory?.key === draftKey ? draftsInMemory.drafts : parseDrafts(storedDrafts);
  const note = editing.revisionId === proposalRevisionId ? editing.note : "";
  const needsReload =
    conflict?.revisionId === proposalRevisionId && conflict.version === reviewVersion;
  const dismissOpen =
    dismissTarget?.revisionId === proposalRevisionId && dismissTarget.version === reviewVersion;
  const busy = saving || refreshing;

  useEffect(() => {
    if (!saving && message?.error) feedback.current?.focus();
  }, [message, saving]);

  function setNote(note: string) {
    setEditing({ revisionId: proposalRevisionId, note });
  }

  function updateDrafts(update: (drafts: Draft[]) => Draft[]) {
    const current = draftFallback.current;
    const value = update(
      current?.key === draftKey ? current.drafts : parseDrafts(readStoredReview(draftKey)),
    );
    try {
      if (value.length) window.sessionStorage.setItem(draftKey, JSON.stringify(value));
      else window.sessionStorage.removeItem(draftKey);
      draftFallback.current = null;
      setDraftsInMemory(null);
      window.dispatchEvent(new Event(storedReviewChanged));
    } catch {
      const fallback = { key: draftKey, drafts: value };
      draftFallback.current = fallback;
      setDraftsInMemory(fallback);
    }
  }

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
    if (!canReview || pending || busy || needsReload || (action === "comment" && !text)) return;

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
          if (command.note) {
            updateDrafts((current) => [
              { revisionId: command.proposalRevisionId, revisionNumber, note: command.note },
              ...current.filter(({ revisionId }) => revisionId !== command.proposalRevisionId),
            ]);
          }
          setNote("");
          setConflict({
            revisionId: command.proposalRevisionId,
            version: command.expectedReviewVersion,
          });
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
      setMessage({
        error: false,
        text:
          command.action === "investigate"
            ? "Marked for investigation. No one was assigned."
            : command.action === "revise"
              ? "Revision request recorded. No revision was started."
              : "Review saved.",
      });
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

  if (!canReview && !pending && !message && !drafts.length) return null;

  return (
    <div className="space-y-3">
      {canReview && !pending && !needsReload ? (
        <form className="space-y-3" onSubmit={submitComment}>
          <label className="type-label grid gap-2">
            Review note
            <textarea
              className="ui-input min-h-24 w-full resize-y"
              value={note}
              name="note"
              maxLength={4_000}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <p className="type-secondary text-muted">
            Marking for investigation or requesting a revision changes the review state. Neither
            action assigns anyone or starts work.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="ui-button ui-button-primary"
              type="submit"
              disabled={busy || !note.trim()}
            >
              Add comment
            </button>
            <button
              className="ui-button"
              type="button"
              disabled={busy}
              onClick={() => submit("investigate")}
            >
              Mark for investigation
            </button>
            <button
              className="ui-button"
              type="button"
              disabled={busy}
              onClick={() => submit("revise")}
            >
              Request revision
            </button>
            <DestructiveConfirmationDialog
              actionLabel="Dismiss revision"
              description={`Dismissal closes review and prevents publication of revision ${revisionNumber}. Previous discussion and evidence are kept.`}
              onConfirm={() => {
                setDismissTarget(null);
                if (dismissOpen) submit("dismiss");
              }}
              onOpenChange={(open) =>
                setDismissTarget(
                  open ? { revisionId: proposalRevisionId, version: reviewVersion } : null,
                )
              }
              open={dismissOpen}
              pending={false}
              pendingLabel="Dismissing revision…"
              title="Dismiss this revision?"
              trigger={
                <button className="ui-button" disabled={busy} type="button">
                  Dismiss proposal
                </button>
              }
            />
          </div>
        </form>
      ) : null}
      {message ? (
        <p
          className="type-secondary [overflow-wrap:anywhere]"
          ref={feedback}
          role={message.error ? "alert" : "status"}
          tabIndex={message.error ? -1 : undefined}
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
          <p className="type-secondary text-muted">
            {actionLabels[pending.action]} · Revision {revisionNumber}
          </p>
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
      {needsReload && canReview ? (
        <div className="space-y-2">
          <button
            className="ui-button"
            type="button"
            disabled={refreshing}
            onClick={() => {
              (drafts.length ? recovery.current : feedback.current)?.focus();
              refresh();
            }}
          >
            {refreshing ? "Reloading review…" : "Reload review"}
          </button>
        </div>
      ) : null}
      {drafts.length ? (
        <div
          aria-label="Unsubmitted review drafts"
          className="space-y-3 rounded-md border border-border p-3"
          ref={recovery}
          role="region"
          tabIndex={-1}
        >
          <p className="type-secondary text-muted">
            These notes weren’t submitted. Copy a note if you want to use it in a new review.
          </p>
          {drafts.map((draft) => (
            <div className="space-y-2" key={draft.revisionId}>
              <label className="type-label grid gap-1">
                Unsubmitted note · Revision {draft.revisionNumber}
                <textarea
                  className="ui-input min-h-20 w-full resize-y"
                  id={`${draftFieldId}-${draft.revisionId}`}
                  readOnly
                  value={draft.note}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  className="ui-button"
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(draft.note);
                      setCopyMessage(`Copied the note for revision ${draft.revisionNumber}.`);
                    } catch {
                      const field = document.getElementById(`${draftFieldId}-${draft.revisionId}`);
                      if (field instanceof HTMLTextAreaElement) {
                        field.focus();
                        field.select();
                      }
                      setCopyMessage(
                        "The note is selected. Copy it using your browser or keyboard.",
                      );
                    }
                  }}
                >
                  Copy note
                </button>
                <button
                  className="ui-button"
                  type="button"
                  onClick={() => {
                    updateDrafts((current) =>
                      current.filter(({ revisionId }) => revisionId !== draft.revisionId),
                    );
                    setCopyMessage("");
                  }}
                >
                  Clear draft
                </button>
              </div>
            </div>
          ))}
          <p className="type-secondary text-muted" role="status">
            {copyMessage}
          </p>
        </div>
      ) : null}
    </div>
  );
}
