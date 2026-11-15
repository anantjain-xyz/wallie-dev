import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { cleanupRunExports, drainRunExports } from "./worker";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const exportId = "20000000-0000-4000-8000-000000000002";
const leaseToken = "30000000-0000-4000-8000-000000000003";
const replacementToken = "30000000-0000-4000-8000-000000000004";
const runId = "40000000-0000-4000-8000-000000000004";
const assetId = "50000000-0000-4000-8000-000000000005";
const evidence = "line from retained validation\n";
const evidenceHash = digest(evidence);
const prefix = `${workspaceId}/${exportId}`;
const evidencePath = `${workspaceId}/${runId}/${assetId}`;
const snapshotAt = "2026-11-15T06:00:00+00:00";

function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function catalogRow(ordinal: number, fields = {}) {
  return {
    ordinal,
    record_id: runId,
    record_kind: "run",
    run_id: runId,
    metadata: {},
    payload: null,
    availability: "available",
    source_asset_id: null,
    ...fields,
  };
}

function catalogAsset(availability: string) {
  return catalogRow(1, {
    record_kind: "validation_asset",
    record_id: assetId,
    metadata: {
      sha256: evidenceHash,
      size_bytes: Buffer.byteLength(evidence),
      content_type: "text/plain",
    },
    availability,
    source_asset_id: availability === "recorded" ? assetId : null,
  });
}

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const admin = createClient<Database>("https://supabase.example", "test-key", {
    global: { fetch },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { fetch, admin };
}

function requestUrl(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input);
}

function decodeBody(init?: RequestInit) {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

function exportFixture(rows: ReturnType<typeof catalogRow>[]) {
  const { fetch, admin } = setup();
  const objects = new Map<string, Uint8Array>();
  const committed: unknown[] = [];
  const releases: unknown[] = [];
  let next = 1;
  let ready = true;
  let complete = false;
  let lostCommit = false;
  let lease = leaseToken;
  let unavailableEvidence = false;
  let missingEvidence = false;
  let corruptEvidence = false;
  fetch.mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const path = url.pathname;
    const body = decodeBody(init);
    switch (path) {
      case "/rest/v1/rpc/claim_run_export":
        if (!ready || complete) return Response.json([]);
        ready = false;
        return Response.json([
          {
            export_id: exportId,
            workspace_id: workspaceId,
            lease_token: lease,
            snapshot_at: snapshotAt,
            next_ordinal: next,
            status: "running",
          },
        ]);
      case "/rest/v1/rpc/read_run_export_page":
        expect(body).toEqual({ p_export_id: exportId, p_lease_token: lease, p_limit: 25 });
        return Response.json(rows.filter((row) => row.ordinal === next));
      case "/rest/v1/rpc/commit_run_export_page":
        expect(body).toMatchObject({
          p_export_id: exportId,
          p_lease_token: lease,
          p_first_ordinal: next,
        });
        expect(objects.get(`pages/${next}-${body.p_page_sha256}.json`)).toHaveLength(
          body.p_page_size_bytes,
        );
        committed.push(body);
        next += body.p_entries.length;
        if (lostCommit) {
          lostCommit = false;
          return Response.json({ message: "lost acknowledgement" }, { status: 503 });
        }
        return Response.json(true);
      case "/rest/v1/rpc/complete_run_export":
        expect(body).toEqual({ p_export_id: exportId, p_lease_token: lease });
        expect(next).toBe(rows.length + 1);
        complete = true;
        return Response.json(true);
      case "/rest/v1/rpc/release_run_export":
        releases.push(body);
        return Response.json(true);
      case "/rest/v1/session_validation_assets":
        expect(url.searchParams.get("id")).toBe(`eq.${assetId}`);
        expect(url.searchParams.get("run_id")).toBe(`eq.${runId}`);
        expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        return Response.json([
          {
            id: assetId,
            run_id: runId,
            sha256: evidenceHash,
            size_bytes: Buffer.byteLength(evidence),
            content_type: "text/plain",
            storage_path: evidencePath,
          },
        ]);
      case "/rest/v1/session_validation_asset_withholdings":
        return Response.json([]);
      case `/storage/v1/object/session-validation-evidence/${evidencePath}`:
        if (unavailableEvidence) return Response.json({ message: "failed" }, { status: 503 });
        if (missingEvidence) return Response.json({ code: "NoSuchKey" }, { status: 404 });
        return new Response(corruptEvidence ? evidence.replace("retained", "corrupt!") : evidence);
    }
    const filePrefix = `/storage/v1/object/workspace-run-exports/${prefix}/`;
    if (path.startsWith(filePrefix) && init?.method === "POST" && init.body instanceof Uint8Array) {
      const key = path.slice(filePrefix.length);
      expect(key).toContain(digest(init.body));
      expect(new Headers(init.headers).get("x-upsert")).toBe("false");
      objects.set(key, init.body);
      return Response.json({ Id: key, Key: key });
    }
    throw new Error(`Unexpected export fixture request ${path}`);
  });

  return {
    admin,
    committed,
    releases,
    objects,
    get complete() {
      return complete;
    },
    loseNextCommit() {
      lostCommit = true;
    },
    restart() {
      ready = true;
      lease = replacementToken;
    },
    setSourceUnavailable(value: boolean) {
      unavailableEvidence = value;
    },
    setSourceMissing() {
      missingEvidence = true;
    },
    setSourceCorrupt() {
      corruptEvidence = true;
    },
    page(ordinal: number) {
      const bytes = [...objects.entries()].find(([path]) => path.startsWith(`pages/${ordinal}-`));
      return bytes ? JSON.parse(new TextDecoder().decode(bytes[1])) : null;
    },
  };
}

describe("durable run export worker", () => {
  it("enumerates exact capture gaps, redacts worker diagnostics, and copies verified asset bytes", async () => {
    const fixture = exportFixture([
      catalogAsset("recorded"),
      catalogRow(2, {
        record_kind: "capture_gap",
        availability: "gap",
        metadata: { reason: "capture_end_missing" },
      }),
      catalogRow(3, {
        record_kind: "run_diagnostic",
        metadata: { kind: "worker_error" },
        payload: "api_key=synthetic-value",
      }),
    ]);

    await drainRunExports(fixture.admin);

    expect(fixture.complete).toBe(true);
    expect(fixture.releases).toEqual([]);
    expect(new TextDecoder().decode(fixture.objects.get(`assets/${assetId}-${evidenceHash}`))).toBe(
      evidence,
    );
    expect(fixture.page(1)).toMatchObject({
      workspaceId,
      exportId,
      firstOrdinal: 1,
      lastOrdinal: 1,
      records: [
        {
          id: assetId,
          runId,
          availability: "available",
          asset: { id: assetId, sha256: evidenceHash, sizeBytes: Buffer.byteLength(evidence) },
        },
      ],
    });
    expect(fixture.page(2).records).toMatchObject([
      { availability: "gap", metadata: { reason: "capture_end_missing" } },
    ]);
    expect(fixture.page(3).records).toMatchObject([
      { kind: "run_diagnostic", payload: "api_key=[redacted]" },
    ]);
  });

  it("resumes from the committed ordinal after a lost acknowledgement", async () => {
    const fixture = exportFixture([catalogRow(1), catalogRow(2)]);
    fixture.loseNextCommit();
    await drainRunExports(fixture.admin);
    expect(fixture.complete).toBe(false);
    expect(fixture.releases).toEqual([{ p_export_id: exportId, p_lease_token: leaseToken }]);

    fixture.restart();
    await drainRunExports(fixture.admin);
    expect(fixture.complete).toBe(true);
    expect(fixture.committed).toMatchObject([
      { p_first_ordinal: 1, p_lease_token: leaseToken },
      { p_first_ordinal: 2, p_lease_token: replacementToken },
    ]);
    expect([...fixture.objects]).toHaveLength(2);
  });

  it("retries temporary source failure before labelling or completing a page", async () => {
    const fixture = exportFixture([catalogAsset("recorded")]);
    fixture.setSourceUnavailable(true);
    await drainRunExports(fixture.admin);
    expect(fixture.committed).toEqual([]);
    expect(fixture.complete).toBe(false);
    expect(fixture.releases).toHaveLength(1);

    fixture.setSourceUnavailable(false);
    fixture.restart();
    await drainRunExports(fixture.admin);
    expect(fixture.complete).toBe(true);
  });

  it.each(["redacted", "expired", "missing", "inaccessible"])(
    "labels a %s object with provenance and does not copy its bytes",
    async (availability) => {
      const fixture = exportFixture([
        catalogAsset(
          ["missing", "inaccessible"].includes(availability) ? "recorded" : availability,
        ),
      ]);
      if (availability === "missing") fixture.setSourceMissing();
      if (availability === "inaccessible") fixture.setSourceCorrupt();
      await drainRunExports(fixture.admin);
      expect(fixture.complete).toBe(true);
      expect(fixture.page(1).records).toMatchObject([
        {
          id: assetId,
          availability,
          metadata: { sha256: evidenceHash },
          payload: null,
          ...(availability === "inaccessible" ? { reason: "integrity_mismatch" } : {}),
        },
      ]);
      expect([...fixture.objects]).toHaveLength(1);
    },
  );

  it("preserves exact Markdown that JSON escaping would grow beyond the transfer limit", async () => {
    const markdown = "\u0001".repeat(1024 * 1024);
    const fixture = exportFixture([
      catalogRow(1, { record_kind: "stage_markdown", payload: markdown }),
    ]);
    await drainRunExports(fixture.admin);
    expect(fixture.complete).toBe(true);
    const record = fixture.page(1).records[0];
    expect(record.payloadEncoding).toBe("base64");
    expect(digest(Buffer.from(record.payload, "base64"))).toBe(digest(markdown));
    expect([...fixture.objects.values()][0].byteLength).toBeLessThan(4 * 1024 * 1024);
  });

  it("completes an empty snapshot without manufacturing a page", async () => {
    const fixture = exportFixture([]);
    await drainRunExports(fixture.admin);
    expect(fixture.complete).toBe(true);
    expect([...fixture.objects]).toHaveLength(0);
  });
});

describe("run export cleanup", () => {
  it("retries a failed deletion under only the fenced job prefix before settling metadata", async () => {
    const { admin, fetch } = setup();
    const path = `${prefix}/manifest-page.json`;
    const otherPath = `${workspaceId}/${assetId}/manifest-page.json`;
    const objects = new Set([path, otherPath]);
    let deleteFailures = 1;
    let cleaned = false;
    fetch.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      switch (url.pathname) {
        case "/rest/v1/rpc/list_run_export_cleanup":
          return Response.json([{ export_id: exportId, workspace_id: workspaceId }]);
        case "/storage/v1/object/list/workspace-run-exports": {
          expect(decodeBody(init)).toMatchObject({ prefix });
          return Response.json(
            objects.has(path) ? [{ id: assetId, name: "manifest-page.json" }] : [],
          );
        }
        case "/storage/v1/object/workspace-run-exports":
          expect(new Headers(init?.headers).get("content-type")).toContain("application/json");
          expect(decodeBody(init)).toEqual({ prefixes: [path] });
          if (deleteFailures-- > 0) return Response.json({ message: "network" }, { status: 500 });
          objects.delete(path);
          return Response.json([]);
        case "/rest/v1/rpc/finish_run_export_cleanup":
          expect(decodeBody(init)).toEqual({ p_export_id: exportId, p_workspace_id: workspaceId });
          cleaned = true;
          return Response.json(true);
      }
      throw new Error(`Unexpected cleanup request ${url.pathname}`);
    });

    await cleanupRunExports(admin);
    expect(cleaned).toBe(false);
    expect([...objects]).toEqual([path, otherPath]);
    await cleanupRunExports(admin);
    expect(cleaned).toBe(true);
    expect([...objects]).toEqual([otherPath]);
  });
});
