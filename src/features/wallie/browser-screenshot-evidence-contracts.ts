import { z } from "zod";

import { browserCaptureReceiptSchema } from "@/lib/validation-evidence/browser-contract";

export const SCREENSHOT_EVIDENCE_PARAM = "browserScreenshotEvidence";

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

export function browserScreenshotEvidencePath(
  sessionId: string,
  selection: BrowserEvidenceSelection,
) {
  return `/api/sessions/${sessionId}/validation-evidence${selectionQuery(selection)}`;
}

export function browserScreenshotDownloadPath(
  sessionId: string,
  assetId: string,
  selection: BrowserEvidenceSelection,
) {
  return `/api/sessions/${sessionId}/validation-evidence/browser-assets/${assetId}${selectionQuery(selection)}`;
}

export function browserScreenshotAnchor(assetId: string) {
  return `browser-screenshot-${assetId}`;
}

export function isBrowserScreenshotHash(hash: string) {
  return (
    hash.startsWith("#browser-screenshot-") &&
    uuid.safeParse(hash.slice("#browser-screenshot-".length)).success
  );
}

const browserScreenshotResponseRecordSchema = z.preprocess((record) => {
  if (typeof record !== "object" || record === null || !("downloadUrl" in record)) return record;
  // The API includes a link for download clients. The inspector builds its own exact URL.
  const fields: Record<string, unknown> = { ...record };
  delete fields.downloadUrl;
  return fields;
}, browserCaptureReceiptSchema);

export const exactBrowserScreenshotEvidenceSchema = z.object({
  browserEvidence: z
    .array(
      z.object({
        runId: uuid,
        attemptCount: z.number().int().positive(),
        commitSha: sha,
        treeSha: sha,
        createdAt: z.string().datetime({ offset: true }),
        records: z.array(browserScreenshotResponseRecordSchema).max(10),
      }),
    )
    .max(1),
});

export type BrowserScreenshotEvidence = z.infer<
  typeof exactBrowserScreenshotEvidenceSchema
>["browserEvidence"][number];
export type BrowserScreenshotRecord =
  | Extract<z.infer<typeof browserCaptureReceiptSchema>, { kind: "screenshot"; status: "captured" }>
  | (Extract<z.infer<typeof browserCaptureReceiptSchema>, { status: "failed" | "unavailable" }> & {
      kind: "screenshot";
    });
