"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { FilterSelectTrigger } from "@/components/ui/filter-controls";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { SELECT_FIT_CONTENT_CLASS } from "@/components/ui/select-popup";
import {
  factorySwitchHref,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";

function factoryOptionLabel(factory: FactorySelectionOption) {
  return `${factory.name}${factory.status === "archived" ? " (archived)" : ""}`;
}

export function FactorySelector({
  allowAll = false,
  disabled,
  factories,
  onSwitch,
  resetParams,
  selectedValue,
}: {
  allowAll?: boolean;
  disabled?: boolean;
  factories: readonly FactorySelectionOption[];
  onSwitch?: (navigate: () => void, factoryLabel: string) => void;
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
      disabled={disabled}
      onValueChange={(value) => {
        if (value === effectiveValue || value === "unavailable") return;
        const href = factorySwitchHref(pathname, search.toString(), value, resetParams);
        const navigate = () => startTransition(() => router.push(href, { scroll: false }));
        if (onSwitch) {
          const factory = factories.find((option) => option.id === value);
          onSwitch(navigate, factory ? factoryOptionLabel(factory) : "All factories");
        } else navigate();
      }}
      value={effectiveValue}
    >
      <FilterSelectTrigger
        accessibleLabel="Factory"
        aria-busy={pending}
        className="max-w-full sm:max-w-52"
        data-value={effectiveValue}
      />
      <SelectContent align="end" className={SELECT_FIT_CONTENT_CLASS}>
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
