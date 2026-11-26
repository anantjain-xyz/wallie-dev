import type { FailureCohortMember } from "@/lib/factory-failures/cohort-contracts";

const observedAt = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export const failureEvidenceLabels = {
  available: "Evidence available",
  withheld: "Evidence withheld",
  unavailable: "Evidence unavailable",
};

export function failureMemberLabel(member: FailureCohortMember) {
  const session = member.session_title?.trim();
  const number = member.session_number == null ? null : `#${member.session_number}`;
  const title = session
    ? `${session}${number ? ` (${number})` : ""}`
    : number
      ? `Session ${number}`
      : "Session title not recorded";
  return `${title} · ${member.stage_name?.trim() || "Stage not recorded"} · Attempt ${member.run_attempt_count}`;
}

export function failureMemberObservation(member: FailureCohortMember) {
  return `${observedAt.format(new Date(member.observed_at))} UTC`;
}
