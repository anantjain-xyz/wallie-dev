import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";
import { browserScreenshotPath } from "./browser-assets";
import {
  BROWSER_CAPTURE_POLICY,
  browserCaptureReceiptSchema,
  unavailableBrowserReceipts,
  type BrowserCaptureReceipt,
  type BrowserRunIdentity,
  type BrowserScreenshotRuntime,
  type BrowserVerificationPlan,
} from "./browser-contract";
import { VALIDATION_EVIDENCE_BUCKET } from "./contracts";
import { sanitizeBrowserScreenshot } from "./screenshot-png";

type AdminClient = SupabaseClient<Database>;
type CapturedScreenshot = Extract<
  BrowserCaptureReceipt,
  { status: "captured"; kind: "screenshot" }
>;

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

type ScreenshotTransfer = { assetId: string; operationId: string };

async function captureOneScreenshot(input: {
  admin: AdminClient;
  workspaceId: string;
  runtime: BrowserScreenshotRuntime;
  identity: BrowserRunIdentity;
  check: BrowserVerificationPlan[number];
  signal?: AbortSignal;
}): Promise<{ receipt: BrowserCaptureReceipt; transfer?: ScreenshotTransfer }> {
  const { admin, workspaceId, runtime, identity, check, signal } = input;
  const base = {
    key: check.key,
    kind: "screenshot",
    path: check.path,
    policy: BROWSER_CAPTURE_POLICY,
  } as const;
  const failed = { ...base, status: "failed", reason: "capture_failed" } as const;
  try {
    const result = await runtime.captureScreenshot({ identity, check, signal });
    signal?.throwIfAborted();
    if (result.status !== "captured") {
      return { receipt: browserCaptureReceiptSchema.parse({ ...base, ...result }) };
    }
    if (result.path !== check.path || !sameIdentity(result.identity, identity)) {
      return { receipt: failed };
    }
    const bytes = sanitizeBrowserScreenshot(result.bytes);
    if (!bytes) return { receipt: failed };
    const assetId = randomUUID();
    const receipt: CapturedScreenshot = {
      ...base,
      status: "captured",
      browserSessionId: result.browserSessionId,
      manifest: {
        assetId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: "image/png",
        sizeBytes: bytes.length,
      },
    };
    if (!browserCaptureReceiptSchema.safeParse(receipt).success) return { receipt: failed };
    const { operationId, error } = await uploadWorkspaceObject(admin, {
      bucket: VALIDATION_EVIDENCE_BUCKET,
      workspaceId,
      path: browserScreenshotPath(workspaceId, identity.runId, assetId),
      bytes,
      contentType: "image/png",
      deferTransfer: true,
      signal,
    });
    if (error) return { receipt: failed };
    return { receipt, transfer: { assetId, operationId } };
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

/** Record only bounded outcomes for a frozen browser plan, before sandbox teardown. */
export async function recordBrowserVerification(input: {
  admin: AdminClient;
  workspaceId: string;
  plan: BrowserVerificationPlan;
  identity: BrowserRunIdentity;
  sourceMatches: boolean;
  runtime?: BrowserScreenshotRuntime;
  approvedToolIds?: readonly string[];
  signal?: AbortSignal;
}) {
  const { admin, identity, plan, runtime, signal } = input;
  const unavailable = unavailableBrowserReceipts(plan, {
    status: "unavailable",
    reason:
      input.approvedToolIds?.length === 0 ||
      (runtime && !input.approvedToolIds?.includes(runtime.approvalScopeId))
        ? "tool_not_approved"
        : "runtime_unavailable",
  });
  if (!input.sourceMatches) {
    await recordWithoutMedia(
      admin,
      identity,
      unavailable.map((record) => ({
        key: record.key,
        kind: record.kind,
        path: record.path,
        policy: BROWSER_CAPTURE_POLICY,
        status: "failed",
        reason: "source_changed",
      })),
      signal,
    );
    return;
  }
  if (
    !runtime ||
    !plan.some((check) => check.evidence.some(({ kind }) => kind === "screenshot")) ||
    !input.approvedToolIds?.includes(runtime.approvalScopeId)
  ) {
    await recordWithoutMedia(admin, identity, unavailable, signal);
    return;
  }

  const authorize = admin.rpc("authorize_session_browser_screenshot", {
    ...browserIdentityArgs(identity),
    p_approval_scope_id: runtime.approvalScopeId,
  });
  const { data: allowed } = await (signal ? authorize.abortSignal(signal) : authorize);
  signal?.throwIfAborted();
  if (allowed !== true) {
    await recordWithoutMedia(
      admin,
      identity,
      unavailableBrowserReceipts(plan, { status: "unavailable", reason: "tool_not_approved" }),
      signal,
    );
    return;
  }

  const records: BrowserCaptureReceipt[] = unavailable.filter((record) => record.kind === "video");
  const transfers: ScreenshotTransfer[] = [];
  for (const check of plan) {
    if (!check.evidence.some(({ kind }) => kind === "screenshot")) continue;
    const captured = await captureOneScreenshot({ ...input, runtime, check });
    records.push(captured.receipt);
    if (captured.transfer) transfers.push(captured.transfer);
  }
  if (!transfers.length) {
    await recordWithoutMedia(admin, identity, records, signal);
    return;
  }

  const request = admin.rpc("record_session_browser_screenshot_verification", {
    ...browserIdentityArgs(identity),
    p_approval_scope_id: runtime.approvalScopeId,
    p_records: records,
    p_transfers: transfers,
  });
  const { error } = await (signal ? request.abortSignal(signal) : request);
  signal?.throwIfAborted();
  if (error) {
    // The server may have committed before the response failed. Leave the
    // reservations to the normal recovery fence and never remove bytes here.
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
