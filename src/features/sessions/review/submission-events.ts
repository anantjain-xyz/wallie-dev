"use client";

const FEEDBACK_SUBMITTED_EVENT = "wallie:artifact-feedback-submitted";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ArtifactFeedbackSubmissionNotice = {
  sessionId: string;
  artifactId: string;
  batchId: string;
};

function readNotice(value: unknown): ArtifactFeedbackSubmissionNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const notice = value as Partial<ArtifactFeedbackSubmissionNotice>;
  if (
    Object.keys(value).length !== 3 ||
    ![notice.sessionId, notice.artifactId, notice.batchId].every(
      (id) => typeof id === "string" && UUID.test(id),
    )
  )
    return null;
  return notice as ArtifactFeedbackSubmissionNotice;
}

/** An accepted receipt invalidates only the reviewed artifact in this tab. */
export function publishArtifactFeedbackSubmission(notice: ArtifactFeedbackSubmissionNotice) {
  if (typeof window === "undefined" || !readNotice(notice)) return;
  window.dispatchEvent(new CustomEvent(FEEDBACK_SUBMITTED_EVENT, { detail: { ...notice } }));
}

/** Refetch verified coverage; this notice never declares a thread submitted. */
export function subscribeArtifactFeedbackSubmissions(
  scope: Pick<ArtifactFeedbackSubmissionNotice, "sessionId" | "artifactId">,
  onAccepted: (notice: ArtifactFeedbackSubmissionNotice) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const receive = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const notice = readNotice(event.detail);
    if (notice && notice.sessionId === scope.sessionId && notice.artifactId === scope.artifactId)
      onAccepted(notice);
  };
  window.addEventListener(FEEDBACK_SUBMITTED_EVENT, receive);
  return () => window.removeEventListener(FEEDBACK_SUBMITTED_EVENT, receive);
}
