import "server-only";

import { z } from "zod";

import {
  SPECIFICATION_CLARIFICATION_LIMIT,
  formatSpecificationClarificationHistory,
  specificationDraftText,
} from "@/lib/pipeline/specification-context";
import type { RunContextManifest } from "@/lib/run-context/contracts";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Scope = {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string;
  sessionId: string;
  stageId?: string;
  recordedAt?: string;
};
type RequiredInput = RunContextManifest["required"][number];
type VerifyRepository = (input: {
  repositoryId: string;
  commitSha: string;
  sha256: string;
  utf8Bytes: number;
}) => Promise<boolean>;

const id = z.string().uuid();
const version = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(2_147_483_647));
const predecessorKey = z.tuple([z.literal("predecessor"), id, z.string().min(1), id, id, version]);
const feedbackBatchKey = z.tuple([z.literal("feedback"), z.literal("batch"), id]);
const feedbackArtifactKey = z.tuple([z.literal("feedback"), z.literal("artifact"), id, version]);
const repositoryKey = z.tuple([z.literal("repository"), id, z.string().regex(/^[a-f0-9]{40}$/)]);

function hasFingerprint(
  body: string | null | undefined,
  expected: RequiredInput | undefined,
): body is string {
  if (typeof body !== "string" || !expected) return false;
  const { sha256, utf8Bytes } = fingerprintRunContextInput(body);
  return sha256 === expected.sha256 && utf8Bytes === expected.utf8Bytes;
}

async function readPredecessor(scope: Scope, input: RequiredInput, key: string[]) {
  const parsed = predecessorKey.safeParse(key);
  if (!parsed.success) return null;
  const [, stageId, , approvalId, artifactId, artifactVersion] = parsed.data;
  const [approval, artifact] = await Promise.all([
    scope.admin
      .from("session_stage_approval_receipts")
      .select("artifact_digest")
      .eq("workspace_id", scope.workspaceId)
      .eq("session_id", scope.sessionId)
      .eq("id", approvalId)
      .eq("stage_id", stageId)
      .eq("artifact_id", artifactId)
      .eq("artifact_version", artifactVersion)
      .maybeSingle(),
    scope.admin
      .from("session_artifacts")
      .select("stage_id,artifact_json,canonical:artifact_json::text")
      .eq("workspace_id", scope.workspaceId)
      .eq("session_id", scope.sessionId)
      .eq("id", artifactId)
      .eq("version", artifactVersion)
      .maybeSingle(),
  ]);
  if (approval.error) throw approval.error;
  if (artifact.error) throw artifact.error;
  if (approval.data?.artifact_digest !== input.sha256 || !artifact.data) return null;
  if (artifact.data.stage_id !== null && artifact.data.stage_id !== stageId) return null;

  // The approval digest for legacy artifacts covers PostgreSQL's JSONB text.
  const { artifact_json: body, canonical } = artifact.data;
  const text = typeof body === "string" ? body : canonical;
  return hasFingerprint(text, input) ? text : null;
}

async function readFeedback(scope: Scope, input: RequiredInput, key: string[]) {
  const batch = feedbackBatchKey.safeParse(key);
  if (batch.success) {
    const { data, error } = await scope.admin
      .from("artifact_feedback_batches")
      .select("rendered_feedback_text")
      .eq("workspace_id", scope.workspaceId)
      .eq("session_id", scope.sessionId)
      .eq("id", batch.data[2])
      .maybeSingle();
    if (error) throw error;
    return hasFingerprint(data?.rendered_feedback_text, input) ? data.rendered_feedback_text : null;
  }
  const artifact = feedbackArtifactKey.safeParse(key);
  if (!artifact.success) return null;
  const { data, error } = await scope.admin
    .from("session_artifact_feedback")
    .select("feedback_text")
    .eq("workspace_id", scope.workspaceId)
    .eq("session_id", scope.sessionId)
    .eq("id", artifact.data[2])
    .eq("target_version", artifact.data[3])
    .maybeSingle();
  if (error) throw error;
  return hasFingerprint(data?.feedback_text, input) ? data.feedback_text : null;
}

async function readSpecificationInputs(
  scope: Scope,
  priorDraft: RequiredInput | undefined,
  clarificationHistory: RequiredInput | undefined,
) {
  if (!priorDraft && !clarificationHistory) return null;
  const { admin, workspaceId, sessionId, stageId, recordedAt } = scope;
  if (!stageId || !recordedAt) return null;

  const { data: draft, error: draftError } = await admin
    .from("session_artifacts")
    .select("version,artifact_json")
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .eq("stage_id", stageId)
    .lt("created_at", recordedAt)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (draftError) throw draftError;
  if (typeof draft?.artifact_json !== "string") return null;
  const priorDraftText = specificationDraftText(draft.artifact_json);
  if (priorDraft && !hasFingerprint(priorDraftText, priorDraft)) return null;
  if (!clarificationHistory) return { priorDraft: priorDraftText };

  const { data: answers, error } = await admin
    .from("session_specification_clarifications")
    .select("ordinal,question,answer_text")
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .eq("stage_id", stageId)
    .eq("status", "answered")
    .lt("artifact_version", draft.version)
    .lt("answered_at", recordedAt)
    .order("ordinal", { ascending: true })
    .limit(SPECIFICATION_CLARIFICATION_LIMIT);
  if (error) throw error;
  const history = formatSpecificationClarificationHistory(answers);
  return hasFingerprint(history, clarificationHistory)
    ? { priorDraft: priorDraftText, history }
    : null;
}

type RequiredOutcome =
  | { key: string; body: string }
  | { key: string; repository: { repositoryId: string; commitSha: string } }
  | { reason: string };

function readRequiredBody(
  input: RequiredInput,
  body: string | null | undefined,
  reason: string,
): RequiredOutcome {
  return hasFingerprint(body, input) ? { key: input.key, body } : { reason };
}

export async function readRequiredRunInputs(
  scope: Scope,
  required: RunContextManifest["required"],
  original: { title: string | null; prompt: string | null },
  verifyRepository: VerifyRepository,
) {
  const priorDraft = required.find(({ key }) => key === "specification/prior-draft");
  const clarificationHistory = required.find(
    ({ key }) => key === "specification/clarification-history",
  );
  const specification = readSpecificationInputs(scope, priorDraft, clarificationHistory);
  const originalInputs: { key: string; body: string | null; reason: string }[] = [
    {
      key: "session/title",
      body: original.title,
      reason: "The original session title is unavailable or changed.",
    },
    {
      key: "session/prompt",
      body: original.prompt,
      reason: "The original session prompt is unavailable or changed.",
    },
  ];
  const originalOutcomes = originalInputs.map(({ key, body, reason }) => {
    const receipt = required.find((input) => input.key === key);
    return receipt ? readRequiredBody(receipt, body, reason) : { reason };
  });
  const dependentOutcomes = await Promise.all(
    required
      .filter(({ key }) => key !== "session/title" && key !== "session/prompt")
      .map(async (input): Promise<RequiredOutcome> => {
        const key = input.key.split("/");
        switch (key[0]) {
          case "predecessor": {
            const body = await readPredecessor(scope, input, key);
            return body === null
              ? { reason: "A recorded predecessor approval or artifact is unavailable or changed." }
              : { key: input.key, body };
          }
          case "feedback": {
            const body = await readFeedback(scope, input, key);
            return body === null
              ? { reason: "A recorded feedback input is unavailable or changed." }
              : { key: input.key, body };
          }
          case "repository": {
            const parsed = repositoryKey.safeParse(key);
            if (parsed.success) {
              const [, repositoryId, commitSha] = parsed.data;
              if (
                await verifyRepository({
                  repositoryId,
                  commitSha,
                  sha256: input.sha256,
                  utf8Bytes: input.utf8Bytes,
                })
              ) {
                return { key: input.key, repository: { repositoryId, commitSha } };
              }
            }
            return { reason: "A recorded repository context or its exact commit is unavailable." };
          }
          case "specification": {
            const body =
              input === priorDraft
                ? (await specification)?.priorDraft
                : input === clarificationHistory
                  ? (await specification)?.history
                  : input.key === "specification/clarification-available"
                    ? ["true", "false"].find((value) => hasFingerprint(value, input))
                    : undefined;
            return readRequiredBody(input, body, "A recorded specification input is unavailable.");
          }
          default:
            return { reason: "A required run input could not be verified from retained history." };
        }
      }),
  );
  const outcomes = [...originalOutcomes, ...dependentOutcomes];
  const reasons = new Set(
    outcomes.flatMap((outcome) => ("reason" in outcome ? [outcome.reason] : [])),
  );
  return {
    reasons: [...reasons],
    text: outcomes.flatMap((outcome) => ("body" in outcome ? [outcome] : [])),
    repositories: outcomes.flatMap((outcome) =>
      "repository" in outcome ? [outcome.repository] : [],
    ),
  };
}

export async function verifyRequiredRunInputs(...input: Parameters<typeof readRequiredRunInputs>) {
  return (await readRequiredRunInputs(...input)).reasons;
}
