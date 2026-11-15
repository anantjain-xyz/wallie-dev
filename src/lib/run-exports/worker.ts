import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  redactRunSensitiveText,
  redactRunToolText,
} from "@/lib/agent-runner/redact-sensitive-text";
import type { Database } from "@/lib/supabase/database.types";
import { readPrivateValidationAsset } from "@/lib/validation-evidence/private-asset";
import { removeWorkspaceStoragePrefix } from "@/lib/workspaces/deletion";

import {
  MAX_RUN_EXPORT_PAGE_BYTES,
  RUN_EXPORT_BUCKET,
  runExportObjectSchema,
  writeRunExportObject,
} from "./storage";

type AdminClient = SupabaseClient<Database>;

const PAGE_LIMIT = 25;
const RECORD_CONCURRENCY = 4;
const PAGES_PER_LEASE = 12;
const JOBS_PER_TICK = 4;
const WORK_BUDGET_MS = 100_000;
const RPC_TIMEOUT_MS = 10_000;

const uuid = z.string().uuid();
const ordinal = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const jobScope = z.object({ export_id: uuid, workspace_id: uuid });
const claimSchema = jobScope.extend({
  lease_token: uuid,
  snapshot_at: z.string().datetime({ offset: true }),
  next_ordinal: ordinal,
  status: z.literal("running"),
});
const resultAvailability = z.enum([
  "available",
  "metadata_only",
  "gap",
  "missing",
  "inaccessible",
  "redacted",
  "expired",
]);
const rowSchema = z.object({
  ordinal,
  record_kind: z.enum([
    "run",
    "event",
    "legacy_message",
    "stage_markdown",
    "checkpoint",
    "validation_receipt",
    "validation_asset",
    "capture_gap",
  ]),
  record_id: uuid,
  run_id: uuid.nullable(),
  availability: z.union([resultAvailability, z.literal("recorded")]),
  metadata: z.record(z.unknown()),
  payload: z.unknown(),
  source_asset_id: uuid.nullable(),
});
const assetMetadata = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024),
  content_type: z.enum(["application/json", "text/plain"]),
});

type RunExportClaim = z.infer<typeof claimSchema>;
type SourceRow = z.infer<typeof rowSchema>;
type Availability = z.infer<typeof resultAvailability>;
type ExportAsset = {
  id: string;
  url: string;
  contentType: "application/json" | "text/plain";
  sha256: string;
  sizeBytes: number;
};
type ExportRecord = {
  ordinal: number;
  kind: SourceRow["record_kind"];
  id: string;
  runId: string | null;
  availability: Availability;
  metadata: SourceRow["metadata"];
  payload: unknown;
  payloadEncoding?: "base64";
  asset?: ExportAsset;
  reason?: "integrity_mismatch";
};

async function materializeRecord(
  admin: AdminClient,
  claim: RunExportClaim,
  row: SourceRow,
  signal: AbortSignal,
): Promise<ExportRecord> {
  const identity = {
    ordinal: row.ordinal,
    kind: row.record_kind,
    id: row.record_id,
    runId: row.run_id,
    metadata: row.metadata,
  };
  if (row.availability !== "recorded") {
    let payload: unknown = null;
    if (row.availability === "available" || row.availability === "gap") {
      if (row.record_kind === "legacy_message") {
        if (typeof row.payload !== "string") {
          return { ...identity, availability: "inaccessible", payload: null };
        }
        payload =
          row.metadata.kind === "tool_use"
            ? redactRunToolText(row.payload)
            : redactRunSensitiveText(row.payload);
      } else {
        payload = row.payload ?? null;
      }
    }
    // Control characters can expand a one MiB string past the whole response limit.
    if (
      typeof payload === "string" &&
      Buffer.byteLength(JSON.stringify(payload)) > MAX_RUN_EXPORT_PAGE_BYTES / 2
    ) {
      return {
        ...identity,
        availability: row.availability,
        payload: Buffer.from(payload, "utf8").toString("base64"),
        payloadEncoding: "base64",
      };
    }
    return { ...identity, availability: row.availability, payload };
  }

  const unavailable = (availability: Availability): ExportRecord => ({
    ...identity,
    availability,
    payload: null,
  });
  const mismatch = (): ExportRecord => ({
    ...unavailable("inaccessible"),
    reason: "integrity_mismatch",
  });
  const expected = assetMetadata.safeParse(row.metadata);
  if (
    row.record_kind !== "validation_asset" ||
    !row.run_id ||
    row.source_asset_id !== row.record_id ||
    !expected.success
  ) {
    return mismatch();
  }

  const { data: asset, error } = await admin
    .from("session_validation_assets")
    .select("id, run_id, sha256, size_bytes, content_type, storage_path")
    .eq("id", row.source_asset_id)
    .eq("run_id", row.run_id)
    .eq("workspace_id", claim.workspace_id)
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw new Error("Export asset metadata will retry.");
  if (!asset) return unavailable("missing");
  if (
    asset.id !== row.source_asset_id ||
    asset.run_id !== row.run_id ||
    asset.sha256 !== expected.data.sha256 ||
    asset.size_bytes !== expected.data.size_bytes ||
    asset.content_type !== expected.data.content_type
  ) {
    return mismatch();
  }

  const result = await readPrivateValidationAsset({
    supabase: admin,
    workspaceId: claim.workspace_id,
    asset,
    signal,
  });
  if (result.status === "unavailable") throw new Error("Export source storage will retry.");
  if (result.status === "integrity_mismatch") return mismatch();
  if (result.status !== "available") return unavailable(result.status);

  const exportedAsset = {
    id: asset.id,
    url: `/api/workspaces/${claim.workspace_id}/run-exports/${claim.export_id}/objects/asset/${asset.id}`,
    contentType: expected.data.content_type,
    sha256: asset.sha256,
    sizeBytes: asset.size_bytes,
  };
  await writeRunExportObject({
    supabase: admin,
    workspaceId: claim.workspace_id,
    exportId: claim.export_id,
    object: { kind: "asset", assetId: asset.id, ...exportedAsset },
    bytes: result.bytes,
    signal,
  });
  return { ...identity, availability: "available", payload: null, asset: exportedAsset };
}

async function materializePage(
  admin: AdminClient,
  claim: RunExportClaim,
  rows: SourceRow[],
  signal: AbortSignal,
) {
  const records: ExportRecord[] = [];
  for (let offset = 0; offset < rows.length; offset += RECORD_CONCURRENCY) {
    signal.throwIfAborted();
    const batch = await Promise.allSettled(
      rows
        .slice(offset, offset + RECORD_CONCURRENCY)
        .map((row) => materializeRecord(admin, claim, row, signal)),
    );
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      records.push(result.value);
    }
  }
  return records;
}

function encodePage(claim: RunExportClaim, firstOrdinal: number, candidates: ExportRecord[]) {
  const header = {
    schemaVersion: 1,
    workspaceId: claim.workspace_id,
    exportId: claim.export_id,
    snapshotAt: claim.snapshot_at,
    firstOrdinal,
    lastOrdinal: firstOrdinal + candidates.length - 1,
  };
  let size = Buffer.byteLength(JSON.stringify({ ...header, records: [] }));
  const records: ExportRecord[] = [];
  for (const candidate of candidates) {
    size += Buffer.byteLength(JSON.stringify(candidate)) + (records.length ? 1 : 0);
    if (size > MAX_RUN_EXPORT_PAGE_BYTES) break;
    records.push(candidate);
  }
  if (records.length === 0) throw new Error("Export record exceeds the page byte limit.");
  const lastOrdinal = firstOrdinal + records.length - 1;
  const bytes = new TextEncoder().encode(JSON.stringify({ ...header, lastOrdinal, records }));
  return { bytes, records, lastOrdinal };
}

async function processRunExport(admin: AdminClient, claim: RunExportClaim, signal: AbortSignal) {
  const key = { p_export_id: claim.export_id, p_lease_token: claim.lease_token };
  let nextOrdinal = claim.next_ordinal;

  for (let pageCount = 0; pageCount < PAGES_PER_LEASE; pageCount++) {
    signal.throwIfAborted();
    const { data, error } = await admin
      .rpc("read_run_export_page", { ...key, p_limit: PAGE_LIMIT })
      .abortSignal(signal);
    if (error) throw new Error("Export page read will retry.");
    const rows = z.array(rowSchema).max(PAGE_LIMIT).parse(data);
    if (rows.length === 0) {
      const { data: completed, error: finishError } = await admin
        .rpc("complete_run_export", key)
        .abortSignal(signal);
      if (finishError) throw new Error("Export completion will retry.");
      return completed === true;
    }
    if (rows.some((row, offset) => row.ordinal !== nextOrdinal + offset)) {
      throw new Error("Export page did not match its durable cursor.");
    }

    const candidates = await materializePage(admin, claim, rows, signal);
    const { bytes, records, lastOrdinal } = encodePage(claim, nextOrdinal, candidates);
    const object = runExportObjectSchema.parse({
      kind: "page",
      firstOrdinal: nextOrdinal,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      contentType: "application/json",
    });
    await writeRunExportObject({
      supabase: admin,
      workspaceId: claim.workspace_id,
      exportId: claim.export_id,
      object,
      bytes,
      signal,
    });

    const { data: committed, error: commitError } = await admin
      .rpc("commit_run_export_page", {
        ...key,
        p_first_ordinal: nextOrdinal,
        p_page_sha256: object.sha256,
        p_page_size_bytes: object.sizeBytes,
        p_entries: records.map((record) => ({
          ordinal: record.ordinal,
          availability: record.availability,
          ...(record.asset && {
            asset_sha256: record.asset.sha256,
            asset_size_bytes: record.asset.sizeBytes,
          }),
        })),
      })
      .abortSignal(signal);
    if (commitError) throw new Error("Export page commit will retry.");
    if (committed !== true) return false;
    nextOrdinal = lastOrdinal + 1;
  }
  return false;
}

/** Drain bounded pages in both worker runtimes. Only the durable cursor advances work. */
export async function drainRunExports(admin: AdminClient) {
  const signal = AbortSignal.timeout(WORK_BUDGET_MS);
  for (let count = 0; count < JOBS_PER_TICK && !signal.aborted; count++) {
    const { data, error } = await admin.rpc("claim_run_export").abortSignal(signal).maybeSingle();
    if (error) throw new Error("Could not claim a run export.");
    if (!data) return;

    const claim = claimSchema.parse(data);
    let completed = false;
    try {
      completed = await processRunExport(admin, claim, signal);
    } catch {
      console.warn("[run-exports] release for retry", { exportId: claim.export_id });
    } finally {
      if (!completed) {
        const { error: releaseError } = await admin
          .rpc("release_run_export", {
            p_export_id: claim.export_id,
            p_lease_token: claim.lease_token,
          })
          .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
        if (releaseError) {
          console.warn("[run-exports] lease will expire", { exportId: claim.export_id });
        }
      }
    }
  }
}

export async function cleanupRunExports(admin: AdminClient) {
  const { data, error } = await admin
    .rpc("list_run_export_cleanup", { p_limit: 2 })
    .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
  if (error) throw new Error("Could not list run exports for cleanup.");

  for (const scope of z.array(jobScope).max(2).parse(data)) {
    try {
      await removeWorkspaceStoragePrefix(
        admin,
        RUN_EXPORT_BUCKET,
        `${scope.workspace_id}/${scope.export_id}`,
      );
      const { error: finishError } = await admin
        .rpc("finish_run_export_cleanup", {
          p_export_id: scope.export_id,
          p_workspace_id: scope.workspace_id,
        })
        .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
      if (finishError) throw new Error("Export storage cleanup will retry.");
    } catch {
      console.warn("[run-exports] cleanup will retry", { exportId: scope.export_id });
    }
  }
}
