import { workspaceRunDetailPath } from "@/lib/routes";

const adjudicationTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

export function calibrationCaseName(
  item: {
    session_title?: string | null;
    stage_name?: string | null;
    attempt_number?: number | null;
  },
  fallback: string,
) {
  if (!item.session_title) return fallback;
  return [
    item.session_title,
    item.stage_name,
    item.attempt_number ? `Evaluation attempt ${item.attempt_number}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function calibrationCaseVerdict(item: {
  disposition?: string | null;
  status?: string | null;
  expected_status?: string | null;
  created_at?: string | null;
}) {
  return [
    item.disposition === "disputed"
      ? "Disputed"
      : item.disposition === "confirmed"
        ? "Confirmed"
        : null,
    item.expected_status ? `${item.status} → ${item.expected_status}` : item.status,
    item.created_at ? `${adjudicationTime.format(new Date(item.created_at))} UTC` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function calibrationCaseHref(
  workspaceSlug: string,
  adjudicationId: string,
  runId: string,
  attemptId: string,
) {
  const search = new URLSearchParams({
    evaluationAttempt: attemptId,
    evaluationAdjudication: adjudicationId,
  });
  return `${workspaceRunDetailPath(workspaceSlug, runId)}?${search}#adjudication-${adjudicationId}`;
}
