import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("@/lib/workspaces/resource-operations", () => ({ uploadWorkspaceObject: upload }));

import { browserVerificationPlanSchema } from "./browser-contract";
import { recordBrowserVerification } from "./browser-service";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const browserSessionId = "10000000-0000-4000-8000-000000000003";
const scope = "10000000-0000-4000-8000-000000000004/capture";
const operationId = "10000000-0000-4000-8000-000000000005";
const screenshot = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQVDIGAACuAGcVHqFfAAAAAElFTkSuQmCC",
  "base64",
);
const identity = {
  runId,
  attemptCount: 3,
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
};
const plan = browserVerificationPlanSchema.parse([
  {
    key: "inbox",
    path: "/fixtures/inbox",
    timeoutSeconds: 5,
    interactions: [],
    regionTestId: "inbox-demo",
    excludedTestIds: [],
    evidence: [
      { kind: "screenshot", required: true },
      { kind: "video", required: false },
    ],
  },
]);
const captureScreenshot = vi.fn();
const result = {
  status: "captured",
  identity,
  browserSessionId,
  path: plan[0].path,
  bytes: screenshot,
};

function fixtures(overrides?: {
  current?: boolean;
  scope?: string;
  sourceMatches?: boolean;
  settlementFails?: boolean;
}) {
  const rpc = vi.fn(async (name: string) => ({
    data: name === "authorize_session_browser_screenshot" ? (overrides?.current ?? true) : null,
    error:
      name === "record_session_browser_screenshot_verification" && overrides?.settlementFails
        ? { code: "PT409" }
        : null,
  }));
  const input = {
    admin: { rpc } as never,
    workspaceId,
    plan,
    identity,
    approvedToolIds: [overrides?.scope ?? scope],
    sourceMatches: overrides?.sourceMatches ?? true,
    runtime: { approvalScopeId: scope, captureScreenshot },
  };
  return { rpc, input };
}

beforeEach(() => {
  vi.resetAllMocks();
  captureScreenshot.mockResolvedValue(result);
  upload.mockResolvedValue({ operationId, error: null });
});

describe("exact screenshot retention", () => {
  it("preflights current scope, uploads canonical bytes, then settles the matching reservation", async () => {
    const { rpc, input } = fixtures();
    await recordBrowserVerification(input);
    expect(rpc).toHaveBeenNthCalledWith(1, "authorize_session_browser_screenshot", {
      p_run_id: runId,
      p_attempt_count: 3,
      p_commit_sha: identity.commitSha,
      p_validation_tree_sha: identity.treeSha,
      p_approval_scope_id: scope,
    });
    expect(captureScreenshot).toHaveBeenCalledWith({
      identity,
      check: plan[0],
      signal: undefined,
    });
    const stored = upload.mock.calls[0][1];
    expect(stored).toMatchObject({
      deferTransfer: true,
      bucket: "session-validation-evidence",
      workspaceId,
      contentType: "image/png",
      bytes: screenshot,
    });
    const assetId = stored.path
      .split("/")
      .at(-1)
      .replace(/\.png$/, "");
    expect(stored.path).toBe(`${workspaceId}/${runId}/browser/${assetId}.png`);
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "record_session_browser_screenshot_verification",
      expect.objectContaining({
        p_approval_scope_id: scope,
        p_transfers: [{ assetId, operationId }],
        p_records: expect.arrayContaining([
          expect.objectContaining({ kind: "video", status: "unavailable" }),
          expect.objectContaining({
            kind: "screenshot",
            status: "captured",
            browserSessionId,
            manifest: {
              assetId,
              contentType: "image/png",
              sizeBytes: screenshot.length,
              sha256: createHash("sha256").update(screenshot).digest("hex"),
            },
          }),
        ]),
      }),
    );
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
      captureScreenshot.mock.invocationCallOrder[0],
    );
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1]);
  });

  it.each([
    [{ ...result, path: "/wrong-fixture" }, false],
    [{ ...result, identity: { ...identity, attemptCount: 4 } }, false],
    [{ ...result, identity: { ...identity, treeSha: "c".repeat(40) } }, false],
    [{ ...result, bytes: Buffer.from("untrusted agent output") }, false],
    [result, true],
  ])(
    "records nonpassing evidence for invalid capture, wrong target, or upload failure",
    async (capture, failUpload) => {
      captureScreenshot.mockResolvedValue(capture);
      if (failUpload) upload.mockResolvedValue({ operationId, error: new Error("unavailable") });
      const { rpc, input } = fixtures();
      await recordBrowserVerification(input);
      expect(upload).toHaveBeenCalledTimes(failUpload ? 1 : 0);
      expect(rpc).toHaveBeenNthCalledWith(
        2,
        "record_session_browser_verification",
        expect.objectContaining({
          p_records: expect.arrayContaining([
            expect.objectContaining({
              kind: "screenshot",
              status: "failed",
              reason: "capture_failed",
            }),
          ]),
        }),
      );
    },
  );

  it.each([{ current: false }, { scope: "unrelated" }, { sourceMatches: false }])(
    "keeps the runtime and upload closed when authorization or final source no longer matches",
    async (overrides) => {
      const { rpc, input } = fixtures(overrides);
      await recordBrowserVerification(input);
      expect(captureScreenshot).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenLastCalledWith(
        "record_session_browser_verification",
        expect.objectContaining({
          p_records: expect.arrayContaining([
            expect.objectContaining(
              overrides.sourceMatches === false
                ? { kind: "screenshot", status: "failed", reason: "source_changed" }
                : { kind: "screenshot", status: "unavailable", reason: "tool_not_approved" },
            ),
          ]),
        }),
      );
    },
  );

  it("leaves an unsettled upload to recovery when ownership cannot be confirmed", async () => {
    const { rpc, input } = fixtures({ settlementFails: true });
    await recordBrowserVerification(input);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "authorize_session_browser_screenshot",
      "record_session_browser_screenshot_verification",
      "record_session_browser_verification",
    ]);
    expect(rpc).toHaveBeenLastCalledWith(
      "record_session_browser_verification",
      expect.objectContaining({
        p_records: expect.arrayContaining([
          expect.objectContaining({
            kind: "screenshot",
            status: "failed",
            reason: "capture_failed",
          }),
        ]),
      }),
    );
  });
});
