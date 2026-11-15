import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as list } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/artifacts/route";
import { GET as item } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/artifacts/[kind]/[artifactId]/route";
import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/validation-evidence/private-asset", () => ({
  readPrivateValidationAsset: mocks.read,
}));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const artifactId = "00000000-0000-4000-8000-000000000004";
const anotherRunId = "00000000-0000-4000-8000-000000000005";
const base = `https://wallie.test/api/workspaces/${workspaceId}/runs/${runId}/artifacts`;
const markdown = "# Accepted output\n";
const digest = createHash("sha256").update(markdown).digest("hex");
const markdownRow = {
  artifact_id: artifactId,
  artifact_kind: "stage_markdown",
  label: "Build v2",
  digest,
  digest_algorithm: "sha256",
  content_type: "text/markdown",
  size_bytes: Buffer.byteLength(markdown),
  availability: "available",
  downloadable: true,
  run_id: runId,
  session_id: sessionId,
  attempt_count: 3,
  checkpoint_run_id: runId,
  accepted_commit_sha: "a".repeat(40),
  validation_run_id: runId,
  validation_commit_sha: "a".repeat(40),
  validation_tree_sha: "b".repeat(40),
  recorded_at: "2026-11-15T05:00:00Z",
};
const evidenceRow = {
  ...markdownRow,
  artifact_kind: "validation_report",
  label: "test-results",
  content_type: "text/plain",
  availability: "recorded",
};
const storageRow = {
  id: artifactId,
  run_id: runId,
  storage_path: `${workspaceId}/${runId}/${artifactId}`,
  content_type: evidenceRow.content_type,
  sha256: digest,
  size_bytes: evidenceRow.size_bytes,
};

function fixture(tables?: Partial<Record<string, unknown[]>>) {
  const data: Record<string, unknown[]> = {
    agent_runs: [{ id: runId }],
    list_run_artifacts: [markdownRow],
    session_artifacts: [{ artifact_json: markdown }],
    session_validation_assets: [storageRow],
    ...tables,
  };
  const requests: Array<{ url: URL; body: unknown }> = [];
  const supabase = createClient<Database>("https://database.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        requests.push({
          url,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        const name = url.pathname.split("/").at(-1) ?? "";
        return Response.json(data[name] ?? []);
      },
    },
  });
  mocks.access.mockResolvedValue({
    ok: true,
    context: { supabase, workspace: { id: workspaceId } },
  });
  return requests;
}

function getItem(kind: string, query = "", selectedRun = runId) {
  return item(new Request(`${base}/${kind}/${artifactId}${query}`), {
    params: Promise.resolve({ workspaceId, runId: selectedRun, kind, artifactId }),
  });
}

function getList(query = "", selectedRun = runId) {
  return list(new Request(`${base}${query}`), {
    params: Promise.resolve({ workspaceId, runId: selectedRun }),
  });
}

beforeEach(() => vi.resetAllMocks());

describe("workspace run artifact endpoints", () => {
  it("returns a bounded page with exact producer, receipt, and checkpoint identity", async () => {
    const requests = fixture({
      list_run_artifacts: [
        { ...markdownRow, storage_path: "hidden", artifact_json: "hidden" },
        evidenceRow,
      ],
    });
    const response = await getList("?limit=1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requests.find((request) => request.body)?.body).toEqual({
      p_workspace_id: workspaceId,
      p_run_id: runId,
      p_limit: 2,
    });
    const page = await response.json();
    expect(page.items).toEqual([
      expect.objectContaining({
        producer: { runId, sessionId, attemptCount: 3 },
        checkpoint: { runId, commitSha: "a".repeat(40) },
        validation: { runId, commitSha: "a".repeat(40), treeSha: "b".repeat(40) },
        digest: { algorithm: "sha256", value: digest },
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain("hidden");

    requests.length = 0;
    await getList(`?limit=1&cursor=${page.nextCursor}`);
    expect(requests.find((request) => request.body)?.body).toMatchObject({
      p_after_id: artifactId,
      p_after_kind: "stage_markdown",
    });
    requests.length = 0;
    expect((await getList(`?cursor=${page.nextCursor}`, anotherRunId)).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("keeps missing or unauthorized artifacts indistinguishable across runs", async () => {
    const requests = fixture({ list_run_artifacts: [] });
    expect((await getItem("validation_report", "?download=1", anotherRunId)).status).toBe(404);
    expect(requests[0].body).toEqual({
      p_workspace_id: workspaceId,
      p_run_id: anotherRunId,
      p_kind: "validation_report",
      p_artifact_id: artifactId,
      p_limit: 1,
    });
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.access.mockResolvedValue({ ok: false, status: 404, error: "Workspace not found." });
    requests.length = 0;
    expect((await getItem("validation_report")).status).toBe(404);
    expect(requests).toHaveLength(0);
  });

  it("returns Markdown only as a private attachment after verifying its bytes", async () => {
    fixture();
    const response = await getItem("stage_markdown", "?download=1");
    expect(await response.text()).toBe(markdown);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain(`wallie-${artifactId}.md`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    fixture({ session_artifacts: [{ artifact_json: "# Different output" }] });
    const conflict = await getItem("stage_markdown", "?download=1");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ availability: "integrity_mismatch" });
  });

  it("verifies one exact private manifest and never returns its path", async () => {
    const requests = fixture({ list_run_artifacts: [evidenceRow] });
    mocks.read.mockResolvedValue({
      status: "available",
      bytes: new TextEncoder().encode(markdown),
    });
    const meta = await getItem("validation_report");
    expect(await meta.json()).toMatchObject({
      artifact: { availability: "available", downloadable: true, producer: { runId } },
    });
    const download = await getItem("validation_report", "?download=1");
    expect(await download.text()).toBe(markdown);
    expect(download.headers.get("content-disposition")).toContain(`wallie-${artifactId}.txt`);
    const manifestQuery = requests.find(({ url }) =>
      url.pathname.endsWith("/session_validation_assets"),
    )?.url;
    expect(manifestQuery?.searchParams.get("run_id")).toBe(`eq.${runId}`);
    expect(manifestQuery?.searchParams.get("session_id")).toBe(`eq.${sessionId}`);
    expect(manifestQuery?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, asset: storageRow }),
    );
    fixture({
      list_run_artifacts: [evidenceRow],
      session_validation_assets: [{ ...storageRow, sha256: "f".repeat(64) }],
    });
    mocks.read.mockClear();
    expect((await getItem("validation_report", "?download=1")).status).toBe(409);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", 404],
    ["expired", 410],
    ["redacted", 410],
    ["inaccessible", 403],
  ])("keeps %s evidence distinct in metadata and download responses", async (status, code) => {
    fixture({ list_run_artifacts: [evidenceRow] });
    mocks.read.mockResolvedValue({ status });
    expect(await (await getItem("validation_report")).json()).toMatchObject({
      artifact: { availability: status, downloadable: false },
    });
    const response = await getItem("validation_report", "?download=1");
    expect(response.status).toBe(code);
    expect(await response.json()).toMatchObject({ availability: status });
  });

  it("offers retained checkpoint metadata while denying worker-only fallback downloads", async () => {
    fixture({
      list_run_artifacts: [
        {
          ...markdownRow,
          artifact_kind: "checkpoint",
          availability: "retained",
          downloadable: false,
        },
      ],
    });
    expect(await (await getItem("checkpoint")).json()).toMatchObject({
      artifact: { availability: "retained", downloadable: false },
    });
    const response = await getItem("checkpoint", "?download=1");
    expect(response.status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
