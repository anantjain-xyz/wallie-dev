import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { readRunExportObject, writeRunExportObject, type RunExportObject } from "./storage";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const exportId = "20000000-0000-4000-8000-000000000002";
const contents = '{"test":true}';
const bytes = new TextEncoder().encode(contents);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const object = {
  kind: "page",
  firstOrdinal: 21,
  contentType: "application/json",
  sizeBytes: bytes.byteLength,
  sha256,
} satisfies RunExportObject;
const url = `https://supabase.example/storage/v1/object/workspace-run-exports/${workspaceId}/${exportId}/pages/21-${sha256}.json`;

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const supabase = createClient<Database>("https://supabase.example", "test-key", {
    global: { fetch },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { fetch, input: { supabase, workspaceId, exportId, object } };
}

describe("private run export objects", () => {
  it("only reads the exact digest-derived bucket path and caps returned bytes", async () => {
    const { fetch, input } = setup();
    fetch.mockResolvedValueOnce(new Response(contents));
    expect(await readRunExportObject(input)).toEqual({ status: "available", bytes });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({ cache: "no-store" }),
    );

    fetch.mockResolvedValueOnce(new Response(contents + "x"));
    expect(await readRunExportObject(input)).toEqual({ status: "integrity_mismatch" });
    await expect(readRunExportObject({ ...input, exportId: "../../foreign" })).resolves.toEqual({
      status: "integrity_mismatch",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reuses a completed write after the worker loses its acknowledgement", async () => {
    const { fetch, input } = setup();
    fetch
      .mockResolvedValueOnce(Response.json({ message: "already exists" }, { status: 409 }))
      .mockResolvedValueOnce(new Response(contents));
    await writeRunExportObject({ ...input, bytes, signal: new AbortController().signal });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      url,
      expect.objectContaining({ method: "POST", body: bytes }),
    );
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("x-upsert")).toBe("false");
    expect(fetch).toHaveBeenNthCalledWith(2, url, expect.objectContaining({ method: "GET" }));
  });

  it("fails closed when a duplicate path contains different bytes", async () => {
    const { fetch, input } = setup();
    fetch
      .mockResolvedValueOnce(Response.json({ message: "already exists" }, { status: 409 }))
      .mockResolvedValueOnce(new Response("x".repeat(bytes.byteLength)));
    await expect(
      writeRunExportObject({ ...input, bytes, signal: new AbortController().signal }),
    ).rejects.toThrow("Export object storage will retry.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
