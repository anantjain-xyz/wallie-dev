import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  createArtifactReviewThread,
  listArtifactReviewComments,
  listArtifactReviewEvents,
  listArtifactReviewThreads,
  transitionArtifactReviewThread,
  writeArtifactReviewComment,
  type ArtifactReviewComment,
  type ArtifactReviewEvent,
  type ArtifactReviewThread,
} from "./repository";
import { createArtifactSourceAnchor } from "./source-anchor";

const anchor = createArtifactSourceAnchor("Review this source", 0, 6);
const createdAt = "2026-11-05T00:00:00.000Z";

function thread(id = "thread-1"): ArtifactReviewThread {
  return {
    id,
    workspace_id: "workspace-1",
    session_id: "session-1",
    artifact_id: "artifact-1",
    stage_id: "stage-1",
    stage_slug: "plan",
    artifact_version: 1,
    anchor,
    kind: "blocking",
    status: "open",
    author_member_id: "member-1",
    author_label: "Reviewer",
    revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function comment(id = "comment-1"): ArtifactReviewComment {
  return {
    id,
    workspace_id: "workspace-1",
    thread_id: "thread-1",
    author_member_id: "member-1",
    author_label: "Reviewer",
    body: "Please explain the retry policy.",
    revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function event(id = "event-1"): ArtifactReviewEvent {
  return {
    id,
    workspace_id: "workspace-1",
    thread_id: "thread-1",
    actor_member_id: "member-1",
    actor_label: "Reviewer",
    event_type: "created",
    detail: { body: "Please explain the retry policy." },
    review_revision: 1,
    created_at: createdAt,
  };
}

function clientWithResponse(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  const supabase = createClient<Database>("https://wallie.test", "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetcher },
  });
  return { supabase, fetcher };
}

function expectRequest(
  fetcher: ReturnType<typeof clientWithResponse>["fetcher"],
  rpc: string,
  body: unknown,
) {
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0];
  expect(String(url)).toBe(`https://wallie.test/rest/v1/rpc/${rpc}`);
  expect(options?.method).toBe("POST");
  expect(JSON.parse(String(options?.body))).toEqual(body);
}

const createInput = {
  workspaceId: "workspace-1",
  sessionId: "session-1",
  stageId: "stage-1",
  artifactId: "artifact-1",
  artifactVersion: 1,
  anchor,
  kind: "blocking" as const,
  body: "Please explain the retry policy.",
};

describe("artifact review repository", () => {
  it("forwards exact artifact identity, source anchor, kind and initial comment", async () => {
    const { supabase, fetcher } = clientWithResponse(thread());

    expect(await createArtifactReviewThread(supabase, createInput)).toEqual(thread());
    expectRequest(fetcher, "create_artifact_review_thread", {
      p_workspace_id: "workspace-1",
      p_session_id: "session-1",
      p_stage_id: "stage-1",
      p_artifact_id: "artifact-1",
      p_artifact_version: 1,
      p_anchor: anchor,
      p_kind: "blocking",
      p_body: createInput.body,
    });
  });

  it("creates a reply without supplying an actor, anchor or edit revision", async () => {
    const { supabase, fetcher } = clientWithResponse(comment());

    expect(
      await writeArtifactReviewComment(supabase, {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        body: "Reply",
      }),
    ).toEqual(comment());
    expectRequest(fetcher, "write_artifact_review_comment", {
      p_workspace_id: "workspace-1",
      p_thread_id: "thread-1",
      p_body: "Reply",
    });
  });

  it("preserves the expected comment revision when editing", async () => {
    const { supabase, fetcher } = clientWithResponse(comment());

    await writeArtifactReviewComment(supabase, {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      commentId: "comment-1",
      expectedRevision: 3,
      body: "Clarified request",
    });
    expectRequest(fetcher, "write_artifact_review_comment", {
      p_workspace_id: "workspace-1",
      p_thread_id: "thread-1",
      p_comment_id: "comment-1",
      p_expected_revision: 3,
      p_body: "Clarified request",
    });
  });

  it.each(["open", "resolved", "superseded"] as const)(
    "forwards a lifecycle transition to %s with its revision and reason",
    async (status) => {
      const { supabase, fetcher } = clientWithResponse(thread());

      expect(
        await transitionArtifactReviewThread(supabase, {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          expectedRevision: 4,
          status,
          reason: "Human review decision",
        }),
      ).toEqual(thread());
      expectRequest(fetcher, "transition_artifact_review_thread", {
        p_workspace_id: "workspace-1",
        p_thread_id: "thread-1",
        p_expected_revision: 4,
        p_status: status,
        p_reason: "Human review decision",
      });
    },
  );

  it("pages threads using the last returned row, including tied timestamps", async () => {
    const rows = [thread("thread-1"), thread("thread-2"), thread("thread-3")];
    const { supabase, fetcher } = clientWithResponse(rows);
    const cursor = { createdAt, id: "previous-thread" };

    expect(
      await listArtifactReviewThreads(supabase, {
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
        pageSize: 2,
        cursor,
      }),
    ).toEqual({ items: rows.slice(0, 2), nextCursor: { createdAt, id: "thread-2" } });
    expectRequest(fetcher, "list_artifact_review_threads", {
      p_workspace_id: "workspace-1",
      p_artifact_id: "artifact-1",
      p_limit: 3,
      p_after_created_at: cursor.createdAt,
      p_after_id: cursor.id,
    });
  });

  it("pages comments independently with the same keyset contract", async () => {
    const rows = [comment("comment-1"), comment("comment-2")];
    const { supabase, fetcher } = clientWithResponse(rows);

    expect(
      await listArtifactReviewComments(supabase, {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        pageSize: 1,
      }),
    ).toEqual({ items: [rows[0]], nextCursor: { createdAt, id: "comment-1" } });
    expectRequest(fetcher, "list_artifact_review_comments", {
      p_workspace_id: "workspace-1",
      p_thread_id: "thread-1",
      p_limit: 2,
    });
  });

  it("pages events independently and reports an exhausted page", async () => {
    const { supabase, fetcher } = clientWithResponse([event()]);
    const cursor = { createdAt, id: "previous-event" };

    expect(
      await listArtifactReviewEvents(supabase, {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        pageSize: 1,
        cursor,
      }),
    ).toEqual({ items: [event()], nextCursor: null });
    expectRequest(fetcher, "list_artifact_review_events", {
      p_workspace_id: "workspace-1",
      p_thread_id: "thread-1",
      p_limit: 2,
      p_after_created_at: cursor.createdAt,
      p_after_id: cursor.id,
    });
  });

  it.each([
    [undefined, 51],
    [0, 2],
    [-1, 2],
    [2.9, 3],
    [99, 100],
    [1000, 100],
    [NaN, 51],
    [Infinity, 51],
  ])("bounds page size %s and reserves a lookahead row", async (pageSize, limit) => {
    const { supabase, fetcher } = clientWithResponse([]);

    expect(
      await listArtifactReviewThreads(supabase, {
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
        pageSize,
      }),
    ).toEqual({ items: [], nextCursor: null });
    expectRequest(fetcher, "list_artifact_review_threads", {
      p_workspace_id: "workspace-1",
      p_artifact_id: "artifact-1",
      p_limit: limit,
    });
  });

  const operations = [
    (supabase: ReturnType<typeof clientWithResponse>["supabase"]) =>
      createArtifactReviewThread(supabase, createInput),
    (supabase: ReturnType<typeof clientWithResponse>["supabase"]) =>
      writeArtifactReviewComment(supabase, {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        body: "Reply",
      }),
    (supabase: ReturnType<typeof clientWithResponse>["supabase"]) =>
      transitionArtifactReviewThread(supabase, {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        expectedRevision: 1,
        status: "resolved",
        reason: "Verified",
      }),
    (supabase: ReturnType<typeof clientWithResponse>["supabase"]) =>
      listArtifactReviewThreads(supabase, {
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
      }),
    (supabase: ReturnType<typeof clientWithResponse>["supabase"]) =>
      listArtifactReviewComments(supabase, { workspaceId: "workspace-1", threadId: "thread-1" }),
    (supabase: ReturnType<typeof clientWithResponse>["supabase"]) =>
      listArtifactReviewEvents(supabase, { workspaceId: "workspace-1", threadId: "thread-1" }),
  ];

  it.each(operations)("propagates database authorization errors (%#)", async (operation) => {
    const failure = { code: "42501", message: "Active human membership required." };
    const { supabase } = clientWithResponse(failure, 403);

    await expect(operation(supabase)).rejects.toMatchObject(failure);
  });

  it("preserves stale revision errors for an edit conflict", async () => {
    const failure = { code: "40001", message: "Review comment revision is stale." };
    const { supabase } = clientWithResponse(failure, 409);

    await expect(
      writeArtifactReviewComment(supabase, {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        commentId: "comment-1",
        expectedRevision: 1,
        body: "Conflicting edit",
      }),
    ).rejects.toMatchObject(failure);
  });
});
