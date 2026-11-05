import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";

import type { ArtifactSourceAnchor } from "./source-anchor";

export type ArtifactReviewThread = Tables<"artifact_review_threads">;
export type ArtifactReviewComment = Tables<"artifact_review_comments">;
export type ArtifactReviewEvent = Tables<"artifact_review_events">;

export type ArtifactReviewCursor = Readonly<{ createdAt: string; id: string }>;
export type ArtifactReviewPage<Row> = {
  items: Row[];
  nextCursor: ArtifactReviewCursor | null;
};

type ReviewPageInput = {
  workspaceId: string;
  pageSize?: number;
  cursor?: ArtifactReviewCursor;
};

function pageSize(requested: number | undefined): number {
  return requested === undefined || !Number.isFinite(requested)
    ? 50
    : Math.min(99, Math.max(1, Math.trunc(requested)));
}

function toPage<Row extends { created_at: string; id: string }>(
  rows: Row[],
  size: number,
): ArtifactReviewPage<Row> {
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > size && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

/** Writes use the caller's authenticated client; the RPC derives its human actor. */
export async function createArtifactReviewThread(
  supabase: SupabaseClient<Database>,
  input: {
    requestId: string;
    workspaceId: string;
    sessionId: string;
    stageId: string;
    artifactId: string;
    artifactVersion: number;
    anchor: ArtifactSourceAnchor;
    kind: "discussion" | "blocking";
    body: string;
  },
): Promise<ArtifactReviewThread> {
  const { data, error } = await supabase.rpc("create_artifact_review_thread_once", {
    p_request_id: input.requestId,
    p_workspace_id: input.workspaceId,
    p_session_id: input.sessionId,
    p_stage_id: input.stageId,
    p_artifact_id: input.artifactId,
    p_artifact_version: input.artifactVersion,
    p_anchor: input.anchor,
    p_kind: input.kind,
    p_body: input.body,
  });
  if (error) throw error;
  if (!data) throw new Error("Review thread was not returned.");
  return data;
}

export async function writeArtifactReviewComment(
  supabase: SupabaseClient<Database>,
  input: {
    requestId: string;
    workspaceId: string;
    threadId: string;
    body: string;
  } & (
    | { commentId?: never; expectedRevision?: never }
    | { commentId: string; expectedRevision: number }
  ),
): Promise<ArtifactReviewComment> {
  const { data, error } = await supabase.rpc("write_artifact_review_comment_once", {
    p_request_id: input.requestId,
    p_workspace_id: input.workspaceId,
    p_thread_id: input.threadId,
    p_body: input.body,
    p_comment_id: input.commentId,
    p_expected_revision: input.expectedRevision,
  });
  if (error) throw error;
  if (!data) throw new Error("Review comment was not returned.");
  return data;
}

export async function transitionArtifactReviewThread(
  supabase: SupabaseClient<Database>,
  input: {
    requestId: string;
    workspaceId: string;
    threadId: string;
    expectedRevision: number;
    status: "open" | "resolved" | "superseded";
    reason: string;
  },
): Promise<ArtifactReviewThread> {
  const { data, error } = await supabase.rpc("transition_artifact_review_thread_once", {
    p_request_id: input.requestId,
    p_workspace_id: input.workspaceId,
    p_thread_id: input.threadId,
    p_expected_revision: input.expectedRevision,
    p_status: input.status,
    p_reason: input.reason,
  });
  if (error) throw error;
  if (!data) throw new Error("Review thread was not returned.");
  return data;
}

/** Each history stream has its own keyset page; none eagerly loads another stream. */
export async function listArtifactReviewThreads(
  supabase: SupabaseClient<Database>,
  input: ReviewPageInput & { artifactId: string },
): Promise<ArtifactReviewPage<ArtifactReviewThread>> {
  const size = pageSize(input.pageSize);
  const { data, error } = await supabase.rpc("list_artifact_review_threads", {
    p_workspace_id: input.workspaceId,
    p_artifact_id: input.artifactId,
    p_limit: size + 1,
    p_after_created_at: input.cursor?.createdAt,
    p_after_id: input.cursor?.id,
  });
  if (error) throw error;
  return toPage(data ?? [], size);
}

export async function listArtifactReviewComments(
  supabase: SupabaseClient<Database>,
  input: ReviewPageInput & { threadId: string },
): Promise<ArtifactReviewPage<ArtifactReviewComment>> {
  const size = pageSize(input.pageSize);
  const { data, error } = await supabase.rpc("list_artifact_review_comments", {
    p_workspace_id: input.workspaceId,
    p_thread_id: input.threadId,
    p_limit: size + 1,
    p_after_created_at: input.cursor?.createdAt,
    p_after_id: input.cursor?.id,
  });
  if (error) throw error;
  return toPage(data ?? [], size);
}

export async function listArtifactReviewEvents(
  supabase: SupabaseClient<Database>,
  input: ReviewPageInput & { threadId: string },
): Promise<ArtifactReviewPage<ArtifactReviewEvent>> {
  const size = pageSize(input.pageSize);
  const { data, error } = await supabase.rpc("list_artifact_review_events", {
    p_workspace_id: input.workspaceId,
    p_thread_id: input.threadId,
    p_limit: size + 1,
    p_after_created_at: input.cursor?.createdAt,
    p_after_id: input.cursor?.id,
  });
  if (error) throw error;
  return toPage(data ?? [], size);
}
