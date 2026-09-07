import { useId, type ComponentProps } from "react";

import { SearchIcon } from "@/components/shared/icons/search-icon";
import { XIcon } from "@/components/shared/icons/x-icon";
import { SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Shared toolbar geometry; ordinary form fields elsewhere keep their own sizing. */
export const FILTER_CONTROL_CLASS = "h-11 min-h-0 text-base md:h-9 md:text-[13px]";
export const FILTER_BAR_CLASS = "flex flex-wrap items-center gap-2 border-y border-border py-3";
export const FILTER_SEARCH_CLASS = "min-w-0 flex-1 basis-full sm:basis-60";

export function FilterSearch({
  className,
  description,
  ...props
}: ComponentProps<"input"> & { description: string }) {
  const descriptionId = useId();
  return (
    <div className={cn("relative", FILTER_SEARCH_CLASS)}>
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
      <input
        aria-describedby={descriptionId}
        className={cn("ui-input py-1.5 pl-8 pr-3", FILTER_CONTROL_CLASS, className)}
        placeholder="Search sessions…"
        type="search"
        {...props}
      />
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </div>
  );
}

export function FilterSelectTrigger({ className, ...props }: ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn("w-auto max-w-full gap-1.5 px-2.5", FILTER_CONTROL_CLASS, className)}
      {...props}
    />
  );
}

export function ClearFilters({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn("ui-button shrink-0 gap-1 px-2.5", FILTER_CONTROL_CLASS, className)}
      {...props}
    >
      <XIcon className="h-3.5 w-3.5" />
      <span>Clear</span>
    </button>
  );
}
