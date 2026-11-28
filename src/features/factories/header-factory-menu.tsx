"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type RefObject } from "react";

import { CheckIcon } from "@/components/shared/icons/check-icon";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { scrollSelectOptionIntoView } from "@/components/ui/select-popup";
import { cn } from "@/lib/utils";

export const WORKSPACE_FACTORY_TRIGGER_CLASS =
  "min-h-11 w-auto min-w-0 max-w-36 gap-1.5 border-transparent bg-transparent px-2 text-[13px] sm:min-h-9 sm:max-w-48";

export function HeaderFactoryMenu({
  choices,
  disabled,
  label,
  manageDisabled,
  manageHref,
  onManage,
  onValueChange,
  pending,
  triggerRef,
  value,
}: {
  choices: readonly { label: string; value: string }[];
  disabled?: boolean;
  label: string;
  manageDisabled?: boolean;
  manageHref: string;
  onManage?: (navigate: () => void) => void;
  onValueChange: (value: string) => void;
  pending: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  value: string;
}) {
  const router = useRouter();
  const { startNavigation } = useOptionalRouteProgress();
  const labelId = useId();
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? ownTrigger;
  const skipRestore = useRef(false);
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);

  return (
    <DropdownMenu
      open={open && !disabled}
      onOpenChange={(next) => {
        if (next) skipRestore.current = false;
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          aria-busy={pending}
          aria-describedby={labelId}
          aria-label="Factory"
          className={cn(
            "ui-select-trigger touch-manipulation [-webkit-tap-highlight-color:transparent]",
            WORKSPACE_FACTORY_TRIGGER_CLASS,
          )}
          data-value={value}
          id="workspace-factory-trigger"
          ref={trigger}
          title={label}
          type="button"
        >
          <span className="min-w-0 truncate" id={labelId}>
            {label}
          </span>
          <ChevronDownIcon className="text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-max min-w-[max(12rem,var(--radix-dropdown-menu-trigger-width))] max-w-[min(24rem,var(--radix-dropdown-menu-content-available-width),calc(100vw-16px))]"
        label="Factory"
        onCloseAutoFocus={(event) => {
          if (skipRestore.current) event.preventDefault();
        }}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          const menu = event.currentTarget;
          const choice =
            menu.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
            menu.querySelector<HTMLElement>('[role="menuitemradio"]');
          if (!choice) return;
          event.preventDefault();
          choice.focus({ preventScroll: true });
          scrollSelectOptionIntoView(menu, choice);
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== "Tab") return;
          event.stopPropagation();
          skipRestore.current = true;
          trigger.current?.focus();
          setOpen(false);
        }}
      >
        {choices.length > 0 ? (
          <>
            <div aria-label="Factory scope" role="group">
              {choices.map((choice) => (
                <DropdownMenuItem
                  aria-checked={choice.value === value}
                  className="items-start px-2.5"
                  data-value={choice.value}
                  key={choice.value}
                  onSelect={() => onValueChange(choice.value)}
                  role="menuitemradio"
                >
                  <CheckIcon
                    className={cn("mt-0.5 shrink-0", choice.value !== value && "invisible")}
                  />
                  <span className="min-w-0 break-words">{choice.label}</span>
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {manageDisabled ? (
          <DropdownMenuItem className="pl-8" disabled>
            Manage factories
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem asChild className="pl-8">
            <Link
              data-guarded-factory-link={onManage ? "" : undefined}
              href={manageHref}
              onNavigate={(event) => {
                if (!onManage) return;
                event.preventDefault();
                skipRestore.current = true;
                onManage(() => {
                  startNavigation(manageHref);
                  router.push(manageHref);
                });
              }}
              prefetch={false}
            >
              Manage factories
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
