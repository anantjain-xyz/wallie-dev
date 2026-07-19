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
  const [modalContainer, setModalContainer] = useState<HTMLDivElement | null>(null);

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
        ref={setModalContainer}
      >
        <ModalOverlayContainerProvider container={modalContainer}>
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
        </ModalOverlayContainerProvider>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return <footer className={cn("mt-6 flex justify-end gap-2", className)} {...props} />;
}

type DialogSideContentProps = DialogContentProps & {
  side?: "end" | "start";
};

/** Edge-anchored modal sheet (navigation drawers). Shares Dialog focus/portal behavior. */
export function DialogSideContent({
  children,
  className,
  description,
  dismissible = true,
  hideCloseButton = false,
  onEscapeKeyDown,
  onPointerDownOutside,
  side = "start",
  title,
  ...props
}: DialogSideContentProps) {
  const container = useOverlayContainer();
  const [modalContainer, setModalContainer] = useState<HTMLDivElement | null>(null);

  if (!container) return null;

  const descriptionProps = description ? {} : { "aria-describedby": undefined };

  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Overlay className="ui-overlay-backdrop" />
      <DialogPrimitive.Content
        className={cn(
          "ui-nav-sheet-content",
          side === "end" && "ui-nav-sheet-content-end",
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
          <header className="flex items-start justify-between gap-3 border-b border-border pb-4">
            <div className="min-w-0 space-y-1.5 pr-2">
              <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-sm leading-6 text-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            {!hideCloseButton && dismissible ? (
              <DialogPrimitive.Close
                aria-label="Close navigation"
                className="ui-icon-button shrink-0"
              >
                <XIcon className="h-3.5 w-3.5" />
              </DialogPrimitive.Close>
            ) : null}
          </header>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        </ModalOverlayContainerProvider>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
