import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exactBrowserScreenshotEvidenceSchema } from "@/features/wallie/browser-screenshot-evidence-contracts";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  server: vi.fn(),
  download: vi.fn(),
  readStream: vi.fn(),
}));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocks.user }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.server }));

import { GET } from "./route";
import { GET as downloadAsset } from "./assets/[assetId]/route";
import { GET as downloadBrowserAsset } from "./browser-assets/[assetId]/route";

const sessionId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const artifactId = "66666666-6666-4666-8666-666666666666";
const commitSha = "a".repeat(40);
const contents = "redacted command output\n";
const asset = {
  id: assetId,
  workspace_id: workspaceId,
  session_id: sessionId,
  run_id: runId,
  evidence_key: "unit-tests/log",
  kind: "log",
  required: false,
  storage_path: `${workspaceId}/${runId}/${assetId}`,
  sha256: createHash("sha256").update(contents).digest("hex"),
  content_type: "text/plain",
  size_bytes: Buffer.byteLength(contents),
};

const screenshotId = "33333333-3333-4333-8333-333333333335";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQVDIGAACuAGcVHqFfAAAAAElFTkSuQmCC",
  "base64",
);
const screenshot = {
  ...asset,
  id: screenshotId,
  storage_path: `${workspaceId}/${runId}/browser/${screenshotId}.png`,
  sha256: createHash("sha256").update(png).digest("hex"),
  content_type: "image/png",
  size_bytes: png.length,
};

type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let errors: Record<string, unknown>;
let calls: Array<{ table: string; op: string; args: unknown[] }>;
let storageFrom: ReturnType<typeof vi.fn>;

function from(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let maximum = Infinity;
  let fields = "*";
  const result = () => ({
    data: (rows[table] ?? [])
      .filter((row) => filters.every((filter) => filter(row)))
      .slice(0, maximum)
      .map((row) =>
        fields === "*"
          ? row
          : Object.fromEntries(fields.split(",").map((field) => [field.trim(), row[field.trim()]])),
      ),
    error: errors[table] ?? null,
  });
  return {
    select(value: string) {
      calls.push({ table, op: "select", args: [value] });
      fields = value.replace(/plan:session_validation_plans!inner\([^)]*\)/, "plan");
      return this;
    },
    eq(column: string, value: unknown) {
      calls.push({ table, op: "eq", args: [column, value] });
      filters.push((row) => row[column] === value);
      return this;
    },
    in(column: string, values: unknown[]) {
      calls.push({ table, op: "in", args: [column, values] });
      filters.push((row) => values.includes(row[column]));
      return this;
    },
    order(column: string, options: unknown) {
      calls.push({ table, op: "order", args: [column, options] });
      return this;
    },
    limit(value: number) {
      calls.push({ table, op: "limit", args: [value] });
      maximum = value;
      return this;
    },
    abortSignal() {
      return this;
    },
    async maybeSingle() {
      const value = result();
      return { ...value, data: value.data[0] ?? null };
    },
    then(resolve: (value: ReturnType<typeof result>) => unknown) {
      return Promise.resolve(result()).then(resolve);
    },
  };
}

const list = (id = sessionId, query = "") =>
  GET(new Request(`https://wallie.test/evidence${query}`), {
    params: Promise.resolve({ sessionId: id }),
  });
const download = (ids: { sessionId?: string; assetId?: string } = {}, artifact?: string) =>
  downloadAsset(
    new Request(
      `https://wallie.test/evidence/asset${artifact === undefined ? "" : `?artifactId=${artifact}`}`,
    ),
    {
      params: Promise.resolve({ sessionId, assetId, ...ids }),
    },
  );

const downloadScreenshot = (id = screenshotId, query = "") =>
  downloadBrowserAsset(new Request(`https://wallie.test/evidence/browser-asset${query}`), {
    params: Promise.resolve({ sessionId, assetId: id }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  calls = [];
  errors = {};
  rows = {
    sessions: [{ id: sessionId, workspace_id: workspaceId, archived_at: null }],
    workspace_members: [
      {
        id: "member-1",
        workspace_id: workspaceId,
        user_id: userId,
        kind: "human",
        is_active: true,
      },
    ],
    session_validation_evidence: [
      {
        run_id: runId,
        session_id: sessionId,
        workspace_id: workspaceId,
        commit_sha: commitSha,
        records: [],
      },
    ],
    session_validation_assets: [{ ...asset }],
    session_browser_verification_assets: [{ ...screenshot }],
    session_browser_verification_receipts: [],
    session_validation_plans: [
      { run_id: runId, workspace_id: workspaceId, session_id: sessionId, commit_sha: commitSha },
    ],
    session_git_checkpoints: [
      {
        artifact_id: artifactId,
        session_id: sessionId,
        workspace_id: workspaceId,
        run_id: runId,
        output_sha: commitSha,
      },
    ],
  };
  mocks.user.mockResolvedValue({ id: userId });
  mocks.download.mockReturnValue({ asStream: mocks.readStream });
  mocks.readStream.mockImplementation(async () => ({
    data: new Blob([contents]).stream(),
    error: null,
  }));
  storageFrom = vi.fn(() => ({ download: mocks.download }));
  mocks.server.mockResolvedValue({ from, storage: { from: storageFrom } });
});

describe("validation evidence metadata", () => {
  it("returns bounded, session-scoped observations and authenticated asset links", async () => {
    rows.session_validation_assets.push({ ...asset, id: "other-run", run_id: "other-run" });
    const response = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.evidence).toEqual([expect.objectContaining(rows.session_validation_evidence[0]!)]);
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0].downloadUrl).toBe(
      `/api/sessions/${sessionId}/validation-evidence/assets/${assetId}`,
    );
    expect(body.assets[0]).not.toHaveProperty("storage_path");
    expect(body).not.toHaveProperty("ready");
    expect(calls).toEqual(
      expect.arrayContaining([
        { table: "session_validation_evidence", op: "limit", args: [10] },
        { table: "session_validation_assets", op: "limit", args: [1000] },
        { table: "session_validation_assets", op: "eq", args: ["workspace_id", workspaceId] },
        { table: "session_validation_assets", op: "in", args: ["run_id", [runId]] },
      ]),
    );
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("includes every manifest at the ten-receipt boundary without exceeding the API row ceiling", async () => {
    rows.session_validation_evidence = Array.from({ length: 11 }, (_, index) => ({
      run_id: `run-${index}`,
      session_id: sessionId,
      workspace_id: workspaceId,
      records: [],
    }));
    rows.session_validation_assets = rows.session_validation_evidence.flatMap((receipt) =>
      Array.from({ length: 100 }, (_, index) => ({
        ...asset,
        id: `${receipt.run_id}-asset-${index}`,
        run_id: receipt.run_id,
      })),
    );
    const body = await (await list()).json();
    expect(body.evidence).toHaveLength(10);
    expect(body.assets).toHaveLength(1000);
    expect(body.assets).toContainEqual(expect.objectContaining({ id: "run-9-asset-99" }));
    expect(body.assets.some((item: { run_id: string }) => item.run_id === "run-10")).toBe(false);
  });

  it("handles sessions with no execution evidence without inventing validation", async () => {
    rows.session_validation_evidence = [];
    expect(await (await list()).json()).toEqual({ evidence: [], assets: [], browserEvidence: [] });
    expect(calls.some((call) => call.table === "session_validation_assets")).toBe(false);
  });

  it("rejects malformed session ids before opening an authenticated client", async () => {
    expect((await list("invalid")).status).toBe(400);
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it("requires sign-in and current human workspace membership", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await list()).status).toBe(401);
    rows.workspace_members[0]!.is_active = false;
    expect((await list()).status).toBe(403);
    expect(calls.some((call) => call.table === "session_validation_evidence")).toBe(false);
  });

  it("does not disclose another session or database failure details", async () => {
    expect((await list("66666666-6666-4666-8666-666666666666")).status).toBe(404);
    errors.session_validation_assets = { message: "private detail secret" };
    const response = await list();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private detail secret");
  });
});

describe("validation evidence asset downloads", () => {
  it("reauthorizes an exact artifact-owned evidence link before returning stored bytes", async () => {
    const response = await download({}, artifactId);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(contents);
    expect(calls).toEqual(
      expect.arrayContaining([
        { table: "session_git_checkpoints", op: "eq", args: ["artifact_id", artifactId] },
        { table: "session_git_checkpoints", op: "eq", args: ["session_id", sessionId] },
        { table: "session_git_checkpoints", op: "eq", args: ["workspace_id", workspaceId] },
      ]),
    );
  });

  it.each([
    ["session_git_checkpoints", "artifact_id", "another-artifact"],
    ["session_git_checkpoints", "workspace_id", "another-workspace"],
    ["session_git_checkpoints", "session_id", "another-session"],
    ["session_validation_assets", "run_id", "another-run"],
    ["session_validation_evidence", "run_id", "another-run"],
    ["session_validation_evidence", "commit_sha", "b".repeat(40)],
  ])(
    "rejects an artifact link with mismatched %s.%s before storage access",
    async (table, field, value) => {
      rows[table]![0]![field] = value;
      expect((await download({}, artifactId)).status).toBe(409);
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );

  it("does not reveal artifact evidence to signed-out or inactive workspace members", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await download({}, artifactId)).status).toBe(401);
    rows.workspace_members[0]!.is_active = false;
    expect((await download({}, artifactId)).status).toBe(403);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(calls.some((call) => call.table === "session_git_checkpoints")).toBe(false);
  });

  it.each(["session_git_checkpoints", "session_validation_evidence"])(
    "does not download legacy evidence without a retained %s association",
    async (table) => {
      rows[table] = [];
      const response = await download({}, artifactId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Evidence is unavailable for this artifact.",
      });
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );

  it.each(["session_git_checkpoints", "session_validation_evidence"])(
    "fails closed when the artifact's %s association cannot be read",
    async (table) => {
      errors[table] = { message: "private provider detail" };
      const response = await download({}, artifactId);
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("private provider detail");
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );

  it("does not disclose a foreign-workspace asset even when the session identity matches", async () => {
    rows.session_validation_assets[0]!.workspace_id = "another-workspace";
    expect((await download({}, artifactId)).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(calls.some((call) => call.table === "session_git_checkpoints")).toBe(false);
  });

  it("rejects a malformed artifact identity before creating a client", async () => {
    expect((await download({}, "invalid")).status).toBe(400);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("reauthorizes and verifies the stored bytes before returning a plain-text attachment", async () => {
    const response = await download();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(contents);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(storageFrom).toHaveBeenCalledExactlyOnceWith("session-validation-evidence");
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(
      asset.storage_path,
      {},
      {
        cache: "no-store",
        signal: expect.any(AbortSignal),
      },
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        { table: "session_validation_assets", op: "eq", args: ["id", assetId] },
        { table: "session_validation_assets", op: "eq", args: ["session_id", sessionId] },
        { table: "session_validation_assets", op: "eq", args: ["workspace_id", workspaceId] },
      ]),
    );
  });

  it("rejects invalid ids, unauthenticated access, inactive members, and wrong-session assets", async () => {
    expect((await download({ assetId: "../invalid" })).status).toBe(400);
    expect(mocks.server).not.toHaveBeenCalled();
    mocks.user.mockResolvedValueOnce(null);
    expect((await download()).status).toBe(401);
    rows.workspace_members[0]!.is_active = false;
    expect((await download()).status).toBe(403);
    rows.workspace_members[0]!.is_active = true;
    rows.session_validation_assets[0]!.session_id = "other-session";
    expect((await download()).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each([
    ["size_bytes", 1024 * 1024 + 1],
    ["size_bytes", -1],
    ["content_type", "text/html"],
    ["sha256", "invalid"],
    ["storage_path", "another-workspace/asset"],
  ])("rejects invalid manifest %s before touching storage", async (field, value) => {
    rows.session_validation_assets[0]![field as string] = value;
    expect((await download()).status).toBe(409);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("fails closed for inaccessible or missing objects without exposing provider diagnostics", async () => {
    mocks.readStream.mockResolvedValueOnce({
      data: null,
      error: { message: "secret provider URL" },
    });
    const response = await download();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("secret provider URL");
    mocks.readStream.mockResolvedValueOnce({ data: null, error: null });
    expect((await download()).status).toBe(409);
  });

  it("rejects changed size and same-size tampering", async () => {
    mocks.readStream.mockResolvedValueOnce({ data: new Blob(["short"]).stream(), error: null });
    expect((await download()).status).toBe(409);
    mocks.readStream.mockResolvedValueOnce({
      data: new Blob(["x".repeat(asset.size_bytes)]).stream(),
      error: null,
    });
    expect((await download()).status).toBe(409);
  });

  it.each(["expired", "redacted"])(
    "blocks %s assets even on previously issued links",
    async (state) => {
      rows.session_validation_asset_withholdings = [{ asset_id: assetId, state }];
      const response = await download({}, artifactId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Evidence asset is unavailable." });
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );
});

describe("private screenshot evidence", () => {
  function capturedReceipt() {
    return {
      run_id: runId,
      session_id: sessionId,
      workspace_id: workspaceId,
      created_at: "2026-11-19T08:00:00Z",
      plan: { attempt_count: 2, commit_sha: commitSha, validation_tree_sha: "b".repeat(40) },
      records: [
        {
          key: "checkout",
          kind: "screenshot",
          path: "/fixture",
          policy: "isolated-fixture-v1",
          status: "captured",
          browserSessionId: artifactId,
          manifest: {
            assetId: screenshotId,
            sha256: screenshot.sha256,
            sizeBytes: screenshot.size_bytes,
            contentType: "image/png",
          },
        },
      ],
    };
  }

  it("finds the producing screenshot receipt even when newer runs filled the session limit", async () => {
    const receipt = capturedReceipt();
    rows.session_validation_evidence = [];
    rows.session_browser_verification_receipts = [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...receipt,
        run_id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      })),
      receipt,
    ];
    const scoped = await list(sessionId, `?artifactId=${artifactId}`);
    expect(scoped.status).toBe(200);
    const serialized = await scoped.json();
    expect(serialized).toMatchObject({
      browserEvidence: [
        {
          runId,
          commitSha,
          records: [
            {
              downloadUrl: `/api/sessions/${sessionId}/validation-evidence/browser-assets/${screenshotId}?runId=${runId}&artifactId=${artifactId}`,
            },
          ],
        },
      ],
    });
    expect(
      exactBrowserScreenshotEvidenceSchema.parse(serialized).browserEvidence[0]?.records,
    ).toEqual(receipt.records);
    expect(calls).toContainEqual({
      table: "session_browser_verification_receipts",
      op: "eq",
      args: ["run_id", runId],
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("rejects inconsistent provenance selectors before reading screenshot bytes", async () => {
    const otherRunId = "77777777-7777-4777-8777-777777777777";
    const query = `?runId=${otherRunId}&artifactId=${artifactId}`;
    expect((await list(sessionId, query)).status).toBe(409);
    expect((await downloadScreenshot(screenshotId, query)).status).toBe(409);
    expect((await downloadScreenshot(screenshotId, `?runId=${otherRunId}`)).status).toBe(404);
    expect((await downloadScreenshot(screenshotId, "?runId=invalid")).status).toBe(400);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("preserves stale provenance while withholding a different-commit screenshot", async () => {
    const receipt = capturedReceipt();
    const different = "c".repeat(40);
    receipt.plan.commit_sha = different;
    rows.session_browser_verification_receipts = [receipt];
    rows.session_validation_plans[0].commit_sha = different;
    const query = `?artifactId=${artifactId}`;
    const result = await (await list(sessionId, query)).json();
    expect(result.browserEvidence).toEqual([
      expect.objectContaining({
        commitSha: different,
        records: [
          {
            key: "checkout",
            kind: "screenshot",
            path: "/fixture",
            policy: "isolated-fixture-v1",
            status: "failed",
            reason: "source_changed",
          },
        ],
      }),
    ]);
    expect((await downloadScreenshot(screenshotId, query)).status).toBe(409);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("authorizes an exact artifact-owned PNG independently of command evidence", async () => {
    rows.session_validation_evidence = [];
    mocks.readStream.mockResolvedValueOnce({ data: new Blob([png]).stream(), error: null });
    const response = await downloadScreenshot(
      screenshotId,
      `?runId=${runId}&artifactId=${artifactId}`,
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it("lists exact outcomes and authenticated image links without command evidence or provider metadata", async () => {
    rows.session_validation_evidence = [];
    rows.session_browser_verification_receipts = [
      {
        run_id: runId,
        session_id: sessionId,
        workspace_id: workspaceId,
        created_at: "2026-11-19T08:00:00Z",
        plan: { attempt_count: 2, commit_sha: commitSha, validation_tree_sha: "b".repeat(40) },
        records: [
          {
            key: "checkout",
            kind: "screenshot",
            path: "/fixture",
            policy: "isolated-fixture-v1",
            status: "captured",
            browserSessionId: artifactId,
            manifest: {
              assetId: screenshotId,
              sha256: screenshot.sha256,
              sizeBytes: screenshot.size_bytes,
              contentType: "image/png",
            },
          },
          {
            key: "checkout",
            kind: "video",
            path: "/fixture",
            policy: "isolated-fixture-v1",
            status: "unavailable",
            reason: "runtime_unavailable",
          },
        ],
      },
    ];
    const body = await (await list()).json();
    expect(body.browserEvidence).toEqual([
      expect.objectContaining({
        attemptCount: 2,
        commitSha,
        records: [
          expect.objectContaining({
            status: "captured",
            downloadUrl: `/api/sessions/${sessionId}/validation-evidence/browser-assets/${screenshotId}`,
          }),
          expect.objectContaining({ status: "unavailable" }),
        ],
        runId,
        treeSha: "b".repeat(40),
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("storage_path");
  });

  it("returns an authenticated PNG after reading only the retained manifest and verifying its bytes", async () => {
    mocks.readStream.mockResolvedValueOnce({ data: new Blob([png]).stream(), error: null });
    const response = await downloadScreenshot();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(mocks.download).toHaveBeenCalledWith(screenshot.storage_path, {}, expect.any(Object));
  });

  it("rechecks session, workspace, authorization, and stored integrity", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await downloadScreenshot()).status).toBe(401);
    rows.session_browser_verification_assets[0]!.workspace_id = "foreign-workspace";
    expect((await downloadScreenshot()).status).toBe(404);
    rows.session_browser_verification_assets[0]!.workspace_id = workspaceId;
    rows.session_browser_verification_assets[0]!.session_id = "foreign-session";
    expect((await downloadScreenshot()).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();

    rows.session_browser_verification_assets[0]!.session_id = sessionId;
    expect((await downloadScreenshot()).status).toBe(409);
  });
});
