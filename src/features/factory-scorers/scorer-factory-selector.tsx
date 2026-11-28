"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useContext, useRef, useTransition } from "react";
import { createPortal } from "react-dom";

import { workspaceFactorySwitchHref } from "@/components/app-shell/workspace-location";
import { WorkspaceScopeContext } from "@/components/app-shell/workspace-scope-context";
import { FilterSelectTrigger } from "@/components/ui/filter-controls";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import {
  factorySwitchHref,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import {
  HeaderFactoryMenu,
  WORKSPACE_FACTORY_TRIGGER_CLASS,
} from "@/features/factories/header-factory-menu";

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
  const trigger = useRef<HTMLButtonElement>(null);
  const [pending, startTransition] = useTransition();
  const draft = useScorerDraftGuard();
  const guarded = useContext(WorkspaceScopeContext)?.guardedPicker;
  if (guarded && !guarded.target) return null;

  function guardFromPicker(navigate: () => void) {
    if (draft) draft.guard(navigate, trigger.current ?? undefined);
    else navigate();
  }

  function selectValue(value: string) {
    if (value === selectedValue || value === "unavailable") return;
    const switchHref = guarded ? workspaceFactorySwitchHref : factorySwitchHref;
    const href = switchHref(pathname, search.toString(), value, ["revision", "preset", "q"]);
    guardFromPicker(() => startTransition(() => router.push(href, { scroll: false })));
  }

  const choices = factories.map((factory) => ({
    value: factory.id,
    label: `${scorerFactoryLabel(factory, factories)}${factory.isDefault ? " · Default" : ""}${factory.status === "archived" ? " · Archived" : ""}`,
  }));
  const selector = guarded?.manageFactoriesHref ? (
    <HeaderFactoryMenu
      choices={choices}
      label={choices.find(({ value }) => value === selectedValue)?.label ?? "Factory unavailable"}
      manageDisabled={draft?.busy}
      manageHref={guarded.manageFactoriesHref}
      onManage={guardFromPicker}
      onValueChange={selectValue}
      pending={pending}
      triggerRef={trigger}
      value={selectedValue}
    />
  ) : (
    <Select value={selectedValue} onValueChange={selectValue}>
      <FilterSelectTrigger
        accessibleLabel="Factory"
        aria-busy={pending}
        className={guarded ? WORKSPACE_FACTORY_TRIGGER_CLASS : "max-w-full sm:max-w-64"}
        ref={trigger}
      />
      <SelectContent
        align={guarded ? "start" : "end"}
        className="w-max min-w-[max(12rem,var(--radix-select-trigger-width))] max-w-[min(24rem,var(--radix-select-content-available-width,100vw),calc(100vw-(var(--overlay-gutter-inline)*2)))]"
      >
        {selectedValue === "unavailable" ? (
          <SelectItem disabled value="unavailable" wrap>
            Factory unavailable
          </SelectItem>
        ) : null}
        {choices.map(({ label, value }) => (
          <SelectItem key={value} value={value} wrap>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return guarded?.target ? createPortal(selector, guarded.target) : selector;
}
