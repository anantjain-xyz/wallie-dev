import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { VALIDATION_EVIDENCE_BUCKET } from "@/lib/validation-evidence/service";

const MAX_ASSET_BYTES = 1024 * 1024;
const ASSET_READ_TIMEOUT_MS = 10_000;
const uuidSchema = z.string().uuid();
const manifestSchema = z.object({
  id: uuidSchema,
  run_id: uuidSchema,
  storage_path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content_type: z.enum(["text/plain", "application/json"]),
  size_bytes: z.number().int().min(0).max(MAX_ASSET_BYTES),
});

type ValidationAsset = Pick<
  Tables<"session_validation_assets">,
  keyof z.output<typeof manifestSchema>
>;

type Withholding = "expired" | "redacted" | "inaccessible" | "unavailable";
type UnavailableAsset = { status: Withholding | "missing" | "integrity_mismatch" };
export type PrivateValidationAssetRead =
  | { status: "available"; bytes: Uint8Array<ArrayBuffer> }
  | UnavailableAsset;

async function readWithholding(
  supabase: SupabaseClient<Database>,
  assetId: string,
  signal: AbortSignal,
): Promise<Withholding | null> {
  const { data, error, status } = await supabase
    .from("session_validation_asset_withholdings")
    .select("state")
    .eq("asset_id", assetId)
    .abortSignal(signal)
    .maybeSingle();
  if (error) return status === 401 || status === 403 ? "inaccessible" : "unavailable";
  if (!data) return null;
  if (data.state === "expired" || data.state === "redacted") return data.state;
  return "unavailable";
}

function storageFailure(error: { status?: number; statusCode?: string }): UnavailableAsset {
  if (
    error.status === 401 ||
    error.status === 403 ||
    error.statusCode === "AccessDenied" ||
    error.statusCode === "InvalidJWT"
  ) {
    return { status: "inaccessible" };
  }
  if (
    error.statusCode === "NoSuchKey" ||
    error.statusCode === "not_found" ||
    error.statusCode === "404" ||
    (error.status === 404 && !error.statusCode)
  ) {
    return { status: "missing" };
  }
  return { status: "unavailable" };
}

async function readExactBytes(stream: ReadableStream<unknown>, size: number, signal: AbortSignal) {
  const bytes = new Uint8Array(size);
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  let offset = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return offset === size ? bytes : null;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > size - offset) {
        // Cancel instead of buffering or reading the rest of an oversized response.
        cancel();
        return null;
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Read the exact bytes of a validation manifest after its caller has scoped it to a run. */
export async function readPrivateValidationAsset(input: {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  asset: ValidationAsset;
  signal?: AbortSignal;
}): Promise<PrivateValidationAssetRead> {
  const { supabase, workspaceId } = input;
  const manifest = manifestSchema.safeParse(input.asset);
  if (!manifest.success || !uuidSchema.safeParse(workspaceId).success) {
    return { status: "integrity_mismatch" };
  }
  const asset = manifest.data;
  const path = `${workspaceId}/${asset.run_id}/${asset.id}`;
  if (asset.storage_path !== path) return { status: "integrity_mismatch" };

  const deadline = AbortSignal.timeout(ASSET_READ_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  try {
    signal.throwIfAborted();
    const before = await readWithholding(supabase, asset.id, signal);
    if (before) return { status: before };
    const { data, error } = await supabase.storage
      .from(VALIDATION_EVIDENCE_BUCKET)
      .download(path, {}, { signal, cache: "no-store" })
      .asStream();
    if (error) {
      const failure = storageFailure(error);
      if (failure.status === "missing" || failure.status === "inaccessible") {
        const withholding = await readWithholding(supabase, asset.id, signal);
        if (withholding) return { status: withholding };
      }
      return failure;
    }
    if (!data) return { status: "unavailable" };
    const bytes = await readExactBytes(data, asset.size_bytes, signal);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      return { status: "integrity_mismatch" };
    }
    // The service role bypasses Storage RLS. Recheck if a disposition arrived
    // during the fetch before handing verified bytes to either caller.
    const after = await readWithholding(supabase, asset.id, signal);
    if (after) return { status: after };
    signal.throwIfAborted();
    return { status: "available", bytes };
  } catch {
    return { status: "unavailable" };
  }
}
