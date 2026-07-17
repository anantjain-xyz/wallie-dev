"use client";

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { ComponentProps, ReactNode } from "react";

import { useOverlayContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogCancel = AlertDialogPrimitive.Cancel;
export const AlertDialogAction = AlertDialogPrimitive.Action;

type AlertDialogContentProps = Omit<
  ComponentProps<typeof AlertDialogPrimitive.Content>,
  "aria-describedby" | "aria-labelledby" | "title"
> & {
  description: ReactNode;
  title: ReactNode;
};

export function AlertDialogContent({
  children,
  className,
  description,
  title,
  ...props
}: AlertDialogContentProps) {
  const container = useOverlayContainer();

  if (!container) return null;

  return (
    <AlertDialogPrimitive.Portal container={container}>
      <AlertDialogPrimitive.Overlay className="ui-overlay-backdrop" />
      <AlertDialogPrimitive.Content className={cn("ui-dialog-content", className)} {...props}>
        <header className="space-y-1.5">
          <AlertDialogPrimitive.Title className="text-base font-semibold text-foreground">
            {title}
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="text-sm leading-6 text-muted">
            {description}
          </AlertDialogPrimitive.Description>
        </header>
        <div className="mt-5">{children}</div>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return <footer className={cn("mt-6 flex justify-end gap-2", className)} {...props} />;
}
