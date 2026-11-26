"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useTransition } from "react";

import { FilterSelectTrigger } from "@/components/ui/filter-controls";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import {
  factorySwitchHref,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";

import { useScorerDraftGuard } from "./scorer-draft-guard";
import { scorerFactoryLabel } from "./scorer-factory-label";

export function ScorerFactorySelector({
  factories,
  selectedValue,
}: {
  factories: readonly FactorySelectionOption[];
  selectedValue: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const triggerId = useId();
  const [pending, startTransition] = useTransition();
  const draft = useScorerDraftGuard();

  return (
    <Select
      value={selectedValue}
      onValueChange={(value) => {
        if (value === selectedValue || value === "unavailable") return;
        const href = factorySwitchHref(pathname, search.toString(), value, [
          "revision",
          "preset",
          "q",
        ]);
        const navigate = () => startTransition(() => router.push(href, { scroll: false }));
        if (draft) draft.guard(navigate, document.getElementById(triggerId) ?? undefined);
        else navigate();
      }}
    >
      <FilterSelectTrigger
        accessibleLabel="Factory"
        aria-busy={pending}
        className="max-w-full sm:max-w-64"
        id={triggerId}
      />
      <SelectContent
        align="end"
        className="w-max min-w-[max(12rem,var(--radix-select-trigger-width))] max-w-[min(24rem,var(--radix-select-content-available-width,100vw),calc(100vw-(var(--overlay-gutter-inline)*2)))]"
      >
        {selectedValue === "unavailable" ? (
          <SelectItem disabled value="unavailable" wrap>
            Factory unavailable
          </SelectItem>
        ) : null}
        {factories.map((factory) => (
          <SelectItem key={factory.id} value={factory.id} wrap>
            {scorerFactoryLabel(factory, factories)}
            {factory.isDefault ? " · Default" : ""}
            {factory.status === "archived" ? " · Archived" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
