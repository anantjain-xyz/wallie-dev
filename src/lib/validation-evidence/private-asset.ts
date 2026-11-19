import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  readVerifiedPrivateObject,
  type VerifiedPrivateObject,
} from "@/lib/storage/private-object";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { VALIDATION_EVIDENCE_BUCKET } from "@/lib/validation-evidence/contracts";

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
export type PrivateValidationAssetRead = VerifiedPrivateObject | { status: Withholding };

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
    const result = await readVerifiedPrivateObject({
      supabase,
      bucket: VALIDATION_EVIDENCE_BUCKET,
      path,
      sizeBytes: asset.size_bytes,
      sha256: asset.sha256,
      signal,
    });
    if (result.status === "missing" || result.status === "inaccessible") {
      const withholding = await readWithholding(supabase, asset.id, signal);
      if (withholding) return { status: withholding };
    }
    if (result.status !== "available") return result;
    // The service role bypasses Storage RLS. Recheck if a disposition arrived
    // during the fetch before handing verified bytes to either caller.
    const after = await readWithholding(supabase, asset.id, signal);
    if (after) return { status: after };
    signal.throwIfAborted();
    return result;
  } catch {
    return { status: "unavailable" };
  }
}
