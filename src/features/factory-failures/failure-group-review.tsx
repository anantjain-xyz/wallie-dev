"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { z } from "zod";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import {
  failureCohortReviewResultSchema,
  maxFailureCohortSplitRuns,
  type FailureCohortReview,
} from "@/lib/factory-failures/cohort-contracts";

type ReviewInput =
  | { action: "label"; label: string }
  | { action: "dismiss" }
  | { action: "split"; membershipDigest: string; selectedRunIds: string[] };

const errorResponse = z.object({ error: z.string() });

type SplitPage = {
  digest: string;
  runs: { id: string; label: string; detail?: string }[];
  firstPage: string | null;
  nextPage: string | null;
};

function SplitForm({
  split,
  disabled,
  saving,
  onSubmit,
}: {
  split: SplitPage;
  disabled: boolean;
  saving: boolean;
  onSubmit: (input: Extract<ReviewInput, { action: "split" }>) => void;
}) {
  const [selected, setSelected] = useState<Map<string, string>>(() => new Map());
  const labelPrefix = useId();

  function changeSelection(run: { id: string; label: string }, checked: boolean) {
    setSelected((previous) => {
      const next = new Map(previous);
      if (checked && next.size < maxFailureCohortSplitRuns) next.set(run.id, run.label);
      if (!checked) next.delete(run.id);
      return next;
    });
  }

  return (
    <details className="p-4 sm:p-5">
      <summary className="type-label cursor-pointer py-2">Split by run</summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !selected.size) return;
          onSubmit({
            action: "split",
            membershipDigest: split.digest,
            selectedRunIds: [...selected.keys()].sort(),
          });
        }}
      >
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="type-secondary mb-2 text-muted">
            Select runs for the first group. The remaining runs form the second group. You can use
            the Run evidence filters to find a session, stage, or observation date.
          </legend>
          {!split.runs.length ? (
            <p className="type-secondary text-muted">No runs to select on this page.</p>
          ) : null}
          {split.runs.map((run, index) => (
            <label
              className="type-secondary flex min-h-10 items-center gap-2 break-words"
              key={run.id}
            >
              <input
                checked={selected.has(run.id)}
                disabled={selected.size === maxFailureCohortSplitRuns && !selected.has(run.id)}
                aria-labelledby={`${labelPrefix}-${index}`}
                type="checkbox"
                value={run.id}
                onChange={(event) => changeSelection(run, event.target.checked)}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span id={`${labelPrefix}-${index}`} className="block">
                  {run.label}
                </span>
                {run.detail ? (
                  <span className="type-annotation block text-muted">{run.detail}</span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
        {split.firstPage || split.nextPage ? (
          <nav aria-label="Split run pages" className="flex flex-wrap gap-2">
            {split.firstPage ? (
              <Link className="ui-button" href={split.firstPage} scroll={false}>
                First runs page
              </Link>
            ) : null}
            {split.nextPage ? (
              <Link className="ui-button" href={split.nextPage} scroll={false}>
                More runs
              </Link>
            ) : null}
          </nav>
        ) : null}
        <p aria-live="polite" className="type-secondary text-muted">
          {selected.size} {selected.size === 1 ? "run" : "runs"} selected
          {selected.size === maxFailureCohortSplitRuns ? " (maximum per split)" : ""}
        </p>
        {selected.size ? (
          <ul aria-label="Selected runs across pages" className="space-y-1">
            {[...selected].map(([id, label]) => (
              <li
                className="type-secondary flex flex-wrap items-center gap-x-3 break-words [overflow-wrap:anywhere]"
                key={id}
              >
                {label}
                <button
                  aria-label={`Remove ${label} from selection`}
                  className="min-h-8 underline underline-offset-4 hover:text-muted"
                  disabled={disabled}
                  onClick={() => changeSelection({ id, label }, false)}
                  type="button"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <button className="ui-button" type="submit" disabled={disabled || !selected.size}>
          {saving ? "Splitting…" : "Split group"}
        </button>
      </form>
    </details>
  );
}

export function FailureGroupReview({
  endpoint,
  revision,
  label,
  split,
}: {
  endpoint: string;
  revision: number;
  label: string | null;
  split: SplitPage | null;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState<ReviewInput["action"] | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [conflict, setConflict] = useState(false);
  const previous = useRef<{ payload: string; requestId: string } | null>(null);
  const busy = saving !== null || refreshing;

  function refresh() {
    startRefresh(() => router.refresh());
  }

  async function submit(input: ReviewInput) {
    const payload = JSON.stringify({ ...input, revision });
    const requestId =
      previous.current?.payload === payload ? previous.current.requestId : crypto.randomUUID();
    previous.current = { payload, requestId };
    const command: FailureCohortReview = { ...input, expectedRevision: revision, requestId };
    setSaving(input.action);
    setMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const error = errorResponse.safeParse(result);
        if (response.status === 409) setConflict(true);
        setMessage({
          text: error.success ? error.data.error : "Could not save the failure group review.",
          error: true,
        });
        return;
      }
      failureCohortReviewResultSchema.parse(result);
      previous.current = null;
      if (input.action === "dismiss") setConfirmDismiss(false);
      setMessage({ text: "Review saved.", error: false });
      refresh();
    } catch {
      setMessage({
        text: "Could not confirm the review was saved. Retry the same change.",
        error: true,
      });
    } finally {
      setSaving(null);
    }
  }

  function submitLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("label") ?? "").trim();
    if (!value) {
      setMessage({ text: "Enter a label.", error: true });
      return;
    }
    void submit({ action: "label", label: value });
  }

  return (
    <div className="ui-sheet divide-y divide-border">
      <div className="space-y-3 p-4 sm:p-5">
        <form className="flex flex-wrap items-end gap-2" onSubmit={submitLabel}>
          <label className="type-label grid min-w-0 flex-1 basis-48 gap-1.5">
            Reviewed label
            <input
              className="ui-input w-full"
              key={revision}
              name="label"
              maxLength={120}
              required
              defaultValue={label ?? ""}
              disabled={busy || conflict}
            />
          </label>
          <button className="ui-button ui-button-primary" type="submit" disabled={busy || conflict}>
            {saving === "label" ? "Saving…" : "Save label"}
          </button>
        </form>
        <DestructiveConfirmationDialog
          open={confirmDismiss}
          onOpenChange={(open) => {
            setConfirmDismiss(open);
            if (open) setMessage(null);
          }}
          trigger={
            <button className="ui-button" type="button" disabled={busy || conflict}>
              Dismiss group
            </button>
          }
          title="Dismiss this failure group?"
          description="This closes review for the group. Run evidence stays available."
          errorMessage={message?.error ? message.text : null}
          actionLabel="Dismiss group"
          pendingLabel="Dismissing…"
          pending={saving === "dismiss"}
          actionDisabled={busy || conflict}
          onConfirm={() => void submit({ action: "dismiss" })}
        />
      </div>
      {split ? (
        <SplitForm
          key={`${endpoint}:${revision}:${split.digest}`}
          split={split}
          disabled={busy || conflict}
          saving={saving === "split"}
          onSubmit={(input) => void submit(input)}
        />
      ) : null}
      {message && !confirmDismiss ? (
        <div className="space-y-2 p-4 sm:p-5">
          <p className="type-secondary" role={message.error ? "alert" : "status"}>
            {message.text}
          </p>
          {conflict ? (
            <button
              className="ui-button"
              type="button"
              disabled={refreshing}
              onClick={() => {
                previous.current = null;
                setConflict(false);
                setMessage(null);
                refresh();
              }}
            >
              Reload group
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
