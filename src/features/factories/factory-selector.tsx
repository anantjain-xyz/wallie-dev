"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { FilterSelectTrigger } from "@/components/ui/filter-controls";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import {
  factorySwitchHref,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";

function factoryOptionLabel(factory: FactorySelectionOption) {
  return `${factory.name}${factory.status === "archived" ? " (archived)" : ""}`;
}

export function FactorySelector({
  allowAll = false,
  factories,
  resetParams,
  selectedValue,
}: {
  allowAll?: boolean;
  factories: readonly FactorySelectionOption[];
  resetParams?: readonly string[];
  selectedValue: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const [pending, startTransition] = useTransition();

  const effectiveValue =
    selectedValue === "all"
      ? allowAll
        ? "all"
        : "unavailable"
      : factories.some((factory) => factory.id === selectedValue)
        ? selectedValue
        : "unavailable";

  return (
    <Select
      onValueChange={(value) => {
        if (value === effectiveValue || value === "unavailable") return;
        const href = factorySwitchHref(pathname, search.toString(), value, resetParams);
        startTransition(() => router.push(href, { scroll: false }));
      }}
      value={effectiveValue}
    >
      <FilterSelectTrigger
        accessibleLabel="Factory"
        aria-busy={pending}
        className="max-w-full sm:max-w-52"
        data-value={effectiveValue}
      />
      <SelectContent
        align="end"
        className="w-max min-w-[max(12rem,var(--radix-select-trigger-width))] max-w-[min(24rem,var(--radix-select-content-available-width,100vw),calc(100vw-(var(--overlay-gutter-inline)*2)))]"
      >
        {effectiveValue === "unavailable" ? (
          <SelectItem disabled value="unavailable" wrap>
            Factory unavailable
          </SelectItem>
        ) : null}
        {allowAll ? (
          <SelectItem value="all" wrap>
            All factories
          </SelectItem>
        ) : null}
        {factories.map((factory) => (
          <SelectItem key={factory.id} value={factory.id} wrap>
            {factoryOptionLabel(factory)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
