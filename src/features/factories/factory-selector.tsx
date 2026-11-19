"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import {
  FACTORY_QUERY_PARAM,
  factorySwitchHref,
  isFactoryAggregatePath,
  isFactorySelectorPath,
  resolveFactorySelection,
  resolveGovernanceFactorySelection,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";

import { workspaceActivityPath, workspaceGovernancePath } from "@/lib/routes";

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
  const governance = pathname === workspaceGovernancePath(workspaceSlug);
  const options = governance ? factories.filter(({ canManage }) => canManage) : factories;
  const selection = governance
    ? resolveGovernanceFactorySelection(factories, requested)
    : resolveFactorySelection(
        factories,
        requested ?? (pathname === workspaceActivityPath(workspaceSlug) ? "all" : undefined),
      );
  const selectedValue =
    selection.kind === "factory"
      ? selection.factory.id
      : selection.kind === "all" && allowAll
        ? "all"
        : "unavailable";

  return (
    <label className="min-w-0">
      <span className="sr-only">Factory</span>
      <select
        aria-busy={pending}
        className="ui-input h-9 max-w-36 truncate pr-2 text-xs sm:max-w-52"
        onChange={(event) => {
          const value = event.currentTarget.value;
          const href = factorySwitchHref(pathname, search.toString(), value);
          startTransition(() => router.push(href, { scroll: false }));
        }}
        value={selectedValue}
      >
        {selectedValue === "unavailable" ? (
          <option disabled value="unavailable">
            Factory unavailable
          </option>
        ) : null}
        {allowAll && <option value="all">All factories</option>}
        {options.map((factory) => (
          <option key={factory.id} value={factory.id}>
            {factory.name}
            {factory.status === "archived" ? " (archived)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
