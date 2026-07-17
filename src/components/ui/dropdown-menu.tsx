"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";

import { CheckIcon, ChevronDownIcon } from "@/components/shared/icons";
import { useOverlayContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;

type DropdownMenuContentProps = ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  label: string;
};

export function DropdownMenuContent({
  align = "start",
  className,
  collisionPadding = 8,
  label,
  sideOffset = 6,
  ...props
}: DropdownMenuContentProps) {
  const container = useOverlayContainer();

  if (!container) return null;

  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <DropdownMenuPrimitive.Content
        aria-label={label}
        align={align}
        className={cn("ui-menu-content", className)}
        collisionPadding={collisionPadding}
        sideOffset={sideOffset}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={cn("ui-menu-item", className)} {...props} />;
}

export function DropdownMenuCheckboxItem({
  children,
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn("ui-menu-item pl-8", className)} {...props}>
      <DropdownMenuPrimitive.ItemIndicator className="absolute left-2.5">
        <CheckIcon />
      </DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  children,
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn("ui-menu-item pl-8", className)} {...props}>
      <DropdownMenuPrimitive.ItemIndicator className="absolute left-3">
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      </DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />
  );
}

export const DropdownMenuSubTrigger = DropdownMenuPrimitive.SubTrigger;

export function DropdownMenuSubContent({
  className,
  collisionPadding = 8,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      className={cn("ui-menu-content", className)}
      collisionPadding={collisionPadding}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export function DropdownMenuSubIndicator() {
  return <ChevronDownIcon className="ml-auto -rotate-90" />;
}
