import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import {
  readPrivateBrowserScreenshot,
  readPrivateBrowserVideo,
} from "@/lib/validation-evidence/browser-assets";
import { readPrivateValidationAsset } from "@/lib/validation-evidence/private-asset";

import { readFactoryJudgeCodeDiff } from "./exact-diff";
import {
  MAX_FACTORY_JUDGE_DURATION_MS,
  MAX_FACTORY_JUDGE_SCREENSHOT_BYTES,
  MAX_FACTORY_JUDGE_TEXT_BYTES,
  MAX_FACTORY_JUDGE_VIDEO_BYTES,
  type FactoryJudgeEvidence,
} from "./judge-contracts";
import type { FactoryJudgeClaim, FactoryJudgeEvidenceDescriptor } from "./judge-inputs";

type MaterializedEvidence =
  | { status: "available"; input: FactoryJudgeEvidence }
  | { status: "evidence_unavailable" | "missing_evidence" | "unsupported_evidence" };

function failedAsset(status: string): MaterializedEvidence {
  if (status === "unavailable") return { status: "evidence_unavailable" };
  if (status === "integrity_mismatch") return { status: "unsupported_evidence" };
  return { status: "missing_evidence" };
}

function textInput(
  reference: FactoryJudgeEvidence["reference"] & {
    kind: "artifact" | "validation_report" | "code_diff";
  },
  text: string,
): MaterializedEvidence {
  if (Buffer.byteLength(text, "utf8") > MAX_FACTORY_JUDGE_TEXT_BYTES) {
    return { status: "unsupported_evidence" };
  }
  return { status: "available", input: { mediaType: "text/plain", reference, text } };
}

async function materializeEvidence(
  supabase: SupabaseClient<Database>,
  claim: FactoryJudgeClaim,
  descriptor: FactoryJudgeEvidenceDescriptor,
  signal: AbortSignal,
): Promise<MaterializedEvidence> {
  const { id, kind } = descriptor;
  if (kind === "artifact") return textInput({ id, kind }, descriptor.content_md);
  if (kind === "code_diff") {
    if (id !== claim.run_id || descriptor.output_sha !== claim.target_commit_sha) {
      return { status: "missing_evidence" };
    }
    const { input_sha, output_sha, installation_id, github_repository_id, repository_full_name } =
      descriptor;
    if (input_sha === output_sha) return textInput({ id, kind }, "");
    if (!installation_id || !github_repository_id) return { status: "missing_evidence" };
    const diff = await readFactoryJudgeCodeDiff(
      {
        installationId: installation_id,
        repositoryId: github_repository_id,
        repositoryFullName: repository_full_name,
        inputSha: input_sha,
        outputSha: output_sha,
      },
      signal,
    );
    if (diff.status === "available") return textInput({ id, kind }, diff.text);
    return diff.status === "unsupported"
      ? { status: "unsupported_evidence" }
      : failedAsset(diff.status);
  }
  if (
    descriptor.workspace_id !== claim.workspace_id ||
    descriptor.session_id !== claim.session_id ||
    descriptor.run_id !== claim.run_id
  )
    return { status: "missing_evidence" };

  const scope = {
    supabase,
    workspaceId: claim.workspace_id,
    sessionId: claim.session_id,
    runId: claim.run_id,
    signal,
    asset: descriptor,
  };
  if (kind === "validation_report") {
    if (descriptor.size_bytes > MAX_FACTORY_JUDGE_TEXT_BYTES) {
      return { status: "unsupported_evidence" };
    }
    const asset = await readPrivateValidationAsset({ ...scope, asset: descriptor });
    if (asset.status !== "available") return failedAsset(asset.status);
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(asset.bytes);
      return textInput({ id, kind }, text);
    } catch {
      return { status: "unsupported_evidence" };
    }
  }
  if (kind === "browser_screenshot") {
    if (descriptor.size_bytes > MAX_FACTORY_JUDGE_SCREENSHOT_BYTES) {
      return { status: "unsupported_evidence" };
    }
    const asset = await readPrivateBrowserScreenshot(scope);
    return asset.status === "available"
      ? {
          status: "available",
          input: { mediaType: "image/png", reference: { kind, id }, bytes: asset.bytes },
        }
      : failedAsset(asset.status);
  }
  if (
    descriptor.size_bytes > MAX_FACTORY_JUDGE_VIDEO_BYTES ||
    descriptor.duration_ms > MAX_FACTORY_JUDGE_DURATION_MS
  )
    return { status: "unsupported_evidence" };
  const asset = await readPrivateBrowserVideo(scope);
  return asset.status === "available"
    ? {
        status: "available",
        input: {
          mediaType: "video/webm",
          reference: { id, kind },
          bytes: asset.bytes,
          durationMs: descriptor.duration_ms,
        },
      }
    : failedAsset(asset.status);
}

export async function loadFactoryJudgeEvidence(
  supabase: SupabaseClient<Database>,
  claim: FactoryJudgeClaim,
  descriptors: readonly FactoryJudgeEvidenceDescriptor[],
  rubric: string,
  signal: AbortSignal,
) {
  const evidence: FactoryJudgeEvidence[] = [];
  let textBytes = Buffer.byteLength(rubric, "utf8");
  for (const descriptor of descriptors) {
    signal.throwIfAborted();
    const result = await materializeEvidence(supabase, claim, descriptor, signal);
    if (result.status !== "available") return { status: result.status } as const;
    if (result.input.mediaType === "text/plain") {
      textBytes += Buffer.byteLength(result.input.text, "utf8");
    }
    if (textBytes > MAX_FACTORY_JUDGE_TEXT_BYTES) {
      return { status: "unsupported_evidence" } as const;
    }
    evidence.push(result.input);
  }
  const content = evidence.map((entry) => ({
    ...entry.reference,
    sha256: createHash("sha256")
      .update(entry.mediaType === "text/plain" ? entry.text : entry.bytes)
      .digest("hex"),
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: 1, commit: claim.target_commit_sha, content }))
    .digest("hex");
  return { status: "available", evidence, digest } as const;
}
