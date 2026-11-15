import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listRunArtifacts, readRunArtifact } from "@/features/wallie/run-artifacts";
import { loadWorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import { loadRunTranscript } from "@/features/wallie/run-transcript";
import type { AgentEvent } from "@/lib/agent-runner/types";
import type { Database } from "@/lib/supabase/database.types";

export const initialText = "Durable history fixture started.";
export const reconnectText = "Durable history fixture kept working while disconnected.";
export const terminalText = "Durable history fixture completed.";

export const initialRunEvent = { type: "text", text: initialText } satisfies AgentEvent;
export const reconnectRunEvent = { type: "text", text: reconnectText } satisfies AgentEvent;
export const completedRunEvent = {
  type: "completion",
  taskComplete: true,
  summary: terminalText,
  finalOutput: "# Retained plan\n\nReview the preserved source checkpoint.",
  usage: { inputTokens: 7, outputTokens: 3 },
} satisfies AgentEvent;

export type RunHistoryFixture = {
  workspaceId: string;
  workspaceSlug: string;
  sessionId: string;
  runId: string;
  jobId: string;
  attemptCount: number;
};

export async function assertPublishedRunHistory(
  supabase: SupabaseClient<Database>,
  run: RunHistoryFixture,
  accepted: { artifactId: string; checkpointSha: string },
) {
  const scope = { supabase, ...run };
  const [catalog, transcript, artifacts] = await Promise.all([
    loadWorkspaceRunCatalogItem(scope),
    loadRunTranscript(scope),
    listRunArtifacts(scope, {}),
  ]);
  assert(catalog);
  assert.equal(catalog.id, run.runId);
  assert.equal(catalog.sessionId, run.sessionId);
  assert.equal(catalog.attemptCount, run.attemptCount);
  assert.equal(catalog.status, "success");

  assert(transcript);
  assert.equal(transcript.mode, "events");
  assert.equal(transcript.runStatus, "success");
  assert.equal(transcript.attemptCount, run.attemptCount);
  const sequences = transcript.entries.map((entry) => entry.sequence);
  assert.deepEqual(
    sequences,
    [...new Set(sequences)].sort((a, b) => (a ?? 0) - (b ?? 0)),
  );
  const text = transcript.entries.flatMap((entry) =>
    entry.kind === "text" ? [entry.payload.text] : [],
  );
  assert.deepEqual(text, [initialText, reconnectText]);
  const terminal = transcript.entries.filter((entry) => entry.kind === "terminal");
  assert.equal(terminal.length, 1);
  const [outcome] = terminal;
  assert(outcome.kind === "terminal" && outcome.payload.status === "completed");
  assert.equal(outcome.payload.summary, terminalText);
  const last = transcript.entries.at(-1);
  assert(last?.kind === "capture_end");
  assert.equal(last.payload.status, "complete");
  const usage = transcript.entries.filter((entry) => entry.kind === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.causationSequence, outcome.sequence);

  assert(artifacts);
  const markdown = artifacts.items.filter((item) => item.kind === "stage_markdown");
  assert.equal(markdown.length, 1);
  const [artifact] = markdown;
  assert.equal(artifact.id, accepted.artifactId);
  assert.deepEqual(artifact.producer, {
    runId: run.runId,
    sessionId: run.sessionId,
    attemptCount: run.attemptCount,
  });
  assert.deepEqual(artifact.checkpoint, { runId: run.runId, commitSha: accepted.checkpointSha });
  assert(artifacts.items.some((item) => item.kind === "checkpoint"));
  const content = await readRunArtifact(scope, artifact, AbortSignal.timeout(10_000));
  assert.equal(content.status, "available");
  assert("bytes" in content);
  assert.equal(new TextDecoder().decode(content.bytes), completedRunEvent.finalOutput);
}
