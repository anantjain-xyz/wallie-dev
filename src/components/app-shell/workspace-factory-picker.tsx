"use client";

import type { WorkspaceScope } from "@/components/app-shell/workspace-location";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { FactorySelector, factoryOptionLabel } from "@/features/factories/factory-selector";

export function WorkspaceFactoryPicker({
  allowAll,
  choices,
  guardTarget,
  locked,
  manageFactoriesHref,
  resetParams,
  scope,
  visibleFactoryCount,
}: {
  allowAll: boolean;
  choices: readonly FactorySelectionOption[];
  guardTarget?: (target: HTMLDivElement | null) => void;
  locked: boolean;
  manageFactoriesHref?: string;
  resetParams?: readonly string[];
  scope: WorkspaceScope;
  visibleFactoryCount: number;
}) {
  if (scope.kind === "global" || scope.kind === "resource-pending") return null;
  if (
    scope.kind === "factory" &&
    visibleFactoryCount <= 1 &&
    scope.factory.status === "active" &&
    !(manageFactoriesHref && choices.length && (!locked || guardTarget))
  )
    return null;
  if (guardTarget) return <div className="min-w-0" ref={guardTarget} />;

  const value = scope.kind === "factory" ? scope.factory.id : scope.kind;
  const label =
    scope.kind === "factory"
      ? factoryOptionLabel(scope.factory)
      : scope.kind === "all"
        ? "All factories"
        : scope.kind === "pick"
          ? "Choose factory"
          : "Factory unavailable";

  if (locked || !choices.length) {
    return (
      <span
        className="min-w-0 max-w-36 truncate border-l border-border pl-2 text-[13px] font-medium text-muted sm:max-w-48"
        title={label}
      >
        {label}
      </span>
    );
  }

  return (
    <FactorySelector
      allowAll={allowAll}
      factories={choices}
      manageFactoriesHref={manageFactoriesHref}
      presentation="header"
      resetParams={resetParams}
      selectedValue={value}
    />
  );
}
