import { Status } from "@/components/ui/status";
import type { FailureCohortSummary } from "@/lib/factory-failures/cohort-contracts";
import { titleFromSlug } from "@/lib/utils";

const reasons: Record<FailureCohortSummary["qualification_reasons"][number], string> = {
  insufficient_support: "Too few sessions with available evidence",
  mixed_versions: "Runs used different producing configurations",
  missing_evidence: "Missing evidence",
  missing_identity: "Incomplete configuration or task identity",
};

export function failureGroupSymptom(cohort: FailureCohortSummary) {
  return (
    cohort.symptom_label ??
    (cohort.symptom_kind === "scorer" ? "Scorer failure" : "Validation failure")
  );
}

export function failureGroupTask(cohort: FailureCohortSummary) {
  return cohort.task_class_slug ? titleFromSlug(cohort.task_class_slug) : "Task class not recorded";
}

export function failureGroupTitle(cohort: FailureCohortSummary) {
  if (cohort.review.label) return cohort.review.label;
  const symptom = failureGroupSymptom(cohort);
  if (cohort.partition === "selected") return `${symptom} · Selected runs`;
  if (cohort.partition === "remaining") return `${symptom} · Remaining runs`;
  return symptom;
}

export function FailureGroupStatus({
  cohort,
  compact = false,
}: {
  cohort: FailureCohortSummary;
  compact?: boolean;
}) {
  const state = cohort.review.disposition;
  const labelClass = compact ? "sr-only" : "type-annotation text-muted";
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-2">
      <div className="flex items-center gap-2">
        <dt className={labelClass}>Review</dt>
        <dd>
          {cohort.partition ? (
            <Status label="Split snapshot" value="archived" />
          ) : state === "dismissed" ? (
            <Status label="Dismissed" value="archived" />
          ) : state === "split" ? (
            <Status label="Split" value="complete" />
          ) : (
            <Status label="Open" value="queued" />
          )}
        </dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className={labelClass}>Evidence</dt>
        <dd>
          {cohort.qualification === "qualified" ? (
            <Status label="Qualified evidence" value="complete" />
          ) : (
            <Status label="Inconclusive" value="awaiting_review" />
          )}
        </dd>
      </div>
    </dl>
  );
}

export function FailureGroupLimits({ cohort }: { cohort: FailureCohortSummary }) {
  if (!cohort.qualification_reasons.length) return null;
  return (
    <p className="type-secondary text-muted">
      {cohort.qualification_reasons.map((reason) => reasons[reason]).join(" · ")}
    </p>
  );
}

export function FailureGroupCounts({ cohort }: { cohort: FailureCohortSummary }) {
  return (
    <dl className="grid grid-cols-3 gap-3 tabular-nums sm:gap-5">
      <div>
        <dt className="type-label text-muted">Failed runs</dt>
        <dd className="type-secondary mt-1 font-semibold">{cohort.failure_count}</dd>
      </div>
      <div>
        <dt className="type-label text-muted">Sessions with evidence</dt>
        <dd className="type-secondary mt-1 font-semibold">
          {cohort.support_count} of {cohort.minimum_support} needed
        </dd>
      </div>
      <div>
        <dt className="type-label text-muted">Producing configurations</dt>
        <dd className="type-secondary mt-1 font-semibold">{cohort.version_count}</dd>
      </div>
    </dl>
  );
}
