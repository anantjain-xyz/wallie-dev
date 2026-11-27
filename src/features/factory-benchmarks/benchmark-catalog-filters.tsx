"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField } from "@/components/ui/select";
import { useInsightFilters } from "@/features/insights/use-insight-filters";

export function BenchmarkCatalogFilters({
  path,
  clearHref,
  factoryId,
  name,
  purpose,
}: {
  path: string;
  clearHref: string;
  factoryId: string;
  name: string;
  purpose: string;
}) {
  const { filters, pending, update } = useInsightFilters(
    path,
    { factory: factoryId },
    { q: name, purpose },
  );
  const [search, setSearch] = useState({ applied: name, draft: name, submitted: name });
  if (search.applied !== name) {
    setSearch({
      applied: name,
      draft: search.submitted === name ? search.draft : name,
      submitted: name,
    });
  }
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    function resetDraft() {
      window.clearTimeout(timer.current);
      setSearch(({ applied }) => ({ applied, draft: applied, submitted: applied }));
    }
    window.addEventListener("popstate", resetDraft);
    return () => {
      window.removeEventListener("popstate", resetDraft);
      window.clearTimeout(timer.current);
    };
  }, []);

  function apply(draft: string, nextPurpose: string) {
    window.clearTimeout(timer.current);
    const q = draft.trim();
    if (q === filters.q && nextPurpose === filters.purpose) return;
    setSearch((current) => ({ ...current, submitted: q }));
    update({ q, purpose: nextPurpose });
  }

  return (
    <form
      action={path}
      aria-busy={pending}
      aria-label="Benchmark suites"
      className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.65fr)_minmax(6rem,auto)] sm:items-end sm:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        apply(search.draft, filters.purpose);
      }}
      role="search"
    >
      <input name="factory" type="hidden" value={factoryId} />
      <label className="block min-w-0 space-y-1.5">
        <span className="type-label">Suite name</span>
        <input
          autoComplete="off"
          className={`ui-input ${FILTER_CONTROL_CLASS}`}
          maxLength={120}
          name="q"
          onChange={(event) => {
            const draft = event.currentTarget.value;
            setSearch({ ...search, draft });
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => apply(draft, filters.purpose), 350);
          }}
          type="search"
          value={search.draft}
        />
      </label>
      <SelectField
        label="Purpose"
        labelClassName="type-label"
        name="purpose"
        onValueChange={(value) => apply(search.draft, value)}
        options={[
          { label: "Any purpose", value: "" },
          { label: "Regression", value: "regression" },
          { label: "Holdout", value: "holdout" },
        ]}
        triggerClassName={FILTER_CONTROL_CLASS}
        value={filters.purpose}
      />
      {search.draft || filters.q || filters.purpose ? (
        <Link
          className={`ui-button justify-self-start ${FILTER_CONTROL_CLASS}`}
          href={clearHref}
          onNavigate={(event) => {
            event.preventDefault();
            setSearch((current) => ({ ...current, draft: "", submitted: "" }));
            window.clearTimeout(timer.current);
            update({ q: "", purpose: "" });
          }}
          prefetch={false}
          scroll={false}
        >
          Clear filters
        </Link>
      ) : null}
    </form>
  );
}
