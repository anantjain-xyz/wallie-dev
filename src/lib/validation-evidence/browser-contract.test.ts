import { describe, expect, it } from "vitest";

import {
  BROWSER_CAPTURE_POLICY,
  browserCaptureReceiptSchema,
  browserVerificationPlanSchema,
  evaluateBrowserRequirement,
  unavailableBrowserReceipts,
  type BrowserRunIdentity,
  type BrowserVerificationEvidence,
} from "./browser-contract";
import { validationPlanSchema, type ValidationEvidenceRecord } from "./contracts";
import { evaluateValidationEvidence } from "./evaluate";

const browserCheck = {
  key: "inbox",
  path: "/fixtures/inbox",
  timeoutSeconds: 15,
  interactions: [{ action: "click", testId: "inbox-filter" }],
  regionTestId: "inbox-demo",
  excludedTestIds: ["account-menu"],
  evidence: [
    { kind: "screenshot", required: true },
    { kind: "video", required: false },
  ],
};
const visualKey = "browser:screenshot:inbox";
const plan = browserVerificationPlanSchema.parse([browserCheck]);
const identity: BrowserRunIdentity = {
  runId: "11111111-1111-4111-8111-111111111111",
  attemptCount: 1,
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
};
const captured = browserCaptureReceiptSchema.parse({
  key: "inbox",
  kind: "screenshot",
  path: "/fixtures/inbox",
  policy: BROWSER_CAPTURE_POLICY,
  status: "captured",
  browserSessionId: "22222222-2222-4222-8222-222222222222",
  manifest: {
    assetId: "33333333-3333-4333-8333-333333333333",
    sha256: "c".repeat(64),
    contentType: "image/png",
    sizeBytes: 512,
  },
});
const exactEvidence: BrowserVerificationEvidence = {
  expectedIdentity: identity,
  recordedIdentity: identity,
  plan,
  receipts: [captured],
  accessibleAssetDigests: new Map([["33333333-3333-4333-8333-333333333333", "c".repeat(64)]]),
};

describe("browser verification plan", () => {
  it("accepts a bounded version-2 plan and preserves version-1 command shape", () => {
    expect(validationPlanSchema.parse({ version: 1, commands: [] })).toEqual({
      version: 1,
      commands: [],
    });
    expect(validationPlanSchema.parse({ version: 2, commands: [], browser: plan })).toEqual({
      version: 2,
      commands: [],
      browser: plan,
    });
  });

  it.each([
    { path: "https://example.test/" },
    { path: "//example.test/" },
    { path: "/../private" },
    { path: "/%2e%2e/private" },
    { path: "/private?token=fake" },
    { path: "/one\\two" },
    { timeoutSeconds: 31 },
    { interactions: [{ action: "executeJavaScript", script: "false" }] },
    { interactions: [{ action: "click", testId: "item", text: "fixture" }] },
    { evidence: [{ kind: "screenshot", required: true, passed: true }] },
    {
      evidence: [
        { kind: "screenshot", required: true },
        { kind: "screenshot", required: false },
      ],
    },
    { excludedTestIds: ["inbox-demo"] },
    { status: "passed" },
    { storageState: "agent-profile.json" },
  ])("rejects unbounded or attestation-bearing intent %o", (override) => {
    expect(
      browserVerificationPlanSchema.safeParse([{ ...browserCheck, ...override }]).success,
    ).toBe(false);
  });

  it("rejects request-key reuse and prevents command keys impersonating visual requirements", () => {
    expect(browserVerificationPlanSchema.safeParse([browserCheck, browserCheck]).success).toBe(
      false,
    );
    expect(
      validationPlanSchema.safeParse({
        version: 1,
        commands: [{ key: visualKey, command: "true", timeoutSeconds: 10, reports: [] }],
      }).success,
    ).toBe(false);
  });
});

describe("trusted browser outcomes", () => {
  it.each([
    { runId: "44444444-4444-4444-8444-444444444444" },
    { attemptCount: 2 },
    { commitSha: "d".repeat(40) },
    { treeSha: "e".repeat(40) },
  ])("rejects a captured outcome for a different identity %o", (override) => {
    expect(
      evaluateBrowserRequirement(visualKey, {
        ...exactEvidence,
        recordedIdentity: { ...identity, ...override },
      }),
    ).toBe("stale");
  });

  it("requires the planned target, evidence kind, and verified private bytes", () => {
    expect(evaluateBrowserRequirement(visualKey, exactEvidence)).toBe("passed");
    expect(evaluateBrowserRequirement("browser:video:inbox", exactEvidence)).toBe("missing");
    expect(
      evaluateBrowserRequirement(visualKey, {
        ...exactEvidence,
        receipts: [{ ...captured, path: "/fixtures/other" }],
      }),
    ).toBe("stale");
    expect(
      evaluateBrowserRequirement(visualKey, {
        ...exactEvidence,
        accessibleAssetDigests: new Map([["33333333-3333-4333-8333-333333333333", "e".repeat(64)]]),
      }),
    ).toBe("unavailable");
    expect(
      browserCaptureReceiptSchema.safeParse({
        key: "inbox",
        kind: "screenshot",
        path: "/fixtures/inbox",
        status: "captured",
        claim: "all checks passed",
        file: "/tmp/result.png",
      }).success,
    ).toBe(false);
  });

  it("rejects the wrong media format and video exceeding the requested duration", () => {
    expect(browserCaptureReceiptSchema.safeParse({ ...captured, kind: "video" }).success).toBe(
      false,
    );
    const video = browserCaptureReceiptSchema.parse({
      ...captured,
      kind: "video",
      manifest: {
        assetId: "33333333-3333-4333-8333-333333333333",
        sha256: "c".repeat(64),
        contentType: "video/webm",
        sizeBytes: 1024,
        durationMs: 16_000,
      },
    });
    expect(
      evaluateBrowserRequirement("browser:video:inbox", {
        ...exactEvidence,
        receipts: [video],
      }),
    ).toBe("failed");
  });

  it("scopes runtime and explicit capture failures to the corresponding visual requirement", () => {
    const unavailable = unavailableBrowserReceipts(plan, {
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    expect(unavailable).toHaveLength(2);
    expect(
      unavailableBrowserReceipts(plan, {
        status: "ready",
        supportedEvidence: new Set(["screenshot"]),
      }),
    ).toEqual([expect.objectContaining({ kind: "video", status: "unavailable" })]);
    const text: ValidationEvidenceRecord = {
      key: "unit",
      command: "pnpm test",
      provenance: "harness",
      status: "passed",
      exitCode: 0,
      startedAt: "2026-11-19T08:00:00Z",
      completedAt: "2026-11-19T08:00:01Z",
      commitSha: identity.commitSha,
      treeSha: identity.treeSha,
      finalCommitSha: identity.commitSha,
      finalTreeSha: identity.treeSha,
      reportKeys: [],
      missingRequiredReports: [],
    };
    const failed = browserCaptureReceiptSchema.parse({
      key: "inbox",
      kind: "video",
      path: "/fixtures/inbox",
      policy: BROWSER_CAPTURE_POLICY,
      status: "failed",
      reason: "policy_excluded",
    });
    expect(
      evaluateValidationEvidence({
        requiredKeys: ["unit", visualKey, "browser:video:inbox"],
        commitSha: identity.commitSha,
        treeSha: identity.treeSha,
        records: [text, { ...text, key: visualKey }],
        accessibleAssetKeys: new Set(),
        browserEvidence: { ...exactEvidence, receipts: [unavailable[0], failed] },
      }),
    ).toEqual([
      { key: "unit", status: "passed" },
      { key: visualKey, status: "unavailable" },
      { key: "browser:video:inbox", status: "failed" },
    ]);
  });
});
