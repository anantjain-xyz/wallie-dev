import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";
import { browserScreenshotPath, browserVideoPath } from "./browser-assets";
import {
  BROWSER_CAPTURE_POLICY,
  MAX_BROWSER_VIDEO_BYTES,
  browserCaptureReceiptSchema,
  type BrowserCaptureReceipt,
  type BrowserRunIdentity,
  type BrowserScreenshotRuntime,
  type BrowserVerificationPlan,
  type BrowserVideoRuntime,
} from "./browser-contract";
import { VALIDATION_EVIDENCE_BUCKET } from "./contracts";
import { sanitizeBrowserScreenshot } from "./screenshot-png";

type AdminClient = SupabaseClient<Database>;
type CaptureKind = BrowserVerificationPlan[number]["evidence"][number]["kind"];
type CaptureRequest =
  | { kind: "screenshot"; runtime: BrowserScreenshotRuntime }
  | { kind: "video"; runtime: BrowserVideoRuntime };

function browserIdentityArgs(identity: BrowserRunIdentity) {
  return {
    p_run_id: identity.runId,
    p_attempt_count: identity.attemptCount,
    p_commit_sha: identity.commitSha,
    p_validation_tree_sha: identity.treeSha,
  };
}

function sameIdentity(actual: BrowserRunIdentity, expected: BrowserRunIdentity) {
  return (
    actual.runId === expected.runId &&
    actual.attemptCount === expected.attemptCount &&
    actual.commitSha === expected.commitSha &&
    actual.treeSha === expected.treeSha
  );
}

function receiptIdentity(check: BrowserVerificationPlan[number], kind: CaptureKind) {
  return { key: check.key, kind, path: check.path, policy: BROWSER_CAPTURE_POLICY } as const;
}

type BrowserAssetTransfer = { assetId: string; operationId: string };

async function captureOneMedia(input: {
  admin: AdminClient;
  workspaceId: string;
  request: CaptureRequest;
  identity: BrowserRunIdentity;
  check: BrowserVerificationPlan[number];
  signal?: AbortSignal;
}): Promise<{ receipt: BrowserCaptureReceipt; transfer?: BrowserAssetTransfer }> {
  const { admin, workspaceId, request, identity, check, signal } = input;
  const base = receiptIdentity(check, request.kind);
  const failed = { ...base, status: "failed", reason: "capture_failed" } as const;
  try {
    const captureInput = { identity, check, signal };
    const capture =
      request.kind === "screenshot"
        ? {
            kind: "screenshot" as const,
            result: await request.runtime.captureScreenshot(captureInput),
          }
        : { kind: "video" as const, result: await request.runtime.captureVideo(captureInput) };
    const { kind, result } = capture;
    signal?.throwIfAborted();
    if (result.status !== "captured") {
      return { receipt: browserCaptureReceiptSchema.parse({ ...base, ...result }) };
    }
    if (result.path !== check.path || !sameIdentity(result.identity, identity)) {
      return { receipt: failed };
    }
    const assetId = randomUUID();
    const video = kind === "video" ? result : null;
    const bytes = video ? video.bytes : sanitizeBrowserScreenshot(result.bytes);
    if (!bytes) return { receipt: failed };
    if (video) {
      const elapsedMs = Date.parse(video.completedAt) - Date.parse(video.startedAt);
      if (
        bytes.length < 4 ||
        bytes.length > MAX_BROWSER_VIDEO_BYTES ||
        bytes.readUInt32BE(0) !== 0x1a45dfa3 ||
        video.timeline.frameOffsetsMs.length !== check.interactions.length + 1 ||
        video.timeline.durationMs > check.timeoutSeconds * 1000 ||
        elapsedMs < 0 ||
        elapsedMs > check.timeoutSeconds * 1000
      ) {
        return { receipt: failed };
      }
    }
    const contentType = video ? "video/webm" : "image/png";
    const receipt = browserCaptureReceiptSchema.safeParse({
      ...base,
      status: "captured",
      browserSessionId: result.browserSessionId,
      ...(video ? { startedAt: video.startedAt, completedAt: video.completedAt } : {}),
      manifest: {
        assetId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType,
        sizeBytes: bytes.length,
        ...video?.timeline,
      },
    });
    if (!receipt.success) return { receipt: failed };
    const path = video ? browserVideoPath : browserScreenshotPath;
    const { operationId, error } = await uploadWorkspaceObject(admin, {
      bucket: VALIDATION_EVIDENCE_BUCKET,
      workspaceId,
      path: path(workspaceId, identity.runId, assetId),
      bytes,
      contentType,
      deferTransfer: true,
      signal,
    });
    if (error) return { receipt: failed };
    return { receipt: receipt.data, transfer: { assetId, operationId } };
  } catch {
    signal?.throwIfAborted();
    return { receipt: failed };
  }
}

async function recordWithoutMedia(
  admin: AdminClient,
  identity: BrowserRunIdentity,
  records: BrowserCaptureReceipt[],
  signal?: AbortSignal,
) {
  const request = admin.rpc("record_session_browser_verification", {
    ...browserIdentityArgs(identity),
    p_records: records,
  });
  return await (signal ? request.abortSignal(signal) : request);
}

async function captureAvailability(input: {
  admin: AdminClient;
  identity: BrowserRunIdentity;
  approvedToolIds?: readonly string[];
  request: CaptureRequest | undefined;
  signal?: AbortSignal;
}): Promise<"tool_not_approved" | "runtime_unavailable" | null> {
  const { admin, request, identity, approvedToolIds, signal } = input;
  if (
    approvedToolIds?.length === 0 ||
    (request && !approvedToolIds?.includes(request.runtime.approvalScopeId))
  ) {
    return "tool_not_approved";
  }
  if (!request) return "runtime_unavailable";
  const args = {
    ...browserIdentityArgs(identity),
    p_approval_scope_id: request.runtime.approvalScopeId,
  };
  const authorization =
    request.kind === "screenshot"
      ? admin.rpc("authorize_session_browser_screenshot", args)
      : admin.rpc("authorize_session_browser_video", args);
  const { data } = await (signal ? authorization.abortSignal(signal) : authorization);
  signal?.throwIfAborted();
  return data === true ? null : "tool_not_approved";
}

/** Record only bounded outcomes for a frozen browser plan, before sandbox teardown. */
export async function recordBrowserVerification(input: {
  admin: AdminClient;
  workspaceId: string;
  plan: BrowserVerificationPlan;
  identity: BrowserRunIdentity;
  sourceMatches: boolean;
  runtime?: BrowserScreenshotRuntime;
  videoRuntime?: BrowserVideoRuntime;
  approvedToolIds?: readonly string[];
  signal?: AbortSignal;
}) {
  const { admin, identity, plan, runtime, videoRuntime, signal } = input;
  if (!input.sourceMatches) {
    await recordWithoutMedia(
      admin,
      identity,
      plan.flatMap((check) =>
        check.evidence.map(({ kind }) => ({
          ...receiptIdentity(check, kind),
          status: "failed" as const,
          reason: "source_changed" as const,
        })),
      ),
      signal,
    );
    return;
  }

  const requested = new Set(plan.flatMap(({ evidence }) => evidence.map(({ kind }) => kind)));
  const capabilities: Record<CaptureKind, CaptureRequest | undefined> = {
    screenshot: runtime ? { kind: "screenshot", runtime } : undefined,
    video: videoRuntime ? { kind: "video", runtime: videoRuntime } : undefined,
  };
  const unavailable = new Map<CaptureKind, Awaited<ReturnType<typeof captureAvailability>>>();
  for (const kind of requested) {
    unavailable.set(kind, await captureAvailability({ ...input, request: capabilities[kind] }));
  }
  const records: BrowserCaptureReceipt[] = [];
  const transfers: BrowserAssetTransfer[] = [];
  for (const check of plan) {
    for (const { kind } of check.evidence) {
      const request = capabilities[kind];
      const reason = unavailable.get(kind);
      if (!request || reason) {
        records.push({
          ...receiptIdentity(check, kind),
          status: "unavailable",
          reason: reason ?? "runtime_unavailable",
        });
        continue;
      }
      const captured = await captureOneMedia({ ...input, request, check });
      records.push(captured.receipt);
      if (captured.transfer) transfers.push(captured.transfer);
    }
  }
  if (!transfers.length) {
    await recordWithoutMedia(admin, identity, records, signal);
    return;
  }

  const capturedVideo = records.some(
    (record) => record.status === "captured" && record.kind === "video",
  );
  const capturedScreenshot = records.some(
    (record) => record.status === "captured" && record.kind === "screenshot",
  );
  const transferArgs = {
    ...browserIdentityArgs(identity),
    p_records: records,
    p_transfers: transfers,
  };
  const request = capturedVideo
    ? admin.rpc("record_session_browser_media_verification", {
        ...transferArgs,
        ...(capturedScreenshot && runtime
          ? { p_screenshot_approval_scope_id: runtime.approvalScopeId }
          : {}),
        ...(videoRuntime ? { p_video_approval_scope_id: videoRuntime.approvalScopeId } : {}),
      })
    : runtime
      ? admin.rpc("record_session_browser_screenshot_verification", {
          ...transferArgs,
          p_approval_scope_id: runtime.approvalScopeId,
        })
      : null;
  if (!request) return;
  const { error } = await (signal ? request.abortSignal(signal) : request);
  signal?.throwIfAborted();
  if (error) {
    // The server may have committed before the response failed. Leave the
    // reservations to the normal recovery fence without removing any bytes here.
    await recordWithoutMedia(
      admin,
      identity,
      records.map((record) =>
        record.status === "captured"
          ? {
              key: record.key,
              kind: record.kind,
              path: record.path,
              policy: record.policy,
              status: "failed",
              reason: "capture_failed",
            }
          : record,
      ),
      signal,
    );
  }
}
