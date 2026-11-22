import "server-only";

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json, Tables } from "@/lib/supabase/database.types";

import {
  BROWSER_VIDEO_ASSET_FIELDS,
  readPrivateBrowserScreenshot,
  readPrivateBrowserVideo,
} from "./browser-assets";
import {
  browserCaptureReceiptSchema,
  browserRunIdentitySchema,
  isBrowserEvidenceRequirement,
  type BrowserVerificationEvidence,
} from "./browser-contract";
import { validationPlanSchema, type ValidationEvidenceRecord } from "./contracts";
import { evaluateValidationEvidence } from "./evaluate";
import { readPrivateValidationAsset } from "./private-asset";

type AdminClient = SupabaseClient<Database>;

/** Stored OP-507 harness receipts are re-validated before any can support Ready. */
const storedEvidenceRecordSchema = z.object({
  key: z.string().min(1).max(200),
  command: z.string(),
  provenance: z.literal("harness"),
  status: z.enum(["passed", "failed", "stale", "error"]),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  commitSha: z.string().nullable(),
  treeSha: z.string().nullable(),
  finalCommitSha: z.string().nullable(),
  finalTreeSha: z.string().nullable(),
  reportKeys: z.array(z.string().max(200)),
  missingRequiredReports: z.array(z.string().max(200)),
});

export const storedEvidenceRecordsSchema = z.array(storedEvidenceRecordSchema).max(100);

export type StoredEvidenceRecord = z.infer<typeof storedEvidenceRecordSchema>;

const MAX_EVIDENCE_ASSETS = 100;
const ASSET_READ_CONCURRENCY = 4;
const ASSET_READ_TIMEOUT_MS = 5_000;
const storedEvidenceAssetManifestSchema = z
  .array(
    z.object({
      id: z.string(),
      key: z.string(),
      kind: z.enum(["report", "screenshot", "preview", "log"]),
      required: z.boolean(),
      storagePath: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      contentType: z.enum(["text/plain", "application/json"]),
      sizeBytes: z.number().int().nonnegative(),
    }),
  )
  .max(MAX_EVIDENCE_ASSETS);

export type RunEvidenceIdentity = Pick<
  Tables<"session_validation_evidence">,
  "workspace_id" | "session_id" | "run_id" | "job_id" | "attempt_count" | "repository_id"
>;

function sameRunEvidenceIdentity(actual: RunEvidenceIdentity, expected: RunEvidenceIdentity) {
  return (
    actual.workspace_id === expected.workspace_id &&
    actual.session_id === expected.session_id &&
    actual.run_id === expected.run_id &&
    actual.job_id === expected.job_id &&
    actual.attempt_count === expected.attempt_count &&
    actual.repository_id === expected.repository_id
  );
}

async function readBrowserEvidence({
  admin,
  workspaceId,
  sessionId,
  checkpoint,
  plan,
  requiredKeys,
}: {
  admin: AdminClient;
  workspaceId: string;
  sessionId: string;
  checkpoint: RetainedValidationSource;
  plan: RunEvidenceIdentity & { commit_sha: string; validation_tree_sha: string; plan: Json };
  requiredKeys: string[];
}): Promise<BrowserVerificationEvidence | null> {
  const parsed = validationPlanSchema.safeParse(plan.plan);
  if (!parsed.success || parsed.data.version !== 2) return null;
  const recordedIdentity = browserRunIdentitySchema.safeParse({
    runId: plan.run_id,
    attemptCount: plan.attempt_count,
    commitSha: plan.commit_sha,
    treeSha: plan.validation_tree_sha,
  });
  if (!recordedIdentity.success) return null;

  const { data, error } = await admin
    .from("session_browser_verification_receipts")
    .select("records")
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .eq("run_id", checkpoint.run_id)
    .maybeSingle();
  if (error || !data) return null;
  const receipts = z.array(browserCaptureReceiptSchema).max(10).safeParse(data.records);
  if (!receipts.success) return null;

  const accessibleAssetDigests = new Map<string, string>();
  const required = new Set(requiredKeys);
  const requirements = receipts.data.flatMap((receipt) =>
    receipt.status === "captured" && required.has(`browser:${receipt.kind}:${receipt.key}`)
      ? [receipt]
      : [],
  );
  const expectedTreeSha = checkpoint.validation_tree_sha ?? plan.validation_tree_sha;
  if (
    checkpoint.output_sha === plan.commit_sha &&
    expectedTreeSha === plan.validation_tree_sha &&
    requirements.length
  ) {
    const { data: assets } = await admin
      .from("session_browser_verification_assets")
      .select(BROWSER_VIDEO_ASSET_FIELDS)
      .eq("workspace_id", workspaceId)
      .eq("session_id", sessionId)
      .eq("run_id", checkpoint.run_id)
      .in(
        "id",
        requirements.map(({ manifest }) => manifest.assetId),
      );
    const byId = new Map((assets ?? []).map((asset) => [asset.id, asset]));
    for (let offset = 0; offset < requirements.length; offset += ASSET_READ_CONCURRENCY) {
      await Promise.all(
        requirements.slice(offset, offset + ASSET_READ_CONCURRENCY).map(async (receipt) => {
          const { manifest } = receipt;
          const asset = byId.get(manifest.assetId);
          if (
            !asset ||
            asset.sha256 !== manifest.sha256 ||
            asset.size_bytes !== manifest.sizeBytes
          ) {
            return;
          }
          if (
            receipt.kind === "video" &&
            (asset.duration_ms !== receipt.manifest.durationMs ||
              asset.width_px !== receipt.manifest.widthPx ||
              asset.height_px !== receipt.manifest.heightPx ||
              !asset.frame_offsets_ms ||
              asset.frame_offsets_ms.length !== receipt.manifest.frameOffsetsMs.length ||
              asset.frame_offsets_ms.some(
                (time, index) => time !== receipt.manifest.frameOffsetsMs[index],
              ) ||
              Date.parse(asset.capture_started_at ?? "") !== Date.parse(receipt.startedAt) ||
              Date.parse(asset.capture_completed_at ?? "") !== Date.parse(receipt.completedAt))
          ) {
            return;
          }
          const read =
            receipt.kind === "video" ? readPrivateBrowserVideo : readPrivateBrowserScreenshot;
          const result = await read({
            supabase: admin,
            workspaceId,
            sessionId,
            runId: checkpoint.run_id,
            asset,
            signal: AbortSignal.timeout(ASSET_READ_TIMEOUT_MS),
          });
          if (result.status === "available") accessibleAssetDigests.set(asset.id, asset.sha256);
        }),
      );
    }
  }

  return {
    expectedIdentity: {
      runId: checkpoint.run_id,
      attemptCount: checkpoint.attempt_count,
      commitSha: checkpoint.output_sha,
      treeSha: expectedTreeSha,
    },
    recordedIdentity: recordedIdentity.data,
    plan: parsed.data.browser,
    receipts: receipts.data,
    accessibleAssetDigests,
  };
}

async function readRequiredEvidenceAssets({
  admin,
  workspaceId,
  evidence,
  assets,
  requiredKeys,
}: {
  admin: AdminClient;
  workspaceId: string;
  evidence: Pick<
    Tables<"session_validation_evidence">,
    "assets" | "commit_sha" | "validation_tree_sha"
  > & {
    records: ValidationEvidenceRecord[];
  };
  assets: Tables<"session_validation_assets">[];
  requiredKeys: string[];
}) {
  if (!requiredKeys.length) return new Set<string>();
  const manifest = storedEvidenceAssetManifestSchema.safeParse(evidence.assets);
  if (!manifest.success) return new Set<string>();

  const receiptByKey = new Map(manifest.data.map((item) => [item.key, item]));
  if (receiptByKey.size !== manifest.data.length) return new Set<string>();
  const candidates = new Map(
    assets
      .filter((asset) => {
        const receipt = receiptByKey.get(asset.evidence_key);
        return (
          receipt?.required &&
          asset.required &&
          asset.kind !== "log" &&
          receipt.id === asset.id &&
          receipt.kind === asset.kind &&
          receipt.storagePath === asset.storage_path &&
          receipt.sha256 === asset.sha256 &&
          receipt.contentType === asset.content_type &&
          receipt.sizeBytes === asset.size_bytes
        );
      })
      .map((asset) => [asset.evidence_key, asset]),
  );
  // The receipt must already prove the exact unchanged code. Only download
  // reports that could move one of the policy's required commands to passed.
  const eligible = new Set(
    evaluateValidationEvidence({
      requiredKeys,
      commitSha: evidence.commit_sha,
      treeSha: evidence.validation_tree_sha,
      records: evidence.records,
      accessibleAssetKeys: new Set(candidates.keys()),
    })
      .filter(({ status }) => status === "passed")
      .map(({ key }) => key),
  );
  const needed = new Set(
    evidence.records
      .filter((record) => eligible.has(record.key))
      .flatMap((record) => record.reportKeys),
  );
  const queue = [...candidates.values()].filter((asset) => needed.has(asset.evidence_key));
  const verified = new Set<string>();
  if (!queue.length) return verified;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Set<string>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(new Set());
    }, ASSET_READ_TIMEOUT_MS);
  });
  const verify = async () => {
    for (let asset = queue.shift(); asset && !controller.signal.aborted; asset = queue.shift()) {
      try {
        const result = await readPrivateValidationAsset({
          supabase: admin,
          workspaceId,
          asset,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && result.status === "available")
          verified.add(asset.evidence_key);
      } catch {
        // An inaccessible report cannot satisfy the command, even if its row exists.
      }
    }
  };
  try {
    return await Promise.race([
      Promise.all(
        Array.from({ length: Math.min(queue.length, ASSET_READ_CONCURRENCY) }, verify),
      ).then(() => verified),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

type RetainedValidationSource = RunEvidenceIdentity & {
  output_sha: string;
  /** Older accepted PR checkpoints identify the commit and derive the tree from evidence. */
  validation_tree_sha?: string;
};

export type ExactRunValidationSource = RetainedValidationSource & {
  validation_tree_sha: string;
};

/** Read the exact run's command and browser evidence and verify required private assets. */
export async function readRetainedRunValidationEvidence({
  admin,
  checkpoint,
  requiredKeys,
}: {
  admin: AdminClient;
  checkpoint: RetainedValidationSource | null;
  requiredKeys: string[];
}) {
  if (!checkpoint) {
    return {
      evidenceRow: null,
      evidence: null,
      evidenceAssets: [],
      accessibleAssetKeys: new Set<string>(),
      browserEvidence: null,
    };
  }

  const [evidenceResult, planResult] = await Promise.all([
    admin
      .from("session_validation_evidence")
      .select(
        "workspace_id, session_id, run_id, job_id, attempt_count, repository_id, commit_sha, validation_tree_sha, records, assets, created_at",
      )
      .eq("workspace_id", checkpoint.workspace_id)
      .eq("session_id", checkpoint.session_id)
      .eq("run_id", checkpoint.run_id)
      .maybeSingle(),
    requiredKeys.length
      ? admin
          .from("session_validation_plans")
          .select(
            "workspace_id, session_id, run_id, job_id, attempt_count, repository_id, commit_sha, validation_tree_sha, plan",
          )
          .eq("workspace_id", checkpoint.workspace_id)
          .eq("session_id", checkpoint.session_id)
          .eq("run_id", checkpoint.run_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (evidenceResult.error || planResult.error)
    throw new Error("Validation evidence is unavailable.");
  const evidenceRow =
    evidenceResult.data && sameRunEvidenceIdentity(evidenceResult.data, checkpoint)
      ? evidenceResult.data
      : null;
  const parsedRecords = evidenceRow
    ? storedEvidenceRecordsSchema.safeParse(evidenceRow.records)
    : null;
  const plan = planResult.data;
  const evidenceMatchesAcceptedSource = Boolean(
    evidenceRow &&
    evidenceRow.commit_sha === checkpoint.output_sha &&
    (checkpoint.validation_tree_sha === undefined ||
      checkpoint.validation_tree_sha === evidenceRow.validation_tree_sha) &&
    (!plan ||
      (sameRunEvidenceIdentity(plan, checkpoint) &&
        plan.commit_sha === checkpoint.output_sha &&
        plan.validation_tree_sha === evidenceRow.validation_tree_sha)),
  );
  let accessibleAssetKeys: ReadonlySet<string> = new Set();
  let evidenceAssets: Tables<"session_validation_assets">[] = [];
  if (evidenceRow && parsedRecords?.success) {
    const { data: assets, error: assetError } = await admin
      .from("session_validation_assets")
      .select(
        "id, workspace_id, session_id, run_id, evidence_key, kind, required, size_bytes, storage_path, sha256, content_type",
      )
      .eq("workspace_id", checkpoint.workspace_id)
      .eq("session_id", checkpoint.session_id)
      .eq("run_id", evidenceRow.run_id)
      .order("id", { ascending: true })
      .limit(MAX_EVIDENCE_ASSETS);
    if (assetError) throw new Error("Validation evidence assets are unavailable.");
    const scopedAssets = (assets ?? []).filter(
      (asset) =>
        asset.workspace_id === evidenceRow.workspace_id &&
        asset.session_id === evidenceRow.session_id &&
        asset.run_id === evidenceRow.run_id,
    );
    evidenceAssets = scopedAssets;
    if (evidenceMatchesAcceptedSource) {
      accessibleAssetKeys = await readRequiredEvidenceAssets({
        admin,
        workspaceId: checkpoint.workspace_id,
        evidence: { ...evidenceRow, records: parsedRecords.data },
        assets: scopedAssets,
        requiredKeys,
      });
    }
  }

  const browserEvidence =
    plan &&
    sameRunEvidenceIdentity(plan, checkpoint) &&
    requiredKeys.some(isBrowserEvidenceRequirement)
      ? await readBrowserEvidence({
          admin,
          workspaceId: checkpoint.workspace_id,
          sessionId: checkpoint.session_id,
          checkpoint,
          plan,
          requiredKeys,
        })
      : null;

  return {
    evidenceRow,
    evidence:
      parsedRecords?.success && evidenceRow
        ? {
            commitSha: evidenceRow.commit_sha,
            validationTreeSha: evidenceRow.validation_tree_sha,
            records: evidenceMatchesAcceptedSource
              ? parsedRecords.data
              : parsedRecords.data.map(
                  (record): StoredEvidenceRecord => ({
                    ...record,
                    status: "stale",
                  }),
                ),
            accessibleAssetKeys,
          }
        : null,
    evidenceAssets,
    accessibleAssetKeys,
    browserEvidence,
  };
}

/** Evaluate required evidence against an independently pinned run, commit, and validation tree. */
export async function evaluateExactRunValidationEvidence({
  admin,
  source,
  requiredKeys,
}: {
  admin: AdminClient;
  source: ExactRunValidationSource;
  requiredKeys: string[];
}) {
  const { evidence, accessibleAssetKeys, browserEvidence } =
    await readRetainedRunValidationEvidence({
      admin,
      checkpoint: source,
      requiredKeys,
    });
  return evaluateValidationEvidence({
    requiredKeys,
    commitSha: source.output_sha,
    treeSha: source.validation_tree_sha,
    records: evidence?.records ?? [],
    accessibleAssetKeys,
    browserEvidence,
  });
}
