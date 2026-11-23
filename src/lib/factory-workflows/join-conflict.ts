import { createHash } from "node:crypto";
import { z } from "zod";
import type { IntegrationOutcome } from "./join-git";

export const conflictBucket = "factory-workflow-join-conflicts";
const maxReportBytes = 16 * 1024;
const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const scopeSchema = z.strictObject({
  workspaceId: uuid,
  rootSessionId: uuid,
  joinId: uuid,
  runId: uuid,
});
type Scope = z.infer<typeof scopeSchema>;
const reportSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  edgeId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  incomingSha: sha,
  integratedThroughSha: sha,
  paths: z.array(z.string().min(1).max(512)).max(32),
  pathsTruncated: z.boolean(),
});
type Conflict = Extract<IntegrationOutcome, { kind: "conflict" }>;
type Digest = z.infer<typeof sha256>;

export type PrivateConflictObjects = {
  upload: (path: string, bytes: Buffer, signal: AbortSignal) => Promise<void>;
  download: (path: string, signal: AbortSignal) => Promise<Blob | null>;
};

function pathFor(scope: Scope, digest: Digest) {
  const pin = scopeSchema.parse(scope);
  return [
    pin.workspaceId,
    pin.rootSessionId,
    pin.joinId,
    pin.runId,
    sha256.parse(digest) + ".json",
  ].join("/");
}

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readJoinConflict(
  objects: Pick<PrivateConflictObjects, "download">,
  scope: Scope,
  digest: Digest,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const stored = await objects.download(pathFor(scope, digest), signal);
  signal.throwIfAborted();
  if (!stored || stored.size > maxReportBytes)
    throw new Error("The private join conflict report is unavailable.");
  const bytes = Buffer.from(await stored.arrayBuffer());
  if (hash(bytes) !== digest) throw new Error("Private join conflict integrity check failed.");
  const report = reportSchema.parse(JSON.parse(bytes.toString("utf8")));
  for (const key of ["workspaceId", "rootSessionId", "joinId", "runId"] as const) {
    if (report.scope[key] !== scope[key]) throw new Error("Private join conflict scope changed.");
  }
  return report;
}

export async function retainJoinConflict(
  objects: PrivateConflictObjects,
  scope: Scope,
  conflict: Conflict,
  signal: AbortSignal,
) {
  const report = reportSchema.parse({
    version: 1,
    scope,
    edgeId: conflict.edgeId,
    incomingSha: conflict.incomingSha,
    integratedThroughSha: conflict.integratedThroughSha,
    paths: conflict.paths,
    pathsTruncated: conflict.pathsTruncated,
  });
  const bytes = Buffer.from(JSON.stringify(report));
  if (bytes.length > maxReportBytes)
    throw new Error("The join conflict report exceeded its limit.");
  const reportSha256 = hash(bytes);
  const path = pathFor(scope, reportSha256);
  signal.throwIfAborted();
  try {
    await objects.upload(path, bytes, signal);
  } catch {
    signal.throwIfAborted();
    // The write may have committed before the worker disconnected.
  }
  await readJoinConflict(objects, scope, reportSha256, signal);
  return {
    reportSha256,
    paths: report.paths,
    pathsTruncated: report.pathsTruncated,
  };
}
