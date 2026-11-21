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

function hasFingerprint(body: string | null | undefined, expected: RequiredInput | undefined) {
  if (typeof body !== "string" || !expected) return false;
  const { sha256, utf8Bytes } = fingerprintRunContextInput(body);
  return sha256 === expected.sha256 && utf8Bytes === expected.utf8Bytes;
}

async function verifyPredecessor(scope: Scope, input: RequiredInput, key: string[]) {
  const parsed = predecessorKey.safeParse(key);
  if (!parsed.success) return false;
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
  if (approval.data?.artifact_digest !== input.sha256 || !artifact.data) return false;
  if (artifact.data.stage_id !== null && artifact.data.stage_id !== stageId) return false;

  // The approval digest for legacy artifacts covers PostgreSQL's JSONB text.
  const { artifact_json: body, canonical } = artifact.data;
  return hasFingerprint(typeof body === "string" ? body : canonical, input);
}

async function verifyFeedback(scope: Scope, input: RequiredInput, key: string[]) {
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
    return hasFingerprint(data?.rendered_feedback_text, input);
  }
  const artifact = feedbackArtifactKey.safeParse(key);
  if (!artifact.success) return false;
  const { data, error } = await scope.admin
    .from("session_artifact_feedback")
    .select("feedback_text")
    .eq("workspace_id", scope.workspaceId)
    .eq("session_id", scope.sessionId)
    .eq("id", artifact.data[2])
    .eq("target_version", artifact.data[3])
    .maybeSingle();
  if (error) throw error;
  return hasFingerprint(data?.feedback_text, input);
}

async function verifySpecificationInputs(
  scope: Scope,
  priorDraft: RequiredInput | undefined,
  clarificationHistory: RequiredInput | undefined,
) {
  if (!priorDraft && !clarificationHistory) return true;
  const { admin, workspaceId, sessionId, stageId, recordedAt } = scope;
  if (!stageId || !recordedAt) return false;

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
  if (typeof draft?.artifact_json !== "string") return false;
  if (priorDraft && !hasFingerprint(specificationDraftText(draft.artifact_json), priorDraft)) {
    return false;
  }
  if (!clarificationHistory) return true;

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
  return hasFingerprint(formatSpecificationClarificationHistory(answers), clarificationHistory);
}

export async function verifyRequiredRunInputs(
  scope: Scope,
  required: RunContextManifest["required"],
  original: { title: string | null; prompt: string | null },
  verifyRepository: VerifyRepository,
): Promise<string[]> {
  const title = required.find(({ key }) => key === "session/title");
  const prompt = required.find(({ key }) => key === "session/prompt");
  const priorDraft = required.find(({ key }) => key === "specification/prior-draft");
  const clarificationHistory = required.find(
    ({ key }) => key === "specification/clarification-history",
  );
  const specificationVerified = verifySpecificationInputs(scope, priorDraft, clarificationHistory);
  const dependentReasons = await Promise.all(
    required.map(async (input) => {
      if (input === title || input === prompt) return null;
      const key = input.key.split("/");
      switch (key[0]) {
        case "predecessor":
          return (await verifyPredecessor(scope, input, key))
            ? null
            : "A recorded predecessor approval or artifact is unavailable or changed.";
        case "feedback":
          return (await verifyFeedback(scope, input, key))
            ? null
            : "A recorded feedback input is unavailable or changed.";
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
            )
              return null;
          }
          return "A recorded repository context or its exact commit is unavailable.";
        }
        case "specification": {
          const verified =
            input === priorDraft || input === clarificationHistory
              ? await specificationVerified
              : input.key === "specification/clarification-available" &&
                (hasFingerprint("true", input) || hasFingerprint("false", input));
          return verified ? null : "A recorded specification input is unavailable.";
        }
        default:
          return "A required run input could not be verified from retained history.";
      }
    }),
  );
  return [
    ...new Set(
      [
        hasFingerprint(original.title, title)
          ? null
          : "The original session title is unavailable or changed.",
        hasFingerprint(original.prompt, prompt)
          ? null
          : "The original session prompt is unavailable or changed.",
        ...dependentReasons,
      ].filter((reason) => reason !== null),
    ),
  ];
}
