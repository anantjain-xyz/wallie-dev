export type ReviewSessionReadOnlyReason = "archived" | "approved";
export type ReviewReadOnlyReason =
  | ReviewSessionReadOnlyReason
  | "unauthorized"
  | "loading"
  | "unavailable";

export function sessionReviewReadOnlyReason({
  archivedAt,
  phaseStatus,
}: {
  archivedAt: string | null | undefined;
  phaseStatus: string;
}): ReviewSessionReadOnlyReason | null {
  if (archivedAt) return "archived";
  return phaseStatus === "approved" ? "approved" : null;
}

export function reviewReadOnlyMessage(reason: ReviewReadOnlyReason): string {
  switch (reason) {
    case "archived":
      return "This session is archived. Comments are read-only.";
    case "approved":
      return "This session is approved. Comments are read-only.";
    case "unauthorized":
      return "You do not have permission to comment on this artifact.";
    case "loading":
      return "Checking comment permissions…";
    case "unavailable":
      return "Comments are unavailable until permissions can be verified. Retry loading comments.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
