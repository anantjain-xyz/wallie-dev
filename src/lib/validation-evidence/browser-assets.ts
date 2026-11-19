import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { readVerifiedPrivateObject } from "@/lib/storage/private-object";
import type { Database } from "@/lib/supabase/database.types";
import { VALIDATION_EVIDENCE_BUCKET } from "./contracts";
import { MAX_BROWSER_SCREENSHOT_BYTES } from "./browser-contract";

const assetSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  session_id: z.string().uuid(),
  run_id: z.string().uuid(),
  storage_path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content_type: z.literal("image/png"),
  size_bytes: z.number().int().positive().max(MAX_BROWSER_SCREENSHOT_BYTES),
});

export const BROWSER_ASSET_FIELDS =
  "id, workspace_id, session_id, run_id, storage_path, sha256, content_type, size_bytes";

export function browserScreenshotPath(workspaceId: string, runId: string, assetId: string): string {
  return `${workspaceId}/${runId}/browser/${assetId}.png`;
}

/** The caller scopes the manifest to an authorized session or an exact worker checkpoint. */
export async function readPrivateBrowserScreenshot(input: {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  sessionId: string;
  runId: string;
  asset: unknown;
  signal?: AbortSignal;
}) {
  const asset = assetSchema.safeParse(input.asset);
  if (
    !asset.success ||
    asset.data.workspace_id !== input.workspaceId ||
    asset.data.session_id !== input.sessionId ||
    asset.data.run_id !== input.runId ||
    asset.data.storage_path !== browserScreenshotPath(input.workspaceId, input.runId, asset.data.id)
  ) {
    return { status: "integrity_mismatch" as const };
  }
  const deadline = AbortSignal.timeout(10_000);
  return readVerifiedPrivateObject({
    supabase: input.supabase,
    bucket: VALIDATION_EVIDENCE_BUCKET,
    path: asset.data.storage_path,
    sizeBytes: asset.data.size_bytes,
    sha256: asset.data.sha256,
    signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
  });
}
