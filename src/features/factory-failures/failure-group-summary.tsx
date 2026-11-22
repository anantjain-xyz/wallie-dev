import { Status } from "@/components/ui/status";
import type { FailureCohortSummary } from "@/lib/factory-failures/cohort-contracts";

const reasons: Record<FailureCohortSummary["qualification_reasons"][number], string> = {
  insufficient_support: "Insufficient support",
  mixed_versions: "Mixed versions",
  missing_evidence: "Missing evidence",
  missing_identity: "Incomplete configuration or task identity",
};

export function failureGroupTitle(cohort: FailureCohortSummary) {
  if (cohort.review.label) return cohort.review.label;
  const symptom =
    cohort.symptom_label ?? (cohort.symptom_kind === "scorer" ? "Scorer" : "Validation");
  if (cohort.partition === "selected") return `${symptom} · Selected runs`;
  if (cohort.partition === "remaining") return `${symptom} · Remaining runs`;
  return symptom;
}

export function FailureGroupStatus({ cohort }: { cohort: FailureCohortSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {cohort.qualification === "qualified" ? (
        <Status label="Qualified evidence" value="complete" />
      ) : (
        <Status label="Inconclusive" value="awaiting_review" />
      )}
      {cohort.review.disposition === "dismissed" ? (
        <Status label="Dismissed" value="archived" />
      ) : null}
      {cohort.review.disposition === "split" ? <Status label="Split" value="complete" /> : null}
    </div>
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
        <dt className="type-label text-muted">Evidence support</dt>
        <dd className="type-secondary mt-1 font-semibold">
          {cohort.support_count} of {cohort.minimum_support} needed
        </dd>
      </div>
      <div>
        <dt className="type-label text-muted">Versions</dt>
        <dd className="type-secondary mt-1 font-semibold">{cohort.version_count}</dd>
      </div>
    </dl>
  );
}
