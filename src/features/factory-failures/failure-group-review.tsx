"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { z } from "zod";

import {
  failureCohortReviewResultSchema,
  type FailureCohortReview,
} from "@/lib/factory-failures/cohort-contracts";

type ReviewInput =
  | { action: "label"; label: string }
  | { action: "dismiss" }
  | { action: "split"; membershipDigest: string; selectedRunIds: string[] };

const errorResponse = z.object({ error: z.string() });

export function FailureGroupReview({
  endpoint,
  revision,
  label,
  dismissed,
  split,
}: {
  endpoint: string;
  revision: number;
  label: string | null;
  dismissed: boolean;
  split: { digest: string; runs: { id: string; label: string }[] } | null;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [conflict, setConflict] = useState(false);
  const previous = useRef<{ payload: string; requestId: string } | null>(null);
  const busy = saving || refreshing;

  function refresh() {
    startRefresh(() => router.refresh());
  }

  async function submit(input: ReviewInput) {
    const payload = JSON.stringify({ ...input, revision });
    const requestId =
      previous.current?.payload === payload ? previous.current.requestId : crypto.randomUUID();
    previous.current = { payload, requestId };
    const command: FailureCohortReview = { ...input, expectedRevision: revision, requestId };
    setSaving(true);
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
      setMessage({ text: "Review saved.", error: false });
      refresh();
    } catch {
      setMessage({
        text: "Could not confirm the review was saved. Retry the same change.",
        error: true,
      });
    } finally {
      setSaving(false);
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

  function submitSplit(event: FormEvent<HTMLFormElement>, membershipDigest: string) {
    event.preventDefault();
    const selectedRunIds = new FormData(event.currentTarget).getAll("run").map(String).sort();
    if (selectedRunIds.length === 0) {
      setMessage({ text: "Select at least one run for the split.", error: true });
      return;
    }
    void submit({ action: "split", membershipDigest, selectedRunIds });
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
            Save label
          </button>
        </form>
        {!dismissed ? (
          <button
            className="ui-button"
            type="button"
            disabled={busy || conflict}
            onClick={() => void submit({ action: "dismiss" })}
          >
            Dismiss group
          </button>
        ) : null}
      </div>
      {split ? (
        <details className="p-4 sm:p-5">
          <summary className="type-label cursor-pointer py-2">Split by run</summary>
          <form className="mt-3 space-y-3" onSubmit={(event) => submitSplit(event, split.digest)}>
            <fieldset className="space-y-2" disabled={busy || conflict}>
              <legend className="type-secondary mb-2 text-muted">
                Select runs for the first group. The second group contains the remaining runs.
              </legend>
              {split.runs.map((run) => (
                <label
                  className="type-secondary flex min-h-10 items-center gap-2 break-words"
                  key={run.id}
                >
                  <input name="run" type="checkbox" value={run.id} />
                  {run.label}
                </label>
              ))}
            </fieldset>
            <button className="ui-button" type="submit" disabled={busy || conflict}>
              Split group
            </button>
          </form>
        </details>
      ) : null}
      {message ? (
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
