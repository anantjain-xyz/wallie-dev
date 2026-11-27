"use client";

import { useState, type Ref } from "react";

import {
  FILTER_CONTROL_CLASS,
  FILTER_SEARCH_CLASS,
  FilterSearch,
} from "@/components/ui/filter-controls";
import { cn } from "@/lib/utils";

export function useSessionsSearchDraft(appliedQuery: string) {
  const [search, setSearch] = useState({
    appliedQuery,
    draft: appliedQuery,
    submitted: null as string | null,
  });

  if (search.appliedQuery !== appliedQuery) {
    setSearch({
      appliedQuery,
      draft:
        search.submitted === appliedQuery.trim() && search.draft.trim() !== search.submitted
          ? search.draft
          : appliedQuery,
      submitted: null,
    });
  }

  return { search, setSearch };
}

export function SessionsSearchForm({
  accessibleLabel,
  appliedQuery,
  description,
  draft,
  inputId,
  inputRef,
  maxLength,
  onClear,
  onDraftChange,
  onSearch,
  pending,
  placeholder,
  showClear,
}: {
  accessibleLabel: string;
  appliedQuery: string;
  description: string;
  draft: string;
  inputId: string;
  inputRef: Ref<HTMLInputElement>;
  maxLength?: number;
  onClear: () => void;
  onDraftChange: (value: string) => void;
  onSearch: (value: string) => void;
  pending: boolean;
  placeholder: string;
  showClear: boolean;
}) {
  const value = draft.trim();
  const disabled = pending || value === appliedQuery.trim();
  const buttonClass = cn("ui-button shrink-0 px-2.5 md:px-3", FILTER_CONTROL_CLASS);

  return (
    <form
      aria-label="Search sessions"
      className={cn(FILTER_SEARCH_CLASS, "sm:flex sm:items-center sm:gap-2")}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSearch(value);
      }}
    >
      <label
        className="mb-1 block shrink-0 text-xs font-medium text-muted sm:mb-0"
        htmlFor={inputId}
      >
        Search
      </label>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <FilterSearch
          aria-label={accessibleLabel}
          autoComplete="off"
          className="[&::-webkit-search-cancel-button]:hidden"
          description={description}
          id={inputId}
          maxLength={maxLength}
          name="q"
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={placeholder}
          ref={inputRef}
          value={draft}
        />
        <button className={buttonClass} disabled={disabled} type="submit">
          Search
        </button>
        {showClear ? (
          <button className={buttonClass} onClick={onClear} type="button">
            Clear search
          </button>
        ) : null}
      </div>
    </form>
  );
}
