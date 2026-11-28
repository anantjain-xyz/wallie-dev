"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useContext, useTransition, type RefObject } from "react";
import { createPortal } from "react-dom";

import { workspaceFactorySwitchHref } from "@/components/app-shell/workspace-location";
import { WorkspaceScopeContext } from "@/components/app-shell/workspace-scope-context";
import { LayersIcon } from "@/components/shared/icons/layers-icon";
import { FilterSelectTrigger } from "@/components/ui/filter-controls";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { SELECT_FIT_CONTENT_CLASS } from "@/components/ui/select-popup";
import {
  factorySwitchHref,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import {
  HeaderFactoryMenu,
  WORKSPACE_FACTORY_TRIGGER_CLASS,
} from "@/features/factories/header-factory-menu";

export function factoryOptionLabel(factory: FactorySelectionOption) {
  return `${factory.name}${factory.status === "archived" ? " (archived)" : ""}`;
}

export function FactorySelector({
  allowAll = false,
  disabled,
  factories,
  manageDisabled,
  manageFactoriesHref,
  onManage,
  onSwitch,
  presentation,
  resetParams,
  selectedValue,
  triggerRef,
}: {
  allowAll?: boolean;
  disabled?: boolean;
  factories: readonly FactorySelectionOption[];
  manageDisabled?: boolean;
  manageFactoriesHref?: string;
  onManage?: (navigate: () => void) => void;
  onSwitch?: (navigate: () => void, factoryLabel: string) => void;
  presentation?: "header";
  resetParams?: readonly string[];
  selectedValue: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const { startNavigation } = useOptionalRouteProgress();
  const [pending, startTransition] = useTransition();
  const chrome = useContext(WorkspaceScopeContext);
  const guarded = onSwitch ? chrome?.guardedPicker : null;
  const inHeader = presentation === "header" || Boolean(guarded);
  if ((!inHeader && chrome?.ownsPicker && !onSwitch && !disabled) || (guarded && !guarded.target))
    return null;

  const selectedFactory = factories.find(({ id }) => id === selectedValue);
  const effectiveValue =
    selectedFactory ||
    (selectedValue === "all" && allowAll) ||
    (inHeader && selectedValue === "pick")
      ? selectedValue
      : "unavailable";
  const placeholder =
    effectiveValue === "pick"
      ? "Choose factory"
      : effectiveValue === "unavailable"
        ? "Factory unavailable"
        : null;
  const label = selectedFactory
    ? factoryOptionLabel(selectedFactory)
    : (placeholder ?? "All factories");
  const manageHref =
    presentation === "header"
      ? manageFactoriesHref
      : onManage
        ? guarded?.manageFactoriesHref
        : undefined;

  function selectValue(value: string) {
    if (value === effectiveValue || value === "unavailable") return;
    const href = inHeader
      ? workspaceFactorySwitchHref(
          pathname,
          search.toString(),
          value,
          resetParams,
          window.location.hash,
        )
      : factorySwitchHref(pathname, search.toString(), value, resetParams);
    const navigate = () => {
      if (presentation === "header") startNavigation(href);
      startTransition(() => router.push(href, { scroll: false }));
    };
    if (onSwitch) {
      const factory = factories.find((option) => option.id === value);
      onSwitch(navigate, factory ? factoryOptionLabel(factory) : "All factories");
    } else navigate();
  }

  const selector = manageHref ? (
    <HeaderFactoryMenu
      choices={[
        ...(allowAll ? [{ value: "all", label: "All factories" }] : []),
        ...factories.map((factory) => ({ value: factory.id, label: factoryOptionLabel(factory) })),
      ]}
      disabled={disabled}
      label={label}
      manageDisabled={manageDisabled}
      manageHref={manageHref}
      onManage={onManage}
      onValueChange={selectValue}
      pending={pending}
      triggerRef={triggerRef}
      value={effectiveValue}
    />
  ) : (
    <Select disabled={disabled} onValueChange={selectValue} value={effectiveValue}>
      {inHeader ? (
        <SelectTrigger
          accessibleLabel="Factory"
          aria-busy={pending}
          className={WORKSPACE_FACTORY_TRIGGER_CLASS}
          id="workspace-factory-trigger"
          ref={triggerRef}
          title={label}
        />
      ) : (
        <FilterSelectTrigger
          accessibleLabel="Factory"
          aria-busy={pending}
          className="max-w-full sm:max-w-52"
          data-value={effectiveValue}
          ref={triggerRef}
        />
      )}
      <SelectContent align={inHeader ? "start" : "end"} className={SELECT_FIT_CONTENT_CLASS}>
        {placeholder ? (
          <SelectItem disabled value={effectiveValue} wrap>
            {placeholder}
          </SelectItem>
        ) : null}
        {allowAll ? (
          <SelectItem
            leading={
              inHeader ? <LayersIcon className="order-last mt-0.5 ml-auto text-muted" /> : undefined
            }
            value="all"
            wrap
          >
            All factories
          </SelectItem>
        ) : null}
        {allowAll && inHeader && factories.length > 0 ? (
          <div aria-hidden="true" className="my-1 h-px bg-border" />
        ) : null}
        {factories.map((factory) => (
          <SelectItem key={factory.id} value={factory.id} wrap>
            {factoryOptionLabel(factory)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return guarded?.target ? createPortal(selector, guarded.target) : selector;
}
