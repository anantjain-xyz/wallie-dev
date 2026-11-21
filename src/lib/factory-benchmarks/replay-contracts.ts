import { createHash } from "node:crypto";

import { z } from "zod";

export const replayCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const replayDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const replayCandidateSchema = z.strictObject({
  model: z.string().min(1).max(200).optional(),
  harness: z.enum(["codex", "claude-code", "cursor", "opencode"]).optional(),
  definitionDigest: replayDigestSchema.optional(),
});

export type ReplayCandidate = z.infer<typeof replayCandidateSchema>;
export type ReplayLimit =
  | "rendered_prompt_bytes_unavailable"
  | "model_version_unverified"
  | "runtime_version_unrecorded"
  | "renderer_version_changed"
  | "sandbox_provider_changed"
  | "sandbox_connection_changed"
  | "candidate_inputs_changed";

export type ReplayIdentity = {
  taskRevisionId: string;
  sourceRunId: string;
  sourceSessionId: string;
  sourceJobId: string;
  sourceAttemptCount: number;
  repositoryId: string;
  definitionRevisionId: string;
  inputSha: string;
  inputRef: string | null;
  checkoutSha: string;
  retryBundleSha256: string | null;
  definitionDigest: string;
  contextManifestSha256: string;
  originalPromptSha256: string;
  renderedPromptSha256: string;
  rendererVersion: number;
};

export type ReplayRuntime = {
  harness: string;
  model: string;
  worker: "node" | "workerd";
  sandboxProvider: string | null;
  sandboxConnectionRevision: string | null;
  stageId: string;
  runType: string;
  agentEffort: string | null;
  maxTurns: number | null;
};

export type ReplayTextInputs = {
  originalPrompt: string;
  definitionJson: string;
  contextManifestJson: string;
  required: { key: string; body: string }[];
  documents: { revisionId: string; body: string }[];
  memories: { revisionId: string; body: string }[];
  conversation: { sequence: number; body: string }[];
  skills: { revisionId: string; body: string }[];
  agentPrompt: { revisionId: string; body: string };
};

export type ReplayPlan = {
  identity: ReplayIdentity;
  runtime: ReplayRuntime;
  text: ReplayTextInputs;
  readRepositories: ReadonlyMap<string, string>;
  retryBytes: Buffer | null;
  limits: ReplayLimit[];
  candidateChanges: (keyof ReplayCandidate)[];
};

export function replaySha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export class BenchmarkReplayUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkReplayUnavailable";
  }
}
