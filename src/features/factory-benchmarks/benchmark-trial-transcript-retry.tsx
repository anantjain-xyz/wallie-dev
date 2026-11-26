"use client";

import { useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PageSection } from "@/components/ui/page-shell";
import type { RunTranscriptPage } from "@/features/wallie/run-transcript-contracts";
import { RunTranscriptLive } from "@/features/wallie/run-transcript-live";

export function BenchmarkTrialTranscriptRetry({
  workspaceId,
  runId,
  attemptCount,
  endpoint,
}: {
  workspaceId: string;
  runId: string;
  attemptCount: number;
  endpoint: string;
}) {
  const [state, setState] = useState<RunTranscriptPage | "loading" | "unavailable" | "retry">(
    "retry",
  );
  const request = useRef<AbortController | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (typeof state === "string" || !restoreFocus.current) return;
    transcript.current?.focus({ preventScroll: true });
  }, [state]);

  async function retry() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    setState("loading");
    try {
      const response = await fetch(endpoint, { signal, cache: "no-store" });
      if ([401, 403, 404, 410].includes(response.status)) {
        setState("unavailable");
        return;
      }
      if (!response.ok) throw new Error();
      const page: RunTranscriptPage = await response.json();
      signal.throwIfAborted();
      if (page.runId !== runId || page.attemptCount !== attemptCount) {
        setState("unavailable");
        return;
      }
      restoreFocus.current = document.activeElement === button.current;
      setState(page);
    } catch {
      if (!controller.signal.aborted) setState("retry");
    } finally {
      request.current = null;
    }
  }

  if (typeof state !== "string")
    return (
      <div ref={transcript} aria-label="Transcript" role="group" tabIndex={-1}>
        <RunTranscriptLive
          workspaceId={workspaceId}
          runId={runId}
          initialPage={state}
          trialEndpoint={endpoint}
        />
      </div>
    );

  const pending = state === "loading";
  return (
    <PageSection title="Transcript">
      <div className="ui-sheet space-y-2 p-4 sm:p-5">
        <p role="status" className="type-secondary text-muted">
          {state === "unavailable"
            ? "This transcript is no longer available for this attempt. Refresh trial evidence to check again."
            : pending
              ? "Loading transcript…"
              : "Couldn’t load the transcript."}
        </p>
        <button
          ref={button}
          type="button"
          aria-disabled={pending || state === "unavailable"}
          className="ui-button aria-disabled:opacity-60"
          onClick={() => {
            if (state === "retry") void retry();
          }}
        >
          <ActionButtonLabel idle="Retry transcript" pending={pending} pendingLabel="Retrying…" />
        </button>
      </div>
    </PageSection>
  );
}
