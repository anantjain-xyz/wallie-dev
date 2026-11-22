"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { z } from "zod";

import {
  proposalReviewCommandSchema,
  proposalReviewSaveSchema,
  type ProposalReviewAction,
} from "@/lib/factory-proposals/workbench-contracts";

const reviewError = z.object({ error: z.string() });

export function ImprovementReviewForm({
  endpoint,
  proposalRevisionId,
  reviewVersion,
}: {
  endpoint: string;
  proposalRevisionId: string;
  reviewVersion: number;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const previous = useRef<{ payload: string; requestId: string } | null>(null);
  const busy = saving || refreshing;

  function refresh() {
    startRefresh(() => router.refresh());
  }

  async function submit(action: ProposalReviewAction) {
    const text = note.trim();
    if (busy || conflict || (action === "comment" && !text)) return;

    const command = {
      proposalRevisionId,
      expectedReviewVersion: reviewVersion,
      action,
      ...(text ? { note: text } : {}),
    };
    const payload = JSON.stringify(command);
    const requestId =
      previous.current?.payload === payload ? previous.current.requestId : crypto.randomUUID();
    const parsed = proposalReviewCommandSchema.safeParse({ ...command, requestId });
    if (!parsed.success) {
      setMessage({ error: true, text: "Check the review note and try again." });
      return;
    }
    previous.current = { payload, requestId };
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const error = reviewError.safeParse(data);
        if (response.status === 409) setConflict(true);
        setMessage({
          error: true,
          text: error.success ? error.data.error : "Could not save the proposal review.",
        });
        return;
      }
      const { event } = proposalReviewSaveSchema.parse(data);
      if (event.action !== action || event.version !== reviewVersion + 1) {
        throw new Error("The review response does not match the submitted action.");
      }
      previous.current = null;
      setNote("");
      setMessage({ error: false, text: "Review saved." });
      refresh();
    } catch {
      setMessage({
        error: true,
        text: "Could not confirm the review was saved. Retry the same action.",
      });
    } finally {
      setSaving(false);
    }
  }

  function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit("comment");
  }

  return (
    <div className="space-y-3">
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
            onClick={() => void submit("investigate")}
          >
            Investigate
          </button>
          <button
            className="ui-button"
            type="button"
            disabled={busy || conflict}
            onClick={() => void submit("revise")}
          >
            Request revision
          </button>
          <button
            className="ui-button"
            type="button"
            disabled={busy || conflict}
            onClick={() => void submit("dismiss")}
          >
            Dismiss proposal
          </button>
        </div>
      </form>
      {message ? (
        <p
          className="type-secondary [overflow-wrap:anywhere]"
          role={message.error ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
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
          Reload review
        </button>
      ) : null}
    </div>
  );
}
