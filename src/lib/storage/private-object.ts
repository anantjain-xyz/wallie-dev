import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type ObjectFailure = "inaccessible" | "integrity_mismatch" | "missing" | "unavailable";

export type VerifiedPrivateObject =
  | { status: "available"; bytes: Uint8Array<ArrayBuffer> }
  | { status: ObjectFailure };

function storageFailure(error: { status?: number; statusCode?: string }): ObjectFailure {
  if (
    error.status === 401 ||
    error.status === 403 ||
    error.statusCode === "AccessDenied" ||
    error.statusCode === "InvalidJWT"
  ) {
    return "inaccessible";
  }
  if (
    error.statusCode === "NoSuchKey" ||
    error.statusCode === "not_found" ||
    error.statusCode === "404" ||
    (error.status === 404 && !error.statusCode)
  ) {
    return "missing";
  }
  return "unavailable";
}

async function readExactBytes(stream: ReadableStream<unknown>, size: number, signal: AbortSignal) {
  const bytes = new Uint8Array(size);
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  let offset = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return offset === size ? bytes : null;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > size - offset) {
        // Cancel instead of reading the rest of an oversized response.
        cancel();
        return null;
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Read verified bytes for an already-authorized, scoped private object. */
export async function readVerifiedPrivateObject(input: {
  supabase: SupabaseClient<Database>;
  bucket: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  signal: AbortSignal;
}): Promise<VerifiedPrivateObject> {
  const { supabase, bucket, path, sizeBytes, sha256, signal } = input;
  try {
    signal.throwIfAborted();
    const { data, error } = await supabase.storage
      .from(bucket)
      .download(path, {}, { signal, cache: "no-store" })
      .asStream();
    if (error) return { status: storageFailure(error) };
    if (!data) return { status: "unavailable" };
    const bytes = await readExactBytes(data, sizeBytes, signal);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== sha256) {
      return { status: "integrity_mismatch" };
    }
    return { status: "available", bytes };
  } catch {
    return { status: "unavailable" };
  }
}
