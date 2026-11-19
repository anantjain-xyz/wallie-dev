"use client";

import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import {
  answerSpecificationSchema,
  sessionSpecificationStateSchema,
  specificationAnswerReceiptSchema,
  type SessionSpecificationState,
  type SpecificationAnswerReceipt,
} from "@/lib/sessions/specification-contracts";

type SpecificationArtifact = {
  sessionId: string;
  stageId: string;
  artifactId: string;
  artifactVersion: number;
  phaseStatus: "awaiting_review" | "rejected";
};

type Clarification = NonNullable<SessionSpecificationState["clarification"]>;
type SpecificationView = {
  key: string;
  status: "checking" | "ready" | "error";
  clarification: Clarification | null;
  reviewable: boolean;
};

export function useSessionSpecification(artifact: SpecificationArtifact | null) {
  const sessionId = artifact?.sessionId;
  const stageId = artifact?.stageId;
  const artifactId = artifact?.artifactId;
  const artifactVersion = artifact?.artifactVersion;
  const key = `${sessionId}:${stageId}:${artifactId}:${artifactVersion}:${artifact?.phaseStatus}`;
  const [stored, setStored] = useState<SpecificationView | null>(null);
  const active = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId || !artifactId) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setStored((previous) => ({
      key,
      status: "checking",
      clarification: previous?.key === key ? previous.clarification : null,
      reviewable: false,
    }));

    try {
      const response = await fetch(`/api/sessions/${sessionId}/specification`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if ([401, 403, 404].includes(response.status)) {
        setStored({ key, status: "error", clarification: null, reviewable: false });
        return;
      }
      if (!response.ok) throw new Error("Could not check clarification.");
      const parsed = sessionSpecificationStateSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      const { clarification, reviewable } = parsed;
      if (
        parsed.stageId !== stageId ||
        parsed.artifactId !== artifactId ||
        parsed.artifactVersion !== artifactVersion ||
        (!clarification && !reviewable) ||
        (clarification &&
          (clarification.artifactId !== artifactId ||
            clarification.artifactVersion !== artifactVersion))
      ) {
        setStored({ key, status: "error", clarification: null, reviewable: false });
        return;
      }
      setStored({ key, status: "ready", clarification, reviewable });
    } catch {
      if (controller.signal.aborted) return;
      setStored((previous) => ({
        key,
        status: "error",
        clarification: previous?.key === key ? previous.clarification : null,
        reviewable: false,
      }));
    }
  }, [artifactId, artifactVersion, key, sessionId, stageId]);

  useEffect(() => {
    if (!artifactId) return;
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      active.current?.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [artifactId, refresh]);

  const view: SpecificationView =
    stored?.key === key
      ? stored
      : { key, status: "checking", clarification: null, reviewable: false };
  return {
    canReview: view.status === "ready" && view.reviewable && !view.clarification,
    view,
    refresh,
  };
}

export function SessionSpecificationControl({
  canAnswer,
  onAccepted,
  refresh,
  sessionId,
  view,
}: {
  canAnswer: boolean;
  onAccepted: (receipt: SpecificationAnswerReceipt, artifactId: string) => void;
  refresh: () => Promise<void>;
  sessionId: string;
  view: SpecificationView;
}) {
  return (
    <section
      aria-label="Specification clarification"
      className="space-y-3 rounded-b-[6px] border-t border-border bg-sheet px-4 py-4 sm:px-5"
    >
      {view.status === "checking" ? (
        <p role="status" className="text-sm text-muted">
          Checking clarification…
        </p>
      ) : null}
      {view.status === "error" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-danger">
            Could not confirm clarification status.
          </p>
          <button type="button" className="ui-button" onClick={() => void refresh()}>
            Refresh clarification
          </button>
        </div>
      ) : null}
      {view.clarification ? (
        <SessionClarificationAnswer
          key={view.clarification.id}
          canAnswer={canAnswer && view.status === "ready" && view.reviewable}
          clarification={view.clarification}
          onAccepted={onAccepted}
          refresh={refresh}
          sessionId={sessionId}
        />
      ) : null}
    </section>
  );
}

function SessionClarificationAnswer({
  canAnswer,
  clarification,
  onAccepted,
  refresh,
  sessionId,
}: {
  canAnswer: boolean;
  clarification: Clarification;
  onAccepted: (receipt: SpecificationAnswerReceipt, artifactId: string) => void;
  refresh: () => Promise<void>;
  sessionId: string;
}) {
  const fieldId = useId();
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; needsRefresh?: boolean } | null>(null);
  const [receipt, setReceipt] = useState<SpecificationAnswerReceipt | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  const exhausted = clarification.executionExhausted || receipt?.executionExhausted;
  const answered = clarification.status === "answered" || Boolean(receipt);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || !canAnswer || answered || exhausted) return;
    const trimmed = answer.trim();
    const fingerprint = JSON.stringify([clarification.reviewRevision, trimmed]);
    const requestId = requestIds.current.get(fingerprint) ?? crypto.randomUUID();
    const parsed = answerSpecificationSchema.safeParse({
      clarificationId: clarification.id,
      artifactId: clarification.artifactId,
      artifactVersion: clarification.artifactVersion,
      reviewRevision: clarification.reviewRevision,
      requestId,
      answer: trimmed,
    });
    if (!parsed.success) {
      setError({ message: parsed.error.issues[0]?.message ?? "Enter an answer." });
      return;
    }
    requestIds.current.set(fingerprint, requestId);

    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/specification`, {
        body: JSON.stringify(parsed.data),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          await refresh();
          return;
        }
        if (response.status === 409) {
          setError({
            message: "The clarification changed. Your answer was kept.",
            needsRefresh: true,
          });
          return;
        }
        throw new Error("Clarification answer was not confirmed.");
      }
      const result = specificationAnswerReceiptSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      if (result.clarificationId !== clarification.id)
        throw new Error("Answer receipt did not match.");
      setReceipt(result);
      if (!result.executionExhausted) setAnswer("");
      onAccepted(result, clarification.artifactId);
    } catch {
      if (!controller.signal.aborted)
        setError({ message: "Answer unconfirmed. Your draft was kept." });
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <h3 className="text-sm font-semibold text-foreground">
        {answered && !exhausted ? "Clarification answered" : "Clarification needed"}
      </h3>
      <p className="whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">
        {clarification.question}
      </p>
      {exhausted ? (
        <p role="status" className="text-sm text-muted">
          The execution budget is exhausted. No specification revision was queued.
        </p>
      ) : answered ? (
        <p role="status" className="text-sm text-muted">
          Answer submitted. Wallie is preparing the next specification.
        </p>
      ) : (
        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1.5">
            <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
              Your answer
            </label>
            <textarea
              id={fieldId}
              className="ui-input min-h-24 resize-y"
              value={answer}
              disabled={pending || !canAnswer}
              onChange={(event) => setAnswer(event.target.value)}
              aria-describedby={error ? `${fieldId}-error` : undefined}
            />
          </div>
          {error ? (
            <p id={`${fieldId}-error`} role="alert" className="text-sm text-danger">
              {error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="ui-button-primary"
              disabled={pending || !canAnswer || !answer.trim()}
            >
              <ActionButtonLabel
                idle="Submit answer"
                pending={pending}
                pendingLabel="Submitting…"
              />
            </button>
            {error?.needsRefresh ? (
              <button
                type="button"
                className="ui-button"
                onClick={() => {
                  setError(null);
                  void refresh();
                }}
              >
                Refresh clarification
              </button>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
