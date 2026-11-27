"use client";

import Link from "next/link";

import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField } from "@/components/ui/select";
import { useInsightFilters } from "@/features/insights/use-insight-filters";
import { proposalReviewDispositionSchema } from "@/lib/factory-proposals/workbench-contracts";

import { improvementReviewStates } from "./improvement-status";

export function ImprovementFilters({
  path,
  factoryId,
  cohort,
  reviewState,
  clearHref,
}: {
  path: string;
  factoryId: string;
  cohort?: string;
  reviewState: string;
  clearHref: string;
}) {
  const { filters, pending, update } = useInsightFilters(
    path,
    { factory: factoryId, ...(cohort ? { cohort } : {}) },
    { reviewState },
  );

  return (
    <div
      aria-busy={pending}
      aria-label="Improvement filters"
      className="flex flex-wrap items-end gap-3 border-b border-border p-4 sm:px-5"
      role="group"
    >
      <SelectField
        className="w-52 max-w-full"
        label="Review state"
        labelClassName="type-label"
        name="reviewState"
        onValueChange={(value) => {
          if (value !== filters.reviewState) update({ reviewState: value });
        }}
        options={[
          { label: "All", value: "" },
          ...proposalReviewDispositionSchema.options.map((value) => ({
            label: improvementReviewStates[value].label,
            value,
          })),
        ]}
        triggerClassName={FILTER_CONTROL_CLASS}
        value={filters.reviewState}
        wrap
      />
      {filters.reviewState ? (
        <Link
          className={`ui-button ${FILTER_CONTROL_CLASS}`}
          href={clearHref}
          prefetch={false}
          scroll={false}
        >
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}
