"use client";

import Link from "next/link";

import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField } from "@/components/ui/select";
import { useInsightFilters } from "@/features/insights/use-insight-filters";
import type {
  FailureRevisionOption,
  FailureRevisionPage,
} from "@/lib/factory-failures/cohort-contracts";

import { FailureRevisionPicker } from "./failure-revision-picker";

export function FailureGroupFilters({
  path,
  factoryId,
  applied,
  revisions,
  pinned,
  clearHref,
  revisionProblem,
}: {
  path: string;
  factoryId: string;
  applied: { symptom: string; revision: string; disposition: string };
  revisions: FailureRevisionPage;
  pinned: FailureRevisionOption[];
  clearHref: string;
  revisionProblem?: "missing" | "malformed";
}) {
  const { filters, pending, update } = useInsightFilters(
    path,
    { factory: factoryId, order: "failures" },
    applied,
  );
  const filtered = filters.symptom || filters.disposition || (filters.revision && !revisionProblem);
  const clearRevision = new URLSearchParams({ factory: factoryId, order: "failures" });
  if (filters.symptom) clearRevision.set("symptom", filters.symptom);
  if (filters.disposition) clearRevision.set("disposition", filters.disposition);

  return (
    <div
      aria-busy={pending}
      aria-label="Failure group filters"
      className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_minmax(0,1.6fr)_1fr_minmax(6rem,auto)] sm:items-start sm:px-5"
      role="group"
    >
      <SelectField
        label="Symptom"
        labelClassName="type-label"
        name="symptom"
        onValueChange={(value) => {
          if (value !== filters.symptom) update({ ...filters, symptom: value });
        }}
        options={[
          { label: "All symptoms", value: "" },
          { label: "Scorer failures", value: "scorer" },
          { label: "Validation failures", value: "validation" },
        ]}
        triggerClassName={FILTER_CONTROL_CLASS}
        value={filters.symptom}
      />
      <FailureRevisionPicker
        endpoint={`${path}/revisions?factory=${factoryId}`}
        initialPage={revisions}
        onValueChange={(value) => {
          if (value !== filters.revision || revisionProblem === "malformed") {
            update({ ...filters, revision: value });
          }
        }}
        pinned={pinned}
        selected={filters.revision}
      />
      <SelectField
        label="Review state"
        labelClassName="type-label"
        name="disposition"
        onValueChange={(value) => {
          if (value !== filters.disposition) update({ ...filters, disposition: value });
        }}
        options={[
          { label: "All states", value: "" },
          { label: "Open", value: "open" },
          { label: "Dismissed", value: "dismissed" },
          { label: "Split", value: "split" },
        ]}
        triggerClassName={FILTER_CONTROL_CLASS}
        value={filters.disposition}
      />
      {filtered ? (
        <Link
          className={`ui-button justify-self-start sm:mt-6 ${FILTER_CONTROL_CLASS}`}
          href={clearHref}
          prefetch={false}
          scroll={false}
        >
          Clear filters
        </Link>
      ) : null}
      {revisionProblem ? (
        <p className="type-secondary text-muted sm:col-span-full" role="status">
          {revisionProblem === "missing"
            ? "This revision isn’t available in this factory. Choose another revision."
            : "The revision in this link is invalid. Showing all revisions."}{" "}
          <Link
            className="rounded-sm font-medium underline underline-offset-4 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            href={`${path}?${clearRevision}`}
            prefetch={false}
            scroll={false}
          >
            Clear revision filter
          </Link>
        </p>
      ) : null}
    </div>
  );
}
