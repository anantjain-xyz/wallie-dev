"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { FilterSelectTrigger } from "@/components/ui/filter-controls";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import {
  FACTORY_QUERY_PARAM,
  defaultsToAllFactories,
  factorySwitchHref,
  isFactoryAggregatePath,
  isFactoryOutcomePath,
  isFactorySelectorPath,
  isManagedFactoryPath,
  resolveAnalyticsFactory,
  resolveFactorySelection,
  resolveGovernanceFactorySelection,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import {
  workspaceBenchmarksPath,
  workspaceFailureGroupsPath,
  workspaceImprovementsPath,
} from "@/lib/routes";

function factoryOptionLabel(factory: FactorySelectionOption) {
  return `${factory.name}${factory.status === "archived" ? " (archived)" : ""}`;
}

export function FactorySelector({
  factories,
  workspaceSlug,
}: {
  factories: readonly FactorySelectionOption[];
  workspaceSlug: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (!isFactorySelectorPath(pathname, workspaceSlug)) return null;
  const allowAll = isFactoryAggregatePath(pathname, workspaceSlug);
  const values = search.getAll(FACTORY_QUERY_PARAM);
  const requested = values.length > 1 ? values : values[0];
  const managed = isManagedFactoryPath(pathname, workspaceSlug);
  const options = managed ? factories.filter(({ canManage }) => canManage) : factories;
  const selection = managed
    ? resolveGovernanceFactorySelection(factories, requested)
    : resolveFactorySelection(
        factories,
        requested ?? (defaultsToAllFactories(pathname, workspaceSlug) ? "all" : undefined),
        {
          useFirstVisible:
            pathname === workspaceBenchmarksPath(workspaceSlug) ||
            pathname === workspaceFailureGroupsPath(workspaceSlug) ||
            pathname === workspaceImprovementsPath(workspaceSlug),
        },
      );
  const selectedValue = isFactoryOutcomePath(pathname, workspaceSlug)
    ? (resolveAnalyticsFactory(factories, requested)?.id ?? "unavailable")
    : selection.kind === "factory"
      ? selection.factory.id
      : selection.kind === "all" && allowAll
        ? "all"
        : "unavailable";

  return (
    <Select
      onValueChange={(value) => {
        if (value === selectedValue || value === "unavailable") return;
        const href = factorySwitchHref(pathname, search.toString(), value);
        startTransition(() => router.push(href, { scroll: false }));
      }}
      value={selectedValue}
    >
      <FilterSelectTrigger
        accessibleLabel="Factory"
        aria-busy={pending}
        className="max-w-full sm:max-w-52"
        data-value={selectedValue}
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
        {allowAll ? (
          <SelectItem value="all" wrap>
            All factories
          </SelectItem>
        ) : null}
        {options.map((factory) => (
          <SelectItem key={factory.id} value={factory.id} wrap>
            {factoryOptionLabel(factory)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
