import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  readVerifiedPrivateObject,
  type VerifiedPrivateObject,
} from "@/lib/storage/private-object";
import type { Database } from "@/lib/supabase/database.types";

export const RUN_EXPORT_BUCKET = "workspace-run-exports";
export const MAX_RUN_EXPORT_PAGE_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const objectScope = z.object({ workspaceId: z.string().uuid(), exportId: z.string().uuid() });
const header = z.object({ sha256: digestSchema });
const pageSchema = header.extend({
  kind: z.literal("page"),
  firstOrdinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentType: z.literal("application/json"),
  sizeBytes: z.number().int().positive().max(MAX_RUN_EXPORT_PAGE_BYTES),
});
const assetSchema = header.extend({
  kind: z.literal("asset"),
  assetId: z.string().uuid(),
  contentType: z.enum(["application/json", "text/plain"]),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024),
});
export const runExportObjectSchema = z.discriminatedUnion("kind", [pageSchema, assetSchema]);
export type RunExportObject = z.infer<typeof runExportObjectSchema>;

type ObjectScope = z.infer<typeof objectScope>;

function objectPath(scope: ObjectScope, object: RunExportObject) {
  const prefix = `${scope.workspaceId}/${scope.exportId}`;
  if (object.kind === "page") return `${prefix}/pages/${object.firstOrdinal}-${object.sha256}.json`;
  return `${prefix}/assets/${object.assetId}-${object.sha256}`;
}

function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Caller must check current export access before and after reading private bytes. */
export async function readRunExportObject(
  input: ObjectScope & {
    supabase: SupabaseClient<Database>;
    object: RunExportObject;
    signal?: AbortSignal;
  },
): Promise<VerifiedPrivateObject> {
  const scope = objectScope.safeParse(input);
  const object = runExportObjectSchema.safeParse(input.object);
  if (!scope.success || !object.success) return { status: "integrity_mismatch" };
  const deadline = AbortSignal.timeout(READ_TIMEOUT_MS);
  return readVerifiedPrivateObject({
    supabase: input.supabase,
    bucket: RUN_EXPORT_BUCKET,
    path: objectPath(scope.data, object.data),
    sizeBytes: object.data.sizeBytes,
    sha256: object.data.sha256,
    signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
  });
}

/** Immutable, content-addressed writes recover a duplicate or a lost upload response. */
export async function writeRunExportObject(
  input: ObjectScope & {
    supabase: SupabaseClient<Database>;
    object: RunExportObject;
    bytes: Uint8Array;
    signal: AbortSignal;
  },
) {
  const scope = objectScope.parse(input);
  const object = runExportObjectSchema.parse(input.object);
  const { supabase, bytes, signal } = input;
  signal.throwIfAborted();
  if (
    bytes.byteLength !== object.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== object.sha256
  ) {
    throw new Error("Export object does not match its digest.");
  }

  // Storage's final metadata write is fenced even when its SDK upload outlives this wait.
  const result = await beforeDeadline(
    supabase.storage.from(RUN_EXPORT_BUCKET).upload(objectPath(scope, object), bytes, {
      cacheControl: "0",
      contentType: object.contentType,
      upsert: false,
    }),
    signal,
  );
  signal.throwIfAborted();
  if (result.data) return;

  const existing = await readRunExportObject({ ...scope, supabase, object, signal });
  if (existing.status !== "available") throw new Error("Export object storage will retry.");
}
