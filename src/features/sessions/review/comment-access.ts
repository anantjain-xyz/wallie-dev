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
      return "Archived · Comments are read-only.";
    case "approved":
      return "Approved · Comments are read-only.";
    case "unauthorized":
      return "You don’t have permission to comment.";
    case "loading":
      return "Checking comment permissions…";
    case "unavailable":
      return "Couldn’t verify comment permissions. Retry loading.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
