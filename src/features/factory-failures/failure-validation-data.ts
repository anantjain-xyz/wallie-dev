import "server-only";

import type { FailureCohortMember } from "@/lib/factory-failures/cohort-contracts";
import { readPrivateValidationAsset } from "@/lib/validation-evidence/private-asset";
import { storedEvidenceRecordsSchema } from "@/lib/validation-evidence/read-run-evidence";

import type { loadFailureGroupScope } from "./failure-group-scope";

export async function loadFailureValidation(
  scope: NonNullable<Awaited<ReturnType<typeof loadFailureGroupScope>>>,
  member: FailureCohortMember,
) {
  const { source, session_id: sessionId, run_attempt_count: attempt } = member;
  const { workspaceId, factoryId, currentMember, supabase } = scope;
  const unavailable = (state: "unavailable" | "withheld") => ({ state, evidence: null });
  if (source.kind !== "validation" || currentMember.kind !== "human" || !currentMember.is_active) {
    return unavailable("unavailable");
  }
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return unavailable("unavailable");
  if (source.evidence_state !== "available") return unavailable(source.evidence_state);
  if (!source.validation_record_key || !source.target_commit_sha || !source.target_tree_sha) {
    return unavailable("unavailable");
  }

  const runId = source.validation_run_id;
  const records = await supabase
    .from("session_validation_evidence")
    .select("records")
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .eq("run_id", runId)
    .eq("attempt_count", attempt)
    .eq("commit_sha", source.target_commit_sha)
    .eq("validation_tree_sha", source.target_tree_sha)
    .maybeSingle();
  if (records.error) throw records.error;
  const parsed = storedEvidenceRecordsSchema.safeParse(records.data?.records);
  const checks = parsed.success
    ? parsed.data.filter(({ key }) => key === source.validation_record_key)
    : [];
  const check = checks.length === 1 ? checks[0] : null;
  if (!check) return unavailable("unavailable");

  const logKey = `${check.key}/log`;
  const { data: assets, error } = await supabase
    .from("session_validation_assets")
    .select("id, run_id, evidence_key, kind, storage_path, sha256, content_type, size_bytes")
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .eq("run_id", runId)
    .in("evidence_key", [logKey, ...check.reportKeys])
    .order("evidence_key")
    .limit(100);
  if (error) throw error;
  const log = assets.find((asset) => asset.kind === "log" && asset.evidence_key === logKey);
  const logRead = log
    ? await readPrivateValidationAsset({
        supabase,
        workspaceId,
        asset: log,
        signal: AbortSignal.timeout(2500),
      })
    : null;
  if (logRead?.status === "expired" || logRead?.status === "redacted") {
    return unavailable("withheld");
  }
  const logPreview =
    logRead?.status === "available"
      ? new TextDecoder().decode(logRead.bytes.subarray(0, 16_384))
      : null;
  return {
    state: "available" as const,
    evidence: {
      check,
      runId,
      logPreview,
      truncated: logRead?.status === "available" && logRead.bytes.byteLength > 16_384,
      logId: logPreview !== null ? log?.id : undefined,
      logUnavailable: Boolean(log && logPreview === null),
      reports: assets.filter(
        (asset) => asset.kind !== "log" && check.reportKeys.includes(asset.evidence_key),
      ),
    },
  };
}
