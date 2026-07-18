"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, ReactNode } from "react";

import { XIcon } from "@/components/shared/icons";
import { useOverlayContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

type DialogContentProps = Omit<
  ComponentProps<typeof DialogPrimitive.Content>,
  "aria-describedby" | "aria-labelledby" | "title"
> & {
  description?: ReactNode;
  dismissible?: boolean;
  hideCloseButton?: boolean;
  title: ReactNode;
};

export function DialogContent({
  children,
  className,
  description,
  dismissible = true,
  hideCloseButton = false,
  onEscapeKeyDown,
  onPointerDownOutside,
  title,
  ...props
}: DialogContentProps) {
  const container = useOverlayContainer();

  if (!container) return null;

  const descriptionProps = description ? {} : { "aria-describedby": undefined };

  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Overlay className="ui-overlay-backdrop" />
      <DialogPrimitive.Content
        className={cn("ui-dialog-content", className)}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (!dismissible) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event);
          if (!dismissible) event.preventDefault();
        }}
        {...descriptionProps}
        {...props}
      >
        <header className="space-y-1.5 pr-8">
          <DialogPrimitive.Title className="text-base font-semibold text-foreground">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="text-sm leading-6 text-muted">
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </header>
        <div className="mt-5">{children}</div>
        {!hideCloseButton && dismissible ? (
          <DialogPrimitive.Close aria-label="Close dialog" className="ui-dialog-close">
            <XIcon />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return <footer className={cn("mt-6 flex justify-end gap-2", className)} {...props} />;
}
