"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useState, type ComponentProps, type ReactNode } from "react";

import { XIcon } from "@/components/shared/icons/x-icon";
import { ModalOverlayContainerProvider, useOverlayContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

type DialogContentProps = Omit<
  ComponentProps<typeof DialogPrimitive.Content>,
  "aria-describedby" | "aria-labelledby" | "title"
> & {
  bodyClassName?: string;
  closeLabel?: string;
  description?: ReactNode;
  dismissible?: boolean;
  hideCloseButton?: boolean;
  title: ReactNode;
  variant?: "navigation";
};

export function DialogContent({
  bodyClassName,
  children,
  className,
  closeLabel = "Close dialog",
  description,
  dismissible = true,
  hideCloseButton = false,
  onEscapeKeyDown,
  onPointerDownOutside,
  title,
  variant,
  ...props
}: DialogContentProps) {
  const container = useOverlayContainer();
  const [modalContainer, setModalContainer] = useState<HTMLDivElement | null>(null);

  if (!container) return null;

  const descriptionProps = description ? {} : { "aria-describedby": undefined };

  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Overlay className="ui-overlay-backdrop" />
      <DialogPrimitive.Content
        className={cn(
          variant === "navigation" ? "ui-nav-sheet-content" : "ui-dialog-content",
          className,
        )}
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
        ref={setModalContainer}
      >
        <ModalOverlayContainerProvider container={modalContainer}>
          <header className="shrink-0 space-y-1.5 pr-8">
            <DialogPrimitive.Title className="text-base font-semibold text-foreground">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-sm leading-6 text-muted">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </header>
          <div className={cn("mt-5", bodyClassName)}>{children}</div>
          {!hideCloseButton && dismissible ? (
            <DialogPrimitive.Close
              aria-label={closeLabel}
              className={cn(
                "ui-dialog-close",
                variant === "navigation" &&
                  "top-[max(0.25rem,env(safe-area-inset-top))] min-h-11 min-w-11",
              )}
            >
              <XIcon />
            </DialogPrimitive.Close>
          ) : null}
        </ModalOverlayContainerProvider>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return <footer className={cn("mt-6 flex justify-end gap-2", className)} {...props} />;
}
