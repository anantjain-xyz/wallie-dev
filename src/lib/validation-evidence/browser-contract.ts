import { z } from "zod";

const browserCheckKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const testId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const targetPath = z
  .string()
  .max(256)
  .regex(/^\/(?:[A-Za-z0-9_-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._~-]*)*\/?)?$/);

export const browserEvidenceKindSchema = z.enum(["screenshot", "video"]);
type BrowserEvidenceKind = z.infer<typeof browserEvidenceKindSchema>;

const interaction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("click"), testId }),
  z.strictObject({ action: z.literal("expectVisible"), testId }),
]);

export const browserVerificationPlanSchema = z
  .array(
    z.strictObject({
      key: browserCheckKey,
      path: targetPath,
      timeoutSeconds: z.number().int().min(1).max(30),
      interactions: z.array(interaction).max(12),
      regionTestId: testId,
      excludedTestIds: z.array(testId).max(12),
      evidence: z
        .array(z.strictObject({ kind: browserEvidenceKindSchema, required: z.boolean() }))
        .min(1)
        .max(2),
    }),
  )
  .min(1)
  .max(5)
  .superRefine((checks, context) => {
    if (new Set(checks.map((check) => check.key)).size !== checks.length) {
      context.addIssue({ code: "custom", message: "Browser check identities must be unique." });
    }
    for (const [index, check] of checks.entries()) {
      if (
        new Set(check.evidence.map(({ kind }) => kind)).size !== check.evidence.length ||
        new Set(check.excludedTestIds).size !== check.excludedTestIds.length ||
        check.excludedTestIds.includes(check.regionTestId)
      ) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Browser checks must declare distinct evidence kinds and capture regions.",
        });
      }
    }
  });

export type BrowserVerificationPlan = z.infer<typeof browserVerificationPlanSchema>;

/**
 * This policy is controlled by Wallie. A plan may restrict the capture region or
 * exclude additional elements. It cannot relax any of these requirements.
 */
export const BROWSER_CAPTURE_POLICY = "isolated-fixture-v1";

export const browserRunIdentitySchema = z.strictObject({
  runId: z.string().uuid(),
  attemptCount: z.number().int().positive(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export type BrowserRunIdentity = z.infer<typeof browserRunIdentitySchema>;

const captureIdentity = {
  key: browserCheckKey,
  kind: browserEvidenceKindSchema,
  path: targetPath,
  policy: z.literal(BROWSER_CAPTURE_POLICY),
};

const assetIdentity = {
  assetId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};

const capturedIdentity = {
  ...captureIdentity,
  status: z.literal("captured"),
  browserSessionId: z.string().uuid(),
};

export const browserCaptureReceiptSchema = z.union([
  z.strictObject({
    ...captureIdentity,
    status: z.literal("unavailable"),
    reason: z.enum(["runtime_unavailable", "tool_not_approved", "isolated_target_unavailable"]),
  }),
  z.strictObject({
    ...captureIdentity,
    status: z.literal("failed"),
    reason: z.enum(["capture_failed", "policy_excluded", "source_changed"]),
  }),
  z.strictObject({
    ...capturedIdentity,
    kind: z.literal("screenshot"),
    manifest: z.strictObject({
      ...assetIdentity,
      contentType: z.literal("image/png"),
      sizeBytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024),
    }),
  }),
  z.strictObject({
    ...capturedIdentity,
    kind: z.literal("video"),
    manifest: z.strictObject({
      ...assetIdentity,
      contentType: z.literal("video/webm"),
      sizeBytes: z
        .number()
        .int()
        .positive()
        .max(8 * 1024 * 1024),
      durationMs: z.number().int().positive().max(30_000),
    }),
  }),
]);
export type BrowserCaptureReceipt = z.infer<typeof browserCaptureReceiptSchema>;

export type BrowserVerificationEvidence = {
  expectedIdentity: BrowserRunIdentity;
  recordedIdentity: BrowserRunIdentity;
  plan: BrowserVerificationPlan;
  receipts: BrowserCaptureReceipt[];
  /** Supplied by a private asset integrity check after authorizing the read. */
  accessibleAssetDigests: ReadonlyMap<string, string>;
};

const browserRequirement = /^browser:(screenshot|video):([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;

export function isBrowserEvidenceRequirement(requirement: string): boolean {
  return browserRequirement.test(requirement);
}

type BrowserEvidenceStatus = "missing" | "stale" | "failed" | "unavailable" | "passed";

/** Returns null for ordinary command evidence keys. */
export function evaluateBrowserRequirement(
  requirement: string,
  evidence: BrowserVerificationEvidence | null | undefined,
): BrowserEvidenceStatus | null {
  const match = browserRequirement.exec(requirement);
  if (!match) return null;
  if (!evidence) return "missing";
  const { expectedIdentity, recordedIdentity } = evidence;
  if (
    expectedIdentity.runId !== recordedIdentity.runId ||
    expectedIdentity.attemptCount !== recordedIdentity.attemptCount ||
    expectedIdentity.commitSha !== recordedIdentity.commitSha ||
    expectedIdentity.treeSha !== recordedIdentity.treeSha
  ) {
    return "stale";
  }
  const [, kind, key] = match;
  const check = evidence.plan.find((candidate) => candidate.key === key);
  if (!check?.evidence.some((item) => item.kind === kind)) return "missing";
  const matches = evidence.receipts.filter(
    (receipt) => receipt.key === key && receipt.kind === kind,
  );
  const receipt = matches[0];
  if (matches.length !== 1 || !receipt) return "missing";
  if (receipt.path !== check.path || receipt.policy !== BROWSER_CAPTURE_POLICY) return "stale";
  if (receipt.status === "failed") return receipt.reason === "source_changed" ? "stale" : "failed";
  if (receipt.status === "unavailable") return "unavailable";
  if (receipt.kind === "video" && receipt.manifest.durationMs > check.timeoutSeconds * 1000) {
    return "failed";
  }
  return evidence.accessibleAssetDigests.get(receipt.manifest.assetId) === receipt.manifest.sha256
    ? "passed"
    : "unavailable";
}

type BrowserRuntimeReadiness =
  | {
      status: "unavailable";
      reason: "runtime_unavailable" | "tool_not_approved" | "isolated_target_unavailable";
    }
  | { status: "ready"; supportedEvidence: ReadonlySet<BrowserEvidenceKind> };

/** An agent-installed browser or ambient Playwright smoke is not an isolated capture runtime. */
export function unavailableBrowserReceipts(
  plan: BrowserVerificationPlan,
  runtime: BrowserRuntimeReadiness,
): BrowserCaptureReceipt[] {
  return plan.flatMap((check) =>
    check.evidence.flatMap(({ kind }) =>
      runtime.status === "ready" && runtime.supportedEvidence.has(kind)
        ? []
        : [
            {
              key: check.key,
              kind,
              path: check.path,
              policy: BROWSER_CAPTURE_POLICY,
              status: "unavailable",
              reason: runtime.status === "unavailable" ? runtime.reason : "runtime_unavailable",
            },
          ],
    ),
  );
}
