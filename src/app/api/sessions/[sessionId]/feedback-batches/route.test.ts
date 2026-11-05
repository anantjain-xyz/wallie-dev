import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.client }));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocks.user }));
import { GET } from "./route";
import { GET as reviews } from "../reviews/route";
import { POST as preview } from "./preview/route";
import { createArtifactSourceAnchor } from "@/features/sessions/review/source-anchor";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const session = id(1),
  workspace = id(2),
  stage = id(3),
  artifact = id(4),
  batch = id(5),
  thread = id(6),
  run = id(7),
  job = id(8),
  sourceArtifact = id(9);
const source = "Original paragraph.\n\n";
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let filters: Array<[string, string, unknown]>;
let limits: Array<[string, number]>;
let ors: Array<[string, string]>;
let fail: string;

function query(table: string) {
  let selected = rows[table] ?? [];
  let head = false;
  let size = Infinity;
  const builder = {
    select: (_fields: string, options?: { head?: boolean }) => {
      head = Boolean(options?.head);
      return builder;
    },
    eq: (key: string, value: unknown) => {
      filters.push([table, key, value]);
      selected = selected.filter((row) => row[key] === value);
      return builder;
    },
    in: (key: string, values: unknown[]) => {
      filters.push([table, key, values]);
      selected = selected.filter((row) => values.includes(row[key]));
      return builder;
    },
    or: (value: string) => {
      ors.push([table, value]);
      return builder;
    },
    order: () => builder,
    limit: (value: number) => {
      limits.push([table, value]);
      size = value;
      return builder;
    },
    maybeSingle: async () => ({
      data: selected[0] ?? null,
      error: fail === table ? { code: "oops" } : null,
    }),
    then: (resolve: (result: unknown) => unknown) =>
      Promise.resolve({
        data: head ? null : selected.slice(0, size),
        count: selected.length,
        error: fail === table ? { code: "oops" } : null,
      }).then(resolve),
  };
  return builder;
}
function call(extra = "", handler = GET) {
  return handler(
    new Request(
      `http://localhost/api/sessions/${session}/feedback-batches?artifactId=${artifact}${extra}`,
    ),
    { params: Promise.resolve({ sessionId: session }) },
  );
}
beforeEach(() => {
  filters = [];
  limits = [];
  ors = [];
  fail = "";
  mocks.user.mockResolvedValue({ id: "user" });
  mocks.client.mockResolvedValue({ from: query });
  rows = {
    sessions: [
      {
        id: session,
        workspace_id: workspace,
        pipeline_id: id(20),
        archived_at: null,
        artifact_review_revision: 7,
      },
    ],
    workspace_members: [
      {
        id: id(10),
        workspace_id: workspace,
        user_id: "user",
        kind: "human",
        is_active: true,
        role: "owner",
      },
    ],
    pipeline_stages: [
      { id: stage, workspace_id: workspace, pipeline_id: id(20), anyone_can_approve: true },
    ],
    session_artifacts: [
      {
        id: artifact,
        workspace_id: workspace,
        session_id: session,
        stage_id: stage,
        version: 2,
        artifact_json: "Intro\n\n" + source,
        stage_slug: "build",
      },
      {
        id: sourceArtifact,
        workspace_id: workspace,
        session_id: session,
        stage_id: stage,
        version: 1,
        artifact_json: source,
        stage_slug: "build",
      },
    ],
    artifact_feedback_batches: [
      {
        id: batch,
        workspace_id: workspace,
        session_id: session,
        stage_id: stage,
        artifact_id: sourceArtifact,
        artifact_version: 1,
        run_id: run,
        job_id: job,
        created_at: "2026-11-05T00:00:00Z",
        rendered_feedback_text: "Saved agent input",
      },
      { id: id(99), workspace_id: id(98), session_id: session, stage_id: stage },
    ],
    artifact_feedback_batch_threads: [
      {
        batch_id: batch,
        workspace_id: workspace,
        session_id: session,
        artifact_id: sourceArtifact,
        thread_id: thread,
        thread_revision: 1,
        kind: "blocking",
        anchor: createArtifactSourceAnchor(source, 0, 8),
        comments: [
          {
            id: id(12),
            revision: 1,
            author_member_id: id(10),
            author_label: "Original reviewer",
            body: "Immutable request",
            created_at: "then",
            updated_at: "then",
          },
        ],
      },
    ],
    artifact_review_threads: [
      {
        id: thread,
        workspace_id: workspace,
        session_id: session,
        stage_id: stage,
        artifact_id: sourceArtifact,
        artifact_version: 1,
        status: "open",
        kind: "blocking",
        anchor: createArtifactSourceAnchor(source, 0, 8),
        created_at: "2026-11-05T00:00:00Z",
      },
    ],
    session_git_checkpoints: [
      {
        artifact_id: artifact,
        session_id: session,
        workspace_id: workspace,
        job_id: job,
        run_id: run,
      },
    ],
    agent_runs: [{ id: run, workspace_id: workspace, session_id: session, status: "success" }],
    agent_jobs: [{ id: job, workspace_id: workspace, session_id: session, status: "succeeded" }],
  };
});
describe("authenticated feedback history", () => {
  it("previews exact source identities and current comments without writing or enqueueing", async () => {
    rows.artifact_review_threads![0]!.revision = 2;
    rows.artifact_review_comments = [
      {
        id: id(12),
        workspace_id: workspace,
        thread_id: thread,
        revision: 2,
        author_label: "Reviewer B",
        body: "Current comment",
        created_at: "then",
      },
    ];
    const response = await preview(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({
          artifactId: artifact,
          version: 2,
          expectedReviewRevision: 7,
          selectedThreadIds: [thread],
          note: "",
        }),
      }),
      { params: Promise.resolve({ sessionId: session }) },
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.renderedFeedback).toContain(`Original artifact ${sourceArtifact} version 1`);
    expect(result.renderedFeedback).toContain(
      `Comment ${id(12)} (revision 2) by Reviewer B:\nCurrent comment`,
    );
    expect(filters.some(([table]) => table === "agent_jobs")).toBe(false);
  });
  it("rejects stale previews and closed selected threads", async () => {
    const request = (revision: number) =>
      preview(
        new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({
            artifactId: artifact,
            version: 2,
            expectedReviewRevision: revision,
            selectedThreadIds: [thread],
            note: "",
          }),
        }),
        { params: Promise.resolve({ sessionId: session }) },
      );
    expect((await request(6)).status).toBe(409);
    rows.artifact_review_threads![0]!.status = "resolved";
    expect((await request(7)).status).toBe(400);
  });
  it("rejects unauthenticated and inactive members", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    mocks.user.mockResolvedValue({ id: "user" });
    rows.workspace_members = [];
    expect((await call()).status).toBe(403);
  });
  it("rejects foreign artifacts, batches and malformed selectors", async () => {
    expect((await call(`&batchId=${id(99)}`)).status).toBe(404);
    expect((await call("&batchId=bad")).status).toBe(400);
    rows.session_artifacts![0]!.workspace_id = id(98);
    expect((await call()).status).toBe(404);
  });
  it("returns immutable snapshots and the exact accepted run rather than live comments", async () => {
    rows.artifact_review_comments = [{ body: "Later edit that must not be sent" }];
    const response = await call(`&batchId=${batch}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = await response.json();
    expect(result.threads[0]).toMatchObject({
      artifact_id: sourceArtifact,
      sourceVersion: 1,
      comments: [{ body: "Immutable request", author_label: "Original reviewer", revision: 1 }],
    });
    expect(result.output).toMatchObject({ artifactId: artifact, version: 2, run: { id: run } });
    expect(filters).toEqual(
      expect.arrayContaining([
        ["artifact_feedback_batches", "workspace_id", workspace],
        ["artifact_feedback_batches", "session_id", session],
        ["artifact_feedback_batches", "stage_id", stage],
        ["agent_runs", "session_id", session],
      ]),
    );
  });
  it("keeps failed batches available with no accepted output", async () => {
    rows.session_git_checkpoints = [];
    rows.agent_runs![0]!.status = "failed";
    const result = await (await call(`&batchId=${batch}`)).json();
    expect(result.initialRun.status).toBe("failed");
    expect(result.output).toBeNull();
    expect(result.threads).toHaveLength(1);
  });
  it("does not require authenticated access to the private jobs table", async () => {
    fail = "agent_jobs";
    expect((await call(`&batchId=${batch}`)).status).toBe(200);
    expect(filters.some(([table]) => table === "agent_jobs")).toBe(false);
  });
  it("caps and keyset-pages history, and looks up the received batch by exact job", async () => {
    const result = await (await call()).json();
    expect(result.batches).toHaveLength(1);
    expect(result.receivedBatchId).toBe(batch);
    expect(limits).toContainEqual(["artifact_feedback_batches", 21]);
    expect((await call(`&cursorCreatedAt=2026-11-05T00:00:00Z&cursorId=${batch}`)).status).toBe(
      200,
    );
    expect(
      ors.some(
        ([table, value]) =>
          table === "artifact_feedback_batches" && value.includes(`id.lt.${batch}`),
      ),
    ).toBe(true);
  });
  it("fails closed on missing snapshot data or read failures", async () => {
    fail = "artifact_feedback_batch_threads";
    expect((await call(`&batchId=${batch}`)).status).toBe(500);
    fail = "";
    rows.artifact_feedback_batch_threads![0]!.comments = [{ body: "invalid" }];
    expect((await call(`&batchId=${batch}`)).status).toBe(500);
  });
  it("carries unresolved threads with safe mapping and source-scoped coverage", async () => {
    const result = await (await call("&includeUnresolved=true", reviews)).json();
    expect(result.threads[0].id).toBe(thread);
    expect(result.mappings[thread].status).toBe("mapped");
    expect(filters).toContainEqual([
      "artifact_feedback_batch_threads",
      "artifact_id",
      sourceArtifact,
    ]);
    expect(ors).toContainEqual([
      "artifact_review_threads",
      `artifact_id.eq.${artifact},and(status.eq.open,artifact_version.lt.2)`,
    ]);
    expect(limits).toContainEqual(["artifact_review_threads", 21]);
  });
});
