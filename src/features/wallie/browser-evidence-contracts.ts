import { z } from "zod";

import { browserCaptureReceiptSchema } from "@/lib/validation-evidence/browser-contract";

export const SCREENSHOT_EVIDENCE_PARAM = "browserScreenshotEvidence";
export const RECORDING_EVIDENCE_PARAM = "browserRecordingEvidence";

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const selectionSchema = z.object({ runId: uuid.optional(), artifactId: uuid.optional() });
export type BrowserEvidenceSelection = z.infer<typeof selectionSchema>;

export function browserEvidenceSelection(url: string) {
  const params = new URL(url).searchParams;
  return selectionSchema.parse({
    runId: params.get("runId") ?? undefined,
    artifactId: params.get("artifactId") ?? undefined,
  });
}

function selectionQuery(selection: BrowserEvidenceSelection) {
  const query = new URLSearchParams();
  if (selection.runId) query.set("runId", selection.runId);
  if (selection.artifactId) query.set("artifactId", selection.artifactId);
  return query.size ? `?${query}` : "";
}

export function browserEvidencePath(sessionId: string, selection: BrowserEvidenceSelection) {
  return `/api/sessions/${sessionId}/validation-evidence${selectionQuery(selection)}`;
}

export function browserScreenshotDownloadPath(
  sessionId: string,
  assetId: string,
  selection: BrowserEvidenceSelection,
) {
  return `/api/sessions/${sessionId}/validation-evidence/browser-assets/${assetId}${selectionQuery(selection)}`;
}

export function browserRecordingDownloadPath(
  sessionId: string,
  assetId: string,
  selection: BrowserEvidenceSelection,
) {
  return `/api/sessions/${sessionId}/validation-evidence/browser-videos/${assetId}${selectionQuery(selection)}`;
}

const recordingOffset = z.number().int().min(0).lt(30_000);
const recordingHashPattern = /^#browser-recording-([0-9a-f-]{36})-(0|[1-9][0-9]{0,4})$/i;

export function browserRecordingAnchor(assetId: string, offsetMs: number) {
  return `browser-recording-${assetId}-${offsetMs}`;
}

export function parseBrowserRecordingHash(hash: string) {
  const match = recordingHashPattern.exec(hash);
  if (!match || !uuid.safeParse(match[1]).success) return null;
  const offset = recordingOffset.safeParse(Number(match[2]));
  return offset.success ? { assetId: match[1]!.toLowerCase(), offsetMs: offset.data } : null;
}

const recordingFindingSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("entry"), offsetMs: z.literal(0) }),
  z.object({
    action: z.enum(["click", "expectVisible"]),
    offsetMs: recordingOffset,
    testId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
  }),
]);
export type BrowserRecordingFinding = z.infer<typeof recordingFindingSchema>;
export type BrowserRecordingFindings = { assetId: string; steps: BrowserRecordingFinding[] };

export function browserScreenshotAnchor(assetId: string) {
  return `browser-screenshot-${assetId}`;
}

export function isBrowserScreenshotHash(hash: string) {
  return (
    hash.startsWith("#browser-screenshot-") &&
    uuid.safeParse(hash.slice("#browser-screenshot-".length)).success
  );
}

const browserEvidenceResponseRecordSchema = z.preprocess((record) => {
  if (typeof record !== "object" || record === null || !("downloadUrl" in record)) return record;
  // The API includes a link for download clients. The inspector builds its own exact URL.
  const fields: Record<string, unknown> = { ...record };
  delete fields.downloadUrl;
  return fields;
}, browserCaptureReceiptSchema);

export const exactBrowserEvidenceSchema = z.object({
  browserEvidence: z
    .array(
      z.object({
        runId: uuid,
        attemptCount: z.number().int().positive(),
        commitSha: sha,
        treeSha: sha,
        createdAt: z.string().datetime({ offset: true }),
        records: z.array(browserEvidenceResponseRecordSchema).max(10),
        videoFindings: z
          .array(z.object({ assetId: uuid, steps: z.array(recordingFindingSchema).min(1).max(13) }))
          .max(10)
          .optional(),
      }),
    )
    .max(1),
});

export type BrowserEvidenceReceipt = z.infer<
  typeof exactBrowserEvidenceSchema
>["browserEvidence"][number];
export type BrowserScreenshotRecord =
  | Extract<z.infer<typeof browserCaptureReceiptSchema>, { kind: "screenshot"; status: "captured" }>
  | (Extract<z.infer<typeof browserCaptureReceiptSchema>, { status: "failed" | "unavailable" }> & {
      kind: "screenshot";
    });

export type BrowserVideoRecord =
  | Extract<z.infer<typeof browserCaptureReceiptSchema>, { kind: "video"; status: "captured" }>
  | (Extract<z.infer<typeof browserCaptureReceiptSchema>, { status: "failed" | "unavailable" }> & {
      kind: "video";
    });
