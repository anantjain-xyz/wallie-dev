import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { readPrivateValidationAsset } from "@/lib/validation-evidence/private-asset";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const contents = "retained report\n";
const asset = {
  id: assetId,
  run_id: runId,
  storage_path: `${workspaceId}/${runId}/${assetId}`,
  sha256: createHash("sha256").update(contents).digest("hex"),
  content_type: "text/plain",
  size_bytes: Buffer.byteLength(contents),
};

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const supabase = createClient<Database>("https://supabase.example", "test-key", {
    global: { fetch },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { fetch, supabase };
}

describe("private validation asset integrity", () => {
  it("reads the exact manifest path using the RLS client and returns verified bytes", async () => {
    const { fetch, supabase } = setup();
    fetch
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(contents))
      .mockResolvedValueOnce(Response.json([]));

    const result = await readPrivateValidationAsset({ supabase, workspaceId, asset });
    expect(result).toEqual({ status: "available", bytes: new TextEncoder().encode(contents) });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `https://supabase.example/rest/v1/session_validation_asset_withholdings?select=state&asset_id=eq.${assetId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `https://supabase.example/storage/v1/object/session-validation-evidence/${asset.storage_path}`,
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["redacted", "expired"])(
    "does not fetch bytes for an explicitly %s manifest",
    async (state) => {
      const { fetch, supabase } = setup();
      fetch.mockResolvedValueOnce(Response.json([{ state }]));
      expect(await readPrivateValidationAsset({ supabase, workspaceId, asset })).toEqual({
        status: state,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("withholds verified bytes when a disposition was recorded during the download", async () => {
    const { fetch, supabase } = setup();
    fetch
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(contents))
      .mockResolvedValueOnce(Response.json([{ state: "redacted" }]));
    expect(await readPrivateValidationAsset({ supabase, workspaceId, asset })).toEqual({
      status: "redacted",
    });
  });

  it("fails closed when the disposition cannot be checked", async () => {
    const { fetch, supabase } = setup();
    fetch.mockResolvedValueOnce(
      Response.json({ message: "provider credentials" }, { status: 500 }),
    );
    expect(await readPrivateValidationAsset({ supabase, workspaceId, asset })).toEqual({
      status: "unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "NoSuchKey", "missing"],
    [400, "not_found", "missing"],
    [403, "AccessDenied", "inaccessible"],
    [404, "NoSuchBucket", "unavailable"],
    [500, "InternalError", "unavailable"],
  ])(
    "reports %s %s as %s without leaking provider diagnostics",
    async (httpStatus, code, status) => {
      const { fetch, supabase } = setup();
      fetch
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(
          Response.json({ code, message: "provider credentials" }, { status: httpStatus }),
        )
        .mockResolvedValueOnce(Response.json([]));
      expect(await readPrivateValidationAsset({ supabase, workspaceId, asset })).toEqual({
        status,
      });
    },
  );

  it("reports a withholding that caused Storage to hide an otherwise accessible object", async () => {
    const { fetch, supabase } = setup();
    fetch
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ code: "NoSuchKey" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json([{ state: "expired" }]));
    expect(await readPrivateValidationAsset({ supabase, workspaceId, asset })).toEqual({
      status: "expired",
    });
  });

  it("fails closed on a foreign or malformed manifest path before any request", async () => {
    const { fetch, supabase } = setup();
    expect(
      await readPrivateValidationAsset({
        supabase,
        workspaceId,
        asset: { ...asset, storage_path: "elsewhere/private-file" },
      }),
    ).toEqual({ status: "integrity_mismatch" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an integrity error for changed size or same-size tampering", async () => {
    const { fetch, supabase } = setup();
    for (const body of ["short", "x".repeat(asset.size_bytes)]) {
      fetch.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(new Response(body));
      expect(await readPrivateValidationAsset({ supabase, workspaceId, asset })).toEqual({
        status: "integrity_mismatch",
      });
    }
  });

  it("cancels an oversized response as soon as it crosses the manifest byte count", async () => {
    const { fetch, supabase } = setup();
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(asset.size_bytes));
        controller.enqueue(new Uint8Array(1));
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    fetch.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(new Response(body));
    expect(await readPrivateValidationAsset({ supabase, workspaceId, asset })).toEqual({
      status: "integrity_mismatch",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops before I/O when its caller is already disconnected", async () => {
    const { fetch, supabase } = setup();
    const result = await readPrivateValidationAsset({
      supabase,
      workspaceId,
      asset,
      signal: AbortSignal.abort(),
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels an in-flight byte stream when its caller disconnects", async () => {
    const { fetch, supabase } = setup();
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    fetch.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(new Response(body));

    const response = readPrivateValidationAsset({
      supabase,
      workspaceId,
      asset,
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    abort.abort();

    expect(await response).toEqual({ status: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
