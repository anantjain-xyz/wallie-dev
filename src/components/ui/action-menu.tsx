"use client";

import { forwardRef, type ComponentProps, type ReactNode } from "react";

import { MoreIcon } from "@/components/shared/icons/more-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ActionMenuProps = {
  align?: ComponentProps<typeof DropdownMenuContent>["align"];
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  label: string;
};

/**
 * The single overflow-menu trigger used by feature rows and provider cards.
 * Its visible tooltip supplements the button's accessible name.
 */
export const ActionMenu = forwardRef<HTMLButtonElement, ActionMenuProps>(function ActionMenu(
  { align = "end", children, className, disabled = false, label },
  ref,
) {
  return (
    <DropdownMenu>
      <Tooltip content={label}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={label}
            className={cn("ui-icon-button", className)}
            disabled={disabled}
            ref={ref}
            type="button"
          >
            <MoreIcon className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align={align} label={label}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
