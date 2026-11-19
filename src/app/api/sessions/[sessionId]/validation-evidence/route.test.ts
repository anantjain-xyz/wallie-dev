import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exactBrowserEvidenceSchema } from "@/features/wallie/browser-evidence-contracts";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  server: vi.fn(),
  admin: vi.fn(),
  download: vi.fn(),
  readStream: vi.fn(),
}));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocks.user }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.server }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { GET } from "./route";
import { GET as downloadAsset } from "./assets/[assetId]/route";
import { GET as downloadBrowserAsset } from "./browser-assets/[assetId]/route";
import { GET as downloadBrowserVideo } from "./browser-videos/[assetId]/route";

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
let browserStorageFrom: ReturnType<typeof vi.fn>;
let viewerRevoked: boolean;

function from(table: string, privileged = false) {
  const filters: Array<(row: Row) => boolean> = [];
  let maximum = Infinity;
  let fields = "*";
  const result = () => ({
    data: (viewerRevoked && !privileged ? [] : (rows[table] ?? []))
      .filter((row) => filters.every((filter) => filter(row)))
      .slice(0, maximum)
      .map((row) =>
        fields === "*"
          ? row
          : Object.fromEntries(fields.split(",").map((field) => [field.trim(), row[field.trim()]])),
      ),
    error:
      errors[table] ??
      (table === "session_browser_asset_withholdings" && !privileged ? { code: "42501" } : null),
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

const browserSelection = `?artifactId=${artifactId}&runId=${runId}`;

function markBrowserAsset(id: string, state: "expired" | "erased") {
  rows.session_browser_asset_withholdings.push({
    asset_id: id,
    workspace_id: workspaceId,
    session_id: sessionId,
    run_id: runId,
    state,
    recorded_at: "2026-11-20T09:30:00.000Z",
    purged_at: null,
  });
}

/** Hold the stream after presenting one valid byte to the private reader. */
function pauseBrowserRead(bytes: Uint8Array) {
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  mocks.readStream.mockImplementationOnce(async () => {
    let sentFirst = false;
    return {
      data: new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (!sentFirst) {
              sentFirst = true;
              controller.enqueue(bytes.subarray(0, 1));
              return;
            }
            paused.resolve();
            await release.promise;
            controller.enqueue(bytes.subarray(1));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      error: null,
    };
  });
  return { paused: paused.promise, release: release.resolve };
}

async function expectWithheld(response: Response, availability: "expired" | "erased") {
  expect(response.status).toBe(410);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(response.headers.get("location")).toBeNull();
  expect(await response.json()).toEqual({ error: expect.any(String), availability });
}

beforeEach(() => {
  vi.resetAllMocks();
  calls = [];
  errors = {};
  viewerRevoked = false;
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
    session_browser_asset_withholdings: [],
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
  browserStorageFrom = vi.fn(() => ({ download: mocks.download }));
  mocks.admin.mockReturnValue({
    from: (table: string) => from(table, true),
    storage: { from: browserStorageFrom },
  });
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
    expect(exactBrowserEvidenceSchema.parse(serialized).browserEvidence[0]?.records).toEqual(
      receipt.records,
    );
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
    expect(browserStorageFrom).toHaveBeenCalledOnce();
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("preserves the exact PNG receipt after retention while refusing bytes before Storage", async () => {
    const receipt = capturedReceipt();
    rows.session_browser_verification_receipts = [receipt];
    rows.session_validation_evidence = [];
    markBrowserAsset(screenshotId, "expired");

    const historical = await list(sessionId, browserSelection);
    expect(historical.status).toBe(200);
    expect(exactBrowserEvidenceSchema.parse(await historical.json()).browserEvidence).toMatchObject(
      [{ runId, commitSha, records: receipt.records }],
    );
    await expectWithheld(await downloadScreenshot(screenshotId, browserSelection), "expired");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("discards a verified PNG when the erasure marker lands while its stream is open", async () => {
    const held = pauseBrowserRead(png);
    const response = downloadScreenshot(screenshotId, browserSelection);
    await held.paused;
    markBrowserAsset(screenshotId, "erased");
    held.release();

    await expectWithheld(await response, "erased");
    expect(browserStorageFrom).toHaveBeenCalledOnce();
    expect(storageFrom).not.toHaveBeenCalled();
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

describe("exact browser recording evidence", () => {
  const videoId = "33333333-3333-4333-8333-333333333336";
  const otherRun = "77777777-7777-4777-8777-777777777777";
  const startedAt = "2026-11-19T08:00:00.000Z";
  const completedAt = "2026-11-19T08:00:01.500Z";
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    assetId: videoId,
    sha256,
    sizeBytes: bytes.length,
    contentType: "video/webm",
    durationMs: 1500,
    frameOffsetsMs: [0, 500, 1000],
    widthPx: 128,
    heightPx: 72,
  };
  const check = {
    key: "checkout",
    path: "/fixture",
    timeoutSeconds: 5,
    interactions: [
      { action: "click", testId: "open-review" },
      { action: "expectVisible", testId: "review-confirmed" },
    ],
    regionTestId: "view",
    excludedTestIds: [],
    evidence: [{ kind: "video", required: true }],
  };
  const identity = {
    key: check.key,
    kind: "video",
    path: check.path,
    policy: "isolated-fixture-v1",
  };
  const record = {
    ...identity,
    status: "captured",
    browserSessionId: artifactId,
    startedAt,
    completedAt,
    manifest,
  };
  const path = `${workspaceId}/${runId}/browser/${videoId}.webm`;
  const query = `?artifactId=${artifactId}&runId=${runId}`;
  const readVideo = (selection = query) =>
    downloadBrowserVideo(new Request(`https://wallie.test/video${selection}`), {
      params: Promise.resolve({ sessionId, assetId: videoId }),
    });

  beforeEach(() => {
    rows.session_validation_evidence = [];
    rows.session_browser_verification_receipts = [
      {
        run_id: runId,
        session_id: sessionId,
        workspace_id: workspaceId,
        created_at: completedAt,
        plan: {
          attempt_count: 2,
          commit_sha: commitSha,
          validation_tree_sha: "b".repeat(40),
          browser_plan: [check],
        },
        records: [record],
      },
    ];
    rows.session_browser_verification_assets.push({
      id: videoId,
      run_id: runId,
      workspace_id: workspaceId,
      session_id: sessionId,
      storage_path: path,
      sha256,
      content_type: "video/webm",
      size_bytes: bytes.length,
      duration_ms: manifest.durationMs,
      frame_offsets_ms: manifest.frameOffsetsMs,
      width_px: manifest.widthPx,
      height_px: manifest.heightPx,
      capture_started_at: startedAt,
      capture_completed_at: completedAt,
    });
    mocks.readStream.mockResolvedValue({ data: new Blob([bytes]).stream(), error: null });
  });

  it("maps frozen capture steps to the retained offsets without releasing private media metadata", async () => {
    const response = await list(sessionId, query);
    expect(response.status).toBe(200);
    const parsed = exactBrowserEvidenceSchema.parse(await response.json());
    expect(parsed.browserEvidence[0]).toMatchObject({
      runId,
      records: [record],
      videoFindings: [
        {
          assetId: videoId,
          steps: [
            { action: "entry", offsetMs: 0 },
            { action: "click", testId: "open-review", offsetMs: 500 },
            { action: "expectVisible", testId: "review-confirmed", offsetMs: 1000 },
          ],
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("storage_path");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("reports an incomplete capture when its otherwise valid timeline cannot cover the frozen plan", async () => {
    rows.session_browser_verification_receipts[0]!.records = [
      {
        ...record,
        manifest: { ...manifest, durationMs: 1000, frameOffsetsMs: [0, 500] },
      },
    ];
    const response = await list(sessionId, query);
    expect(await response.json()).toMatchObject({
      browserEvidence: [
        {
          runId,
          records: [{ ...identity, status: "failed", reason: "capture_failed" }],
        },
      ],
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("does not release bytes after logout, membership revocation, or exact run/source mismatch", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await readVideo()).status).toBe(401);
    const members = rows.workspace_members;
    rows.workspace_members = [];
    expect((await readVideo()).status).toBe(403);
    rows.workspace_members = members;
    expect((await readVideo(`?runId=${otherRun}`)).status).toBe(404);
    expect((await readVideo(`?artifactId=${artifactId}&runId=${otherRun}`)).status).toBe(409);
    rows.session_validation_plans[0]!.commit_sha = "c".repeat(40);
    expect((await readVideo()).status).toBe(409);
    expect(mocks.download).not.toHaveBeenCalled();

    rows.session_git_checkpoints[0]!.output_sha = "c".repeat(40);
    const response = await list(sessionId, query);
    expect(await response.json()).toMatchObject({
      browserEvidence: [
        {
          runId,
          records: [{ ...identity, status: "failed", reason: "source_changed" }],
        },
      ],
    });
  });

  it("returns verified WebM privately and reports missing or incomplete stored data as unavailable", async () => {
    const available = await readVideo();
    expect(available.status).toBe(200);
    expect(available.headers.get("Content-Type")).toBe("video/webm");
    expect(available.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Buffer.from(await available.arrayBuffer())).toEqual(bytes);
    expect(mocks.download).toHaveBeenCalledWith(path, {}, expect.any(Object));
    expect(browserStorageFrom).toHaveBeenCalledOnce();
    expect(storageFrom).not.toHaveBeenCalled();

    mocks.readStream.mockResolvedValueOnce({ data: null, error: { status: 404 } });
    expect((await readVideo()).status).toBe(409);
    rows.session_browser_verification_assets[1]!.frame_offsets_ms = [0, 1000];
    expect((await readVideo()).status).toBe(409);
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it("retains the exact recording's provenance while its pending erasure prevents new reads", async () => {
    markBrowserAsset(videoId, "erased");
    const historical = await list(sessionId, query);
    expect(historical.status).toBe(200);
    expect(exactBrowserEvidenceSchema.parse(await historical.json()).browserEvidence).toMatchObject(
      [{ runId, commitSha, records: [record] }],
    );
    await expectWithheld(await readVideo(), "erased");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("discards verified WebM when expiration is committed during the read", async () => {
    const held = pauseBrowserRead(bytes);
    const response = readVideo();
    await held.paused;
    markBrowserAsset(videoId, "expired");
    held.release();

    await expectWithheld(await response, "expired");
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("does not hand already-fetched WebM to a viewer whose access ends during the read", async () => {
    const held = pauseBrowserRead(bytes);
    const response = readVideo();
    await held.paused;
    viewerRevoked = true;
    held.release();

    const denied = await response;
    expect(denied.status).toBe(404);
    expect(denied.headers.get("content-disposition")).toBeNull();
    expect(denied.headers.get("content-type")).toMatch(/^application\/json/);
    expect(mocks.download).toHaveBeenCalledOnce();
  });
});
