import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { readVerifiedPrivateObject } from "@/lib/storage/private-object";
import type { Database } from "@/lib/supabase/database.types";
import { VALIDATION_EVIDENCE_BUCKET } from "./contracts";
import {
  MAX_BROWSER_SCREENSHOT_BYTES,
  MAX_BROWSER_VIDEO_BYTES,
  browserVideoTimelineSchema,
} from "./browser-contract";

const assetSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  session_id: z.string().uuid(),
  run_id: z.string().uuid(),
  storage_path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content_type: z.enum(["image/png", "video/webm"]),
  size_bytes: z.number().int().positive().max(MAX_BROWSER_VIDEO_BYTES),
});

export const BROWSER_ASSET_FIELDS =
  "id, workspace_id, session_id, run_id, storage_path, sha256, content_type, size_bytes";

export function browserScreenshotPath(workspaceId: string, runId: string, assetId: string): string {
  return `${workspaceId}/${runId}/browser/${assetId}.png`;
}

export const BROWSER_VIDEO_ASSET_FIELDS =
  `${BROWSER_ASSET_FIELDS}, duration_ms, width_px, height_px, frame_offsets_ms, capture_started_at, capture_completed_at` as const;

export function browserVideoPath(workspaceId: string, runId: string, assetId: string): string {
  return `${workspaceId}/${runId}/browser/${assetId}.webm`;
}

const videoMetadataSchema = z.object({
  duration_ms: z.number(),
  width_px: z.number(),
  height_px: z.number(),
  frame_offsets_ms: z.array(z.number()),
  capture_started_at: z.string().datetime({ offset: true }),
  capture_completed_at: z.string().datetime({ offset: true }),
});

type PrivateBrowserAssetInput = {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  sessionId: string;
  runId: string;
  asset: unknown;
  signal?: AbortSignal;
};

export async function readPrivateBrowserScreenshot(input: PrivateBrowserAssetInput) {
  return readPrivateBrowserAsset(input, "image/png");
}

export async function readPrivateBrowserVideo(input: PrivateBrowserAssetInput) {
  const parsed = videoMetadataSchema.safeParse(input.asset);
  if (!parsed.success) return { status: "integrity_mismatch" as const };
  const asset = parsed.data;
  if (
    !browserVideoTimelineSchema.safeParse({
      durationMs: asset.duration_ms,
      widthPx: asset.width_px,
      heightPx: asset.height_px,
      frameOffsetsMs: asset.frame_offsets_ms,
    }).success ||
    Date.parse(asset.capture_completed_at) < Date.parse(asset.capture_started_at)
  ) {
    return { status: "integrity_mismatch" as const };
  }
  return readPrivateBrowserAsset(input, "video/webm");
}

/** The caller scopes the manifest to an authorized session or exact worker checkpoint. */
async function readPrivateBrowserAsset(
  input: PrivateBrowserAssetInput,
  contentType: "image/png" | "video/webm",
) {
  const asset = assetSchema.safeParse(input.asset);
  if (
    !asset.success ||
    asset.data.workspace_id !== input.workspaceId ||
    asset.data.session_id !== input.sessionId ||
    asset.data.run_id !== input.runId ||
    asset.data.content_type !== contentType ||
    (contentType === "image/png" && asset.data.size_bytes > MAX_BROWSER_SCREENSHOT_BYTES) ||
    asset.data.storage_path !==
      (contentType === "image/png" ? browserScreenshotPath : browserVideoPath)(
        input.workspaceId,
        input.runId,
        asset.data.id,
      )
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
