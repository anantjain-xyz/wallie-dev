import type { Tables } from "@/lib/supabase/database.types";

export type ArtifactReviewThread = Tables<"artifact_review_threads">;
export type ArtifactReviewComment = Tables<"artifact_review_comments">;
export type ReviewCursor = { createdAt: string; id: string };
export type ReviewViewer = { memberId: string; canReview: boolean; readOnly: boolean };
export type ReviewThreadListPayload = {
  reviewRevision: number;
  submittedThreadRevisions: Record<string, number>;
  threads: ArtifactReviewThread[];
  nextCursor: ReviewCursor | null;
  counts: { total: number; open: number; blocking: number };
  viewer: ReviewViewer;
};
export type ReviewCommentListPayload = {
  comments: ArtifactReviewComment[];
  nextCursor: ReviewCursor | null;
};
