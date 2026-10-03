"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { useRef, type ComponentProps } from "react";

import { useOverlayContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

/** Defaults to non-modal so a portaled menu does not hideOthers/inert the app tree. */
export function DropdownMenu({
  modal = false,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root modal={modal} {...props} />;
}

export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

type DropdownMenuContentProps = Omit<
  ComponentProps<typeof DropdownMenuPrimitive.Content>,
  "aria-label" | "aria-labelledby"
> & {
  label: string;
};

export function DropdownMenuContent({
  align = "start",
  className,
  collisionPadding = 8,
  label,
  onFocus,
  sideOffset = 6,
  ...props
}: DropdownMenuContentProps) {
  const container = useOverlayContainer();
  const contentRef = useRef<HTMLDivElement>(null);

  if (!container) return null;

  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <DropdownMenuPrimitive.Content
        aria-label={label}
        aria-labelledby={undefined}
        align={align}
        className={cn("ui-menu-content", className)}
        collisionPadding={collisionPadding}
        onFocus={(event) => {
          onFocus?.(event);
          if (event.defaultPrevented || event.target !== event.currentTarget) return;

          contentRef.current
            ?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
            ?.focus();
        }}
        ref={contentRef}
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

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        "px-3 py-1.5 type-annotation font-semibold uppercase tracking-wide text-muted",
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
