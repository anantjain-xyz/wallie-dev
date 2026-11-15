"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatUtcTimestamp } from "@/components/shared/time-format";
import { Status, agentRunStatusValue } from "@/components/ui/status";
import { formatMessageSourceLabel } from "@/features/wallie/activity-summary";
import { LiveConnectionNotice } from "@/features/wallie/live-connection-notice";
import { useRealtimeRecovery } from "@/features/wallie/realtime-recovery-context";
import { parseToolUseMessage } from "@/features/wallie/run-message-body";
import type {
  RunTranscriptEntry,
  RunTranscriptPage,
} from "@/features/wallie/run-transcript-contracts";
import { isWallieRunTerminalStatus } from "@/features/wallie/utils";
import {
  loadSupabaseBrowserClient,
  subscribeDeferredAuthenticatedChannel,
} from "@/lib/supabase/deferred-browser";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";

type TranscriptState = RunTranscriptPage;
type Props = {
  workspaceId: string;
  runId: string;
  initialPage: RunTranscriptPage;
};

const FORWARD_PAGES_PER_REFRESH = 3;
const GAP_LABELS = {
  normalized_source_only: "Only normalized activity was captured.",
  unsupported_event: "Some provider activity was unsupported.",
  missing_tool_call: "The original tool call was unavailable.",
  missing_tool_result: "The tool result was unavailable.",
  missing_terminal: "The run ended without a terminal record.",
  stream_interrupted: "The provider stream was interrupted.",
} as const;
const LIMITATION_LABELS = {
  usage_unavailable: "The provider did not report usage.",
  tool_identity_may_be_unavailable: "Some tool calls may lack a pairing ID.",
  tool_start_may_be_unavailable: "Some tools are reported only at completion.",
  child_session_events_unavailable: "Child-session activity is unavailable.",
  terminal_inferred_from_final_step: "Completion comes from the final recorded step.",
} as const;

class TranscriptAccessError extends Error {}
class TranscriptSourceChanged extends Error {}

export function RunTranscriptLive(props: Props) {
  return <TranscriptPanel key={`${props.workspaceId}:${props.runId}`} {...props} />;
}

function TranscriptPanel({ workspaceId, runId, initialPage }: Props) {
  const router = useRouter();
  const supabaseConfig = useSupabasePublicConfig();
  const { connection, recovery } = useRealtimeRecovery();
  const [state, setState] = useState(initialPage);
  const [needsLive, setNeedsLive] = useState(
    () => !isWallieRunTerminalStatus(initialPage.runStatus),
  );
  const current = useRef(state);
  const repairedOlderCursor = useRef<string | null>(null);
  const metadata = useRef({
    attemptCount: initialPage.attemptCount,
    status: initialPage.runStatus,
  });
  const [earlierVisited, setEarlierVisited] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const accessLost = useRef(false);
  const olderRequest = useRef<AbortController | null>(null);
  const endpoint = `/api/workspaces/${workspaceId}/runs/${runId}/transcript`;
  const getSupabase = useCallback(
    () => loadSupabaseBrowserClient(supabaseConfig),
    [supabaseConfig],
  );

  const read = useCallback(
    async (signal: AbortSignal, cursor?: string, direction?: "older" | "newer") => {
      const query = new URLSearchParams();
      if (cursor && direction) {
        query.set("cursor", cursor);
        query.set("direction", direction);
      }
      const suffix = query.size ? `?${query}` : "";
      const response = await fetch(`${endpoint}${suffix}`, { signal, cache: "no-store" });
      if ([401, 403, 404, 410].includes(response.status)) throw new TranscriptAccessError();
      if (response.status === 409) throw new TranscriptSourceChanged();
      if (!response.ok) throw new Error("Could not read the transcript.");
      const page: RunTranscriptPage = await response.json();
      signal.throwIfAborted();
      if (page.runId !== runId) throw new Error("The transcript belongs to a different run.");
      return page;
    },
    [endpoint, runId],
  );

  const apply = useCallback(
    (page: RunTranscriptPage, position: "head" | "older" | "newer" | "replace") => {
      if (accessLost.current) return;
      const before = current.current;
      if (
        position !== "replace" &&
        (before.mode !== page.mode || before.attemptCount !== page.attemptCount)
      ) {
        if (position !== "head") return;
        position = "replace";
      }
      // A stale read from the same run must never restore an active status.
      const runStatus =
        isWallieRunTerminalStatus(before.runStatus) ||
        (position === "older" && !isWallieRunTerminalStatus(page.runStatus))
          ? before.runStatus
          : page.runStatus;
      let next: TranscriptState;
      if (position === "replace") {
        repairedOlderCursor.current = null;
        next = { ...page, runStatus };
      } else {
        const entries = mergeTranscriptEntries(before.entries, page.entries);
        next = { ...before, runStatus, entries };
        if (position === "newer") {
          next.newerCursor = page.newerCursor;
          next.hasNewer = page.hasNewer;
        } else if (
          position === "head" &&
          !before.hasOlder &&
          page.olderCursor !== repairedOlderCursor.current &&
          hasUnseenEarlierActivity(before.entries, entries, page)
        ) {
          // Keep a way to page into history that arrived behind the forward cursor.
          next.olderCursor = page.olderCursor;
          next.hasOlder = true;
          repairedOlderCursor.current = page.olderCursor;
        } else if (position === "older") {
          next.olderCursor = page.olderCursor;
          next.hasOlder = page.hasOlder;
        }
      }
      current.current = next;
      setState(next);
    },
    [],
  );

  const syncMetadata = useCallback(() => {
    const { attemptCount, runStatus } = current.current;
    if (isWallieRunTerminalStatus(runStatus)) setNeedsLive(false);
    const { status } = metadata.current;
    if (attemptCount !== metadata.current.attemptCount || runStatus !== status) {
      metadata.current = { attemptCount, status: runStatus };
      router.refresh();
    }
  }, [router]);

  const clearAccess = useCallback(() => {
    accessLost.current = true;
    olderRequest.current?.abort();
    setUnavailable(true);
  }, []);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        let cursor = current.current.newerCursor;
        for (let pageNumber = 0; pageNumber < FORWARD_PAGES_PER_REFRESH; pageNumber++) {
          const page = await read(signal, cursor, "newer");
          apply(page, "newer");
          if (!page.hasNewer) {
            // A provider may commit a lower sequence after a later one. Recheck the
            // bounded tail as well as the forward boundary without skipping pages.
            const head = await read(signal);
            apply(head, "head");
            if (head.newerCursor !== page.newerCursor) recovery.invalidate();
            else syncMetadata();
            return;
          }
          if (page.newerCursor === cursor) throw new Error("Transcript cursor did not advance.");
          cursor = page.newerCursor;
        }
        recovery.invalidate();
      } catch (error) {
        if (error instanceof TranscriptAccessError) {
          clearAccess();
          return;
        }
        if (!(error instanceof TranscriptSourceChanged)) throw error;
        try {
          apply(await read(signal), "replace");
          syncMetadata();
        } catch (restartError) {
          if (!(restartError instanceof TranscriptAccessError)) throw restartError;
          clearAccess();
        }
      }
    },
    [apply, clearAccess, read, recovery, syncMetadata],
  );

  useEffect(() => {
    if (unavailable || !needsLive) return;
    return recovery.register({
      key: `transcript:${runId}`,
      role: "history",
      required: true,
      refresh,
      subscribe: (onStatus, isCurrent) =>
        subscribeDeferredAuthenticatedChannel(
          getSupabase,
          (client) =>
            client
              .channel(`wallie-inspector:${runId}`)
              // Every ordered append updates activity on this exact run in the
              // append transaction. Both notifications are hints, never payloads.
              .on(
                "postgres_changes",
                {
                  schema: "public",
                  table: "agent_runs",
                  event: "UPDATE",
                  filter: `id=eq.${runId}`,
                },
                () => {
                  if (isCurrent()) recovery.invalidate();
                },
              )
              .on(
                "postgres_changes",
                {
                  schema: "public",
                  table: "agent_run_messages",
                  event: "INSERT",
                  filter: `agent_run_id=eq.${runId}`,
                },
                () => {
                  if (isCurrent()) recovery.invalidate();
                },
              ),
          onStatus,
          isCurrent,
        ),
    });
  }, [getSupabase, needsLive, recovery, refresh, runId, unavailable]);

  useEffect(() => () => olderRequest.current?.abort(), []);

  async function loadOlder() {
    const cursor = current.current.olderCursor;
    if (!cursor || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    setEarlierVisited(true);
    setLoadingOlder(true);
    setOlderError(false);
    try {
      try {
        apply(await read(signal, cursor, "older"), "older");
      } catch (error) {
        if (!(error instanceof TranscriptSourceChanged)) throw error;
        // Leave refresh ownership with the existing live flight when subscribed.
        if (needsLive) recovery.invalidate();
        else apply(await read(signal), "replace");
      }
    } catch (error) {
      if (error instanceof TranscriptAccessError) clearAccess();
      else if (!controller.signal.aborted) setOlderError(true);
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = null;
        if (!controller.signal.aborted) setLoadingOlder(false);
      }
    }
  }

  if (unavailable)
    return (
      <p role="alert" className="type-body text-muted">
        This transcript is unavailable.
      </p>
    );

  return (
    <section className="ui-sheet min-w-0 p-4 sm:p-6" aria-labelledby="run-transcript-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="run-transcript-heading" className="type-heading text-foreground">
          Transcript
        </h2>
        <Status value={agentRunStatusValue(state.runStatus)} />
      </div>
      {needsLive ? <LiveConnectionNotice state={connection} onRetry={recovery.retry} /> : null}
      <TranscriptCoverage state={state} />
      {state.hasOlder || earlierVisited ? (
        <button
          aria-disabled={!state.hasOlder || loadingOlder}
          className="ui-button mt-3 aria-disabled:opacity-60"
          onClick={() => {
            if (state.hasOlder && !loadingOlder) void loadOlder();
          }}
          type="button"
        >
          {loadingOlder
            ? "Loading earlier activity…"
            : state.hasOlder
              ? "Load earlier activity"
              : "Beginning of transcript"}
        </button>
      ) : null}
      {olderError ? (
        <p role="alert" className="mt-2 type-body text-warning">
          Could not load earlier activity. Try again.
        </p>
      ) : null}
      {state.entries.length ? (
        <ol aria-label="Run activity" className="mt-3 divide-y divide-border">
          {state.entries.map((entry) => (
            <TranscriptLine entry={entry} key={entry.id} />
          ))}
        </ol>
      ) : (
        <p className="mt-3 type-body text-muted">No activity has been recorded for this run.</p>
      )}
    </section>
  );
}

function hasUnseenEarlierActivity(
  previous: readonly RunTranscriptEntry[],
  merged: readonly RunTranscriptEntry[],
  head: RunTranscriptPage,
) {
  const first = head.entries[0];
  if (!head.hasOlder || !head.olderCursor || !first) return false;
  if (first.sequence !== null) {
    // Ordered capture starts at sequence 1. A lower rank means there are gaps
    // below this bounded page, even if its newest event was already loaded.
    return merged.findIndex((entry) => entry.id === first.id) < first.sequence - 1;
  }
  const knownIds = new Set(previous.map((entry) => entry.id));
  return head.entries.some((entry) => !knownIds.has(entry.id));
}

export function mergeTranscriptEntries(
  previous: readonly RunTranscriptEntry[],
  incoming: readonly RunTranscriptEntry[],
) {
  if (incoming.length === 0) return [...previous];
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return Array.from(byId.values()).sort((a, b) => {
    if (a.sequence !== null && b.sequence !== null) return a.sequence - b.sequence;
    return compareTimestamp(a.createdAt, b.createdAt) || a.id.localeCompare(b.id);
  });
}

/** Preserve database ordering for timestamps within the same millisecond. */
function compareTimestamp(a: string, b: string) {
  return (
    Date.parse(a) - Date.parse(b) ||
    (a.match(/\.(\d+)/)?.[1] ?? "")
      .padEnd(6, "0")
      .localeCompare((b.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0"))
  );
}

function TranscriptCoverage({ state }: { state: TranscriptState }) {
  if (state.mode === "legacy") {
    if (state.entries.length === 0 && !isWallieRunTerminalStatus(state.runStatus)) return null;
    return (
      <p className="mt-2 type-body text-muted">
        {state.entries.length
          ? "Legacy activity has no structured capture receipt."
          : "No structured capture receipt was recorded."}
      </p>
    );
  }
  const end = state.entries.findLast((entry) => entry.kind === "capture_end");
  const coverage = end?.payload.coverage;
  const incomplete =
    end?.payload.status === "interrupted" ||
    state.entries.some((entry) => entry.truncated || entry.kind === "capture_gap") ||
    Boolean(
      coverage &&
      (coverage.unresolvedToolCalls ||
        coverage.unmatchedToolResults ||
        coverage.unsupportedEvents ||
        coverage.truncatedEvents),
    ) ||
    (!end && isWallieRunTerminalStatus(state.runStatus));
  return (
    <div className="mt-2 space-y-1 type-body text-muted">
      {incomplete ? <p>Capture is incomplete. Some activity may be missing or shortened.</p> : null}
      {coverage ? (
        <p>
          {coverage.toolCalls} tool calls · {coverage.toolResults} results
        </p>
      ) : null}
      {coverage?.limitations?.length ? (
        <ul className="list-disc pl-5">
          {coverage.limitations.map((item) => (
            <li key={item}>{LIMITATION_LABELS[item]}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TranscriptLine({ entry }: { entry: RunTranscriptEntry }) {
  const { label, text } = describeEntry(entry);
  return (
    <li className="min-w-0 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="type-label font-medium text-foreground">{label}</span>
        {entry.sequence !== null ? (
          <span className="type-annotation text-muted">#{entry.sequence}</span>
        ) : null}
        {entry.causationSequence !== null ? (
          <span className="type-annotation text-muted">From #{entry.causationSequence}</span>
        ) : null}
        <time className="type-annotation text-muted" dateTime={entry.createdAt}>
          {formatUtcTimestamp(entry.createdAt)}
        </time>
        {entry.truncated ? <span className="type-annotation text-warning">Shortened</span> : null}
      </div>
      {text ? (
        <p className="mt-1 whitespace-pre-wrap break-words type-body text-muted [overflow-wrap:anywhere]">
          {text}
        </p>
      ) : null}
    </li>
  );
}

function describeEntry(entry: RunTranscriptEntry): { label: string; text?: string } {
  switch (entry.kind) {
    case "text":
    case "progress":
      return { label: entry.kind === "text" ? "Message" : "Progress", text: entry.payload.text };
    case "tool_call":
      return { label: `Tool call · ${entry.payload.tool}`, text: entry.payload.input };
    case "tool_result": {
      const { status, outcome, tool, output, exitCode } = entry.payload;
      const result =
        outcome === "rejected" ? "Rejected" : status === "success" ? "Succeeded" : "Failed";
      return {
        label: `Tool result · ${tool} · ${result}`,
        text: exitCode === undefined ? output : `Exit code ${exitCode}\n${output}`,
      };
    }
    case "terminal":
      if (entry.payload.status === "failed")
        return { label: "Run stopped", text: entry.payload.message };
      return {
        label: entry.payload.status === "completed" ? "Completion" : "Incomplete completion",
        text: entry.payload.finalOutput ?? entry.payload.summary,
      };
    case "usage":
      return {
        label: "Usage",
        text: `${entry.payload.inputTokens} input · ${entry.payload.outputTokens} output tokens (${entry.payload.provenance})`,
      };
    case "capture_gap":
      return { label: "Capture gap", text: GAP_LABELS[entry.payload.reason] };
    case "capture_end":
      return {
        label: entry.payload.status === "complete" ? "Capture ended" : "Capture interrupted",
      };
    case "legacy": {
      const tool =
        entry.payload.kind === "tool_use" ? parseToolUseMessage(entry.payload.text) : null;
      if (tool) return { label: `Tool use · ${tool.tool}`, text: tool.payload };
      const label =
        entry.payload.kind === "run_failure"
          ? "Run failure"
          : formatMessageSourceLabel(entry.payload.kind);
      return { label, text: entry.payload.text };
    }
  }
}
