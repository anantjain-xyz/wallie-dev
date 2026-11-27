"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useContext, useTransition, type Ref } from "react";
import { createPortal } from "react-dom";

import { workspaceFactorySwitchHref } from "@/components/app-shell/workspace-location";
import { WorkspaceScopeContext } from "@/components/app-shell/workspace-scope-context";
import { FilterSelectTrigger } from "@/components/ui/filter-controls";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { SELECT_FIT_CONTENT_CLASS } from "@/components/ui/select-popup";
import {
  factorySwitchHref,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";

export const WORKSPACE_FACTORY_TRIGGER_CLASS =
  "min-h-11 w-auto min-w-0 max-w-36 gap-1.5 border-transparent bg-transparent px-2 text-[13px] sm:min-h-9 sm:max-w-48";

export function factoryOptionLabel(factory: FactorySelectionOption) {
  return `${factory.name}${factory.status === "archived" ? " (archived)" : ""}`;
}

export function FactorySelector({
  allowAll = false,
  disabled,
  factories,
  onSwitch,
  presentation,
  resetParams,
  selectedValue,
  triggerRef,
}: {
  allowAll?: boolean;
  disabled?: boolean;
  factories: readonly FactorySelectionOption[];
  onSwitch?: (navigate: () => void, factoryLabel: string) => void;
  presentation?: "header";
  resetParams?: readonly string[];
  selectedValue: string;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
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

  const selector = (
    <Select
      disabled={disabled}
      onValueChange={(value) => {
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
        const navigate = () => startTransition(() => router.push(href, { scroll: false }));
        if (onSwitch) {
          const factory = factories.find((option) => option.id === value);
          onSwitch(navigate, factory ? factoryOptionLabel(factory) : "All factories");
        } else navigate();
      }}
      value={effectiveValue}
    >
      {inHeader ? (
        <SelectTrigger
          accessibleLabel="Factory"
          aria-busy={pending}
          className={WORKSPACE_FACTORY_TRIGGER_CLASS}
          id="workspace-factory-trigger"
          ref={triggerRef}
          title={
            selectedFactory ? factoryOptionLabel(selectedFactory) : (placeholder ?? "All factories")
          }
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
  return guarded?.target ? createPortal(selector, guarded.target) : selector;
}
