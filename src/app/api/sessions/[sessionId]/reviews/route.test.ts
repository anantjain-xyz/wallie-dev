import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  createArtifactReviewThread: vi.fn(),
  writeArtifactReviewComment: vi.fn(),
  transitionArtifactReviewThread: vi.fn(),
  listArtifactReviewThreads: vi.fn(),
  listArtifactReviewComments: vi.fn(),
}));
vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));
vi.mock("@/features/sessions/review/repository", () => ({
  createArtifactReviewThread: mocked.createArtifactReviewThread,
  writeArtifactReviewComment: mocked.writeArtifactReviewComment,
  transitionArtifactReviewThread: mocked.transitionArtifactReviewThread,
  listArtifactReviewThreads: mocked.listArtifactReviewThreads,
  listArtifactReviewComments: mocked.listArtifactReviewComments,
}));

import { GET, POST } from "./route";
import { GET as getThread, PATCH as transition } from "./[threadId]/route";
import { GET as getComments, POST as reply, PATCH as edit } from "./[threadId]/comments/route";

const SESSION = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const STAGE = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";
const THREAD = "55555555-5555-4555-8555-555555555555";
const COMMENT = "66666666-6666-4666-8666-666666666666";
const REQUEST = "77777777-7777-4777-8777-777777777777";
const MEMBER = "88888888-8888-4888-8888-888888888888";
const PIPELINE = "99999999-9999-4999-8999-999999999999";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const anchor = {
  coordinateSystem: "unicode_code_points",
  start: 0,
  end: 6,
  quote: "Review",
  prefix: "",
  suffix: " source",
};
const createBody = {
  requestId: REQUEST,
  artifactId: ARTIFACT,
  artifactVersion: 1,
  anchor,
  kind: "discussion",
  body: "Please clarify.",
};
const replyBody = { requestId: REQUEST, body: "A reply" };
const editBody = { ...replyBody, commentId: COMMENT, expectedRevision: 2 };
const transitionBody = {
  requestId: REQUEST,
  expectedRevision: 3,
  status: "resolved",
  reason: "Verified the correction.",
};
const routes = [
  { name: "list", handler: GET, method: "GET", body: undefined },
  { name: "thread", handler: getThread, method: "GET", body: undefined },
  { name: "create", handler: POST, method: "POST", body: createBody },
  { name: "comments", handler: getComments, method: "GET", body: undefined },
  { name: "reply", handler: reply, method: "POST", body: replyBody },
  { name: "edit", handler: edit, method: "PATCH", body: editBody },
  { name: "transition", handler: transition, method: "PATCH", body: transitionBody },
];
const writes = routes.filter((route) => route.method !== "GET");

function context(sessionId = SESSION, threadId = THREAD) {
  return { params: Promise.resolve({ sessionId, threadId }) };
}
function request(method = "GET", body?: unknown, query = `artifactId=${ARTIFACT}`) {
  return new Request(`http://localhost/api/sessions/${SESSION}/reviews?${query}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Row = Record<string, unknown>;
function client({
  archived = false,
  member = true,
  artifactSession = SESSION,
  threadSession = SESSION,
  stage = true,
  anyoneCanApprove = false,
  approvers = [] as string[],
  memberRole = "member",
  sessionExists = true,
  errorTable = "",
}: {
  archived?: boolean;
  member?: boolean;
  artifactSession?: string;
  threadSession?: string;
  stage?: boolean;
  anyoneCanApprove?: boolean;
  approvers?: readonly string[];
  memberRole?: string;
  sessionExists?: boolean;
  errorTable?: string;
} = {}) {
  const filters: Array<[string, string, unknown]> = [];
  const rowsByTable: Record<string, Row[]> = {
    sessions: sessionExists
      ? [
          {
            id: SESSION,
            workspace_id: WORKSPACE,
            pipeline_id: PIPELINE,
            artifact_review_revision: 8,
            archived_at: archived ? "2026-11-05" : null,
          },
        ]
      : [],
    workspace_members: member
      ? [
          {
            id: MEMBER,
            workspace_id: WORKSPACE,
            user_id: "user-1",
            role: memberRole,
            kind: "human",
            is_active: true,
          },
        ]
      : [],
    session_artifacts: [
      {
        id: ARTIFACT,
        session_id: artifactSession,
        workspace_id: WORKSPACE,
        stage_id: STAGE,
        version: 1,
      },
    ],
    pipeline_stages: stage
      ? [
          {
            id: STAGE,
            workspace_id: WORKSPACE,
            pipeline_id: PIPELINE,
            artifact_review_revision: 8,
            anyone_can_approve: anyoneCanApprove,
            approver_member_ids: approvers,
          },
        ]
      : [],
    artifact_feedback_batch_threads: [
      {
        thread_id: THREAD,
        thread_revision: 2,
        workspace_id: WORKSPACE,
        session_id: SESSION,
        artifact_id: ARTIFACT,
      },
      {
        thread_id: THREAD,
        thread_revision: 4,
        workspace_id: WORKSPACE,
        session_id: SESSION,
        artifact_id: ARTIFACT,
      },
      {
        thread_id: THREAD,
        thread_revision: 99,
        workspace_id: OTHER,
        session_id: OTHER,
        artifact_id: ARTIFACT,
      },
    ],
    artifact_review_comments: [
      { id: COMMENT, thread_id: THREAD, workspace_id: WORKSPACE, body: "Latest body", revision: 4 },
      { id: OTHER, thread_id: OTHER, workspace_id: WORKSPACE, body: "Another thread", revision: 1 },
    ],
    artifact_review_threads: [
      {
        id: THREAD,
        session_id: threadSession,
        workspace_id: WORKSPACE,
        artifact_id: ARTIFACT,
        stage_id: STAGE,
        status: "open",
        kind: "discussion",
      },
      {
        id: OTHER,
        session_id: SESSION,
        workspace_id: WORKSPACE,
        artifact_id: ARTIFACT,
        stage_id: STAGE,
        status: "open",
        kind: "blocking",
      },
    ],
  };
  const supabase = {
    from(table: string) {
      if (!(table in rowsByTable)) throw new Error(`Unexpected table or execution path: ${table}`);
      let rows = [...rowsByTable[table]!];
      const error =
        table === errorTable ? { code: "XX000", message: "Private database detail" } : null;
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push([table, column, value]);
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push([table, column, values]);
          rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        maybeSingle: async () => ({ data: error ? null : (rows[0] ?? null), error }),
        then<TResult1 = { data: Row[]; count: number; error: typeof error }, TResult2 = never>(
          fulfilled?:
            | ((result: {
                data: Row[];
                count: number;
                error: typeof error;
              }) => TResult1 | PromiseLike<TResult1>)
            | null,
          rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve({ data: rows, count: rows.length, error }).then(
            fulfilled,
            rejected,
          );
        },
      };
      return builder;
    },
  };
  mocked.createSupabaseServerClient.mockResolvedValue(supabase);
  return { supabase, filters };
}

describe("artifact review HTTP APIs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.listArtifactReviewThreads.mockResolvedValue({
      items: [{ id: THREAD }],
      nextCursor: null,
    });
    mocked.listArtifactReviewComments.mockResolvedValue({
      items: [{ id: COMMENT, body: "Reply" }],
      nextCursor: null,
    });
    mocked.createArtifactReviewThread.mockResolvedValue({ id: THREAD, anchor });
    mocked.writeArtifactReviewComment.mockResolvedValue({ id: COMMENT, revision: 3 });
    mocked.transitionArtifactReviewThread.mockResolvedValue({ id: THREAD, status: "resolved" });
    client();
  });

  it.each(routes)("requires sign-in for $name", async ({ handler, method, body }) => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);
    expect((await handler(request(method, body), context())).status).toBe(401);
  });
  it.each(routes)(
    "denies inactive or absent membership for $name",
    async ({ handler, method, body }) => {
      client({ member: false });
      expect((await handler(request(method, body), context())).status).toBe(403);
    },
  );
  it.each(routes)(
    "hides inaccessible RLS sessions for $name",
    async ({ handler, method, body }) => {
      client({ sessionExists: false });
      expect((await handler(request(method, body), context())).status).toBe(404);
    },
  );
  it.each(writes)(
    "freezes archived session writes for $name",
    async ({ handler, method, body }) => {
      client({ archived: true });
      expect((await handler(request(method, body), context())).status).toBe(409);
      expect(mocked.createArtifactReviewThread).not.toHaveBeenCalled();
      expect(mocked.writeArtifactReviewComment).not.toHaveBeenCalled();
      expect(mocked.transitionArtifactReviewThread).not.toHaveBeenCalled();
    },
  );
  it.each(routes)("validates path UUIDs for $name", async ({ handler, method, body }) => {
    expect((await handler(request(method, body), context("not-a-uuid"))).status).toBe(400);
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("returns separate capped pages, artifact-scoped counts and safe viewer capabilities", async () => {
    const { supabase } = client({ approvers: [MEMBER] });
    const response = await GET(request(), context());
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      reviewRevision: 8,
      submittedThreadRevisions: { [THREAD]: 4 },
      threads: [{ id: THREAD }],
      nextCursor: null,
      counts: { total: 2, open: 2, blocking: 1 },
      viewer: { memberId: MEMBER, canReview: true, readOnly: false },
    });
    expect(mocked.listArtifactReviewThreads).toHaveBeenCalledWith(supabase, {
      workspaceId: WORKSPACE,
      artifactId: ARTIFACT,
      pageSize: 20,
      cursor: undefined,
    });
    expect(mocked.listArtifactReviewComments).not.toHaveBeenCalled();
  });
  it("scopes submitted coverage to the requested workspace, session, artifact and loaded threads", async () => {
    const { filters } = client();
    const response = await GET(request(), context());
    expect((await response.json()).submittedThreadRevisions).toEqual({ [THREAD]: 4 });
    expect(filters).toEqual(
      expect.arrayContaining([
        ["artifact_feedback_batch_threads", "workspace_id", WORKSPACE],
        ["artifact_feedback_batch_threads", "session_id", SESSION],
        ["artifact_feedback_batch_threads", "artifact_id", ARTIFACT],
        ["artifact_feedback_batch_threads", "thread_id", [THREAD]],
      ]),
    );
  });
  it.each([
    [{ anyoneCanApprove: true }, true],
    [{ memberRole: "owner" }, true],
    [{ memberRole: "admin" }, true],
    [{ memberRole: "owner", approvers: [OTHER] }, false],
    [{ stage: false }, false],
    [{}, false],
  ] as const)("uses the stage reviewer policy %j", async (options, expected) => {
    client(options);
    expect((await (await GET(request(), context())).json()).viewer.canReview).toBe(expected);
  });
  it("loads a deep-linked exact thread without scanning every thread page", async () => {
    const response = await getThread(request(), context());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.thread.id).toBe(THREAD);
    expect(payload.submittedThreadRevision).toBe(4);
    expect(mocked.listArtifactReviewThreads).not.toHaveBeenCalled();
  });
  it("returns known-unsent status for an exact thread with no submitted snapshot", async () => {
    const response = await getThread(request(), context(SESSION, OTHER));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      thread: { id: OTHER },
      submittedThreadRevision: null,
    });
  });
  it("scopes exact-thread coverage by workspace, session and artifact even outside a list page", async () => {
    const { filters } = client();
    const response = await getThread(request(), context());
    expect((await response.json()).submittedThreadRevision).toBe(4);
    expect(filters).toEqual(
      expect.arrayContaining([
        ["artifact_feedback_batch_threads", "workspace_id", WORKSPACE],
        ["artifact_feedback_batch_threads", "session_id", SESSION],
        ["artifact_feedback_batch_threads", "artifact_id", ARTIFACT],
        ["artifact_feedback_batch_threads", "thread_id", [THREAD]],
      ]),
    );
  });
  it("allows read-only archived review history", async () => {
    client({ archived: true });
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect((await response.json()).viewer.readOnly).toBe(true);
  });
  it("rejects an artifact from a different session before reading threads", async () => {
    client({ artifactSession: OTHER });
    expect((await GET(request(), context())).status).toBe(404);
    expect(mocked.listArtifactReviewThreads).not.toHaveBeenCalled();
    expect((await POST(request("POST", createBody), context())).status).toBe(404);
    expect(mocked.createArtifactReviewThread).not.toHaveBeenCalled();
  });
  it.each(routes.filter((route) => route.name !== "list" && route.name !== "create"))(
    "binds the path session to the thread for $name",
    async ({ handler, method, body }) => {
      client({ threadSession: OTHER });
      expect((await handler(request(method, body), context())).status).toBe(404);
    },
  );
  it("requires a complete keyset cursor and validates the bounded page size", async () => {
    for (const query of [
      "pageSize=51",
      "pageSize=0",
      "pageSize=1.5",
      `cursorId=${THREAD}`,
      "cursorCreatedAt=not-a-time",
    ]) {
      expect(
        (await GET(request("GET", undefined, `artifactId=${ARTIFACT}&${query}`), context())).status,
      ).toBe(400);
    }
  });
  it("forwards the timestamp/id cursor without loading a nested history", async () => {
    const createdAt = "2026-11-05T00:00:00.000Z";
    const { supabase } = client();
    await getComments(
      request("GET", undefined, `pageSize=10&cursorId=${COMMENT}&cursorCreatedAt=${createdAt}`),
      context(),
    );
    expect(mocked.listArtifactReviewComments).toHaveBeenCalledWith(supabase, {
      workspaceId: WORKSPACE,
      threadId: THREAD,
      pageSize: 10,
      cursor: { createdAt, id: COMMENT },
    });
  });
  it("loads one exact comment for stale paginated edit recovery", async () => {
    const { filters } = client();
    const response = await getComments(
      request("GET", undefined, `commentId=${COMMENT}`),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      comments: [
        {
          id: COMMENT,
          thread_id: THREAD,
          workspace_id: WORKSPACE,
          body: "Latest body",
          revision: 4,
        },
      ],
      nextCursor: null,
    });
    expect(filters).toContainEqual(["artifact_review_comments", "id", COMMENT]);
    expect(filters).toContainEqual(["artifact_review_comments", "thread_id", THREAD]);
    expect(filters).toContainEqual(["artifact_review_comments", "workspace_id", WORKSPACE]);
    expect(mocked.listArtifactReviewComments).not.toHaveBeenCalled();
  });
  it("hides exact comments that are missing or belong to another thread", async () => {
    for (const commentId of [OTHER, ARTIFACT]) {
      const response = await getComments(
        request("GET", undefined, `commentId=${commentId}`),
        context(),
      );
      expect(response.status).toBe(404);
    }
    expect(mocked.listArtifactReviewComments).not.toHaveBeenCalled();
  });
  it("validates an exact comment id before querying the database", async () => {
    const response = await getComments(request("GET", undefined, "commentId=bad-id"), context());
    expect(response.status).toBe(400);
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });
  it("derives the workspace, session and stage and forwards a stable retry request id", async () => {
    const { supabase } = client();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await POST(request("POST", createBody), context())).status).toBe(200);
    }
    expect(mocked.createArtifactReviewThread).toHaveBeenCalledTimes(2);
    expect(mocked.createArtifactReviewThread).toHaveBeenNthCalledWith(1, supabase, {
      ...createBody,
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      stageId: STAGE,
    });
    expect(mocked.createArtifactReviewThread.mock.calls[0]).toEqual(
      mocked.createArtifactReviewThread.mock.calls[1],
    );
  });
  it("rejects caller-supplied actor or workspace identity", async () => {
    expect(
      (
        await POST(
          request("POST", { ...createBody, workspaceId: OTHER, actorId: OTHER }),
          context(),
        )
      ).status,
    ).toBe(400);
    expect(mocked.createArtifactReviewThread).not.toHaveBeenCalled();
  });
  it("rejects version mismatch before creating a thread", async () => {
    expect(
      (await POST(request("POST", { ...createBody, artifactVersion: 2 }), context())).status,
    ).toBe(409);
    expect(mocked.createArtifactReviewThread).not.toHaveBeenCalled();
  });
  it.each(writes)("requires a request id for $name", async ({ handler, method, body }) => {
    const withoutId = { ...body, requestId: undefined };
    expect((await handler(request(method, withoutId), context())).status).toBe(400);
  });
  it("forwards owned-comment edit identity and revision", async () => {
    const { supabase } = client();
    expect((await edit(request("PATCH", editBody), context())).status).toBe(200);
    expect(mocked.writeArtifactReviewComment).toHaveBeenCalledWith(supabase, {
      ...editBody,
      workspaceId: WORKSPACE,
      threadId: THREAD,
    });
  });
  it("forwards an explicit lifecycle reason and CAS revision", async () => {
    const { supabase } = client();
    expect((await transition(request("PATCH", transitionBody), context())).status).toBe(200);
    expect(mocked.transitionArtifactReviewThread).toHaveBeenCalledWith(supabase, {
      ...transitionBody,
      workspaceId: WORKSPACE,
      threadId: THREAD,
    });
  });
  it.each([
    ["40001", 409],
    ["23505", 409],
    ["42501", 403],
    ["23514", 400],
    ["XX000", 500],
  ])("maps mutation database error %s to %i without exposing its message", async (code, status) => {
    mocked.writeArtifactReviewComment.mockRejectedValue({
      code,
      message: "Private or untrusted database detail",
    });
    const response = await reply(request("POST", replyBody), context());
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain(
      "Private or untrusted database detail",
    );
  });
  it("does not expose internal lookup failures", async () => {
    client({ errorTable: "sessions" });
    const response = await GET(request(), context());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("Private database detail");
  });
  it("rejects malformed JSON and blank comments while preserving the submitted text", async () => {
    const invalid = new Request("http://localhost/reviews", { method: "POST", body: "{" });
    expect((await POST(invalid, context())).status).toBe(400);
    expect((await reply(request("POST", { ...replyBody, body: "   " }), context())).status).toBe(
      400,
    );
    const untrustedText = "<script>alert('xss')</script>";
    await reply(request("POST", { ...replyBody, body: untrustedText }), context());
    expect(mocked.writeArtifactReviewComment.mock.calls[0]?.[1].body).toBe(untrustedText);
  });
});
