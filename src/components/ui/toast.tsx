"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { XIcon } from "@/components/shared/icons";
import { useAnnouncementContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

export type ToastPriority = "polite" | "assertive";
export type ToastTone = "neutral" | "success" | "danger";

export type ToastInput = {
  description?: ReactNode;
  duration?: number;
  priority?: ToastPriority;
  title: ReactNode;
  tone?: ToastTone;
};

type ToastRecord = ToastInput & { id: number };
type ToastContextValue = { pushToast: (toast: ToastInput) => number };

const ToastContext = createContext<ToastContextValue | null>(null);
let toastId = 0;

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) throw new Error("useToast must be used within OverlayProvider");

  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const container = useAnnouncementContainer();
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const pushToast = useCallback((toast: ToastInput) => {
    const id = ++toastId;
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  }, []);
  const context = useMemo(() => ({ pushToast }), [pushToast]);

  return (
    <ToastContext value={context}>
      <ToastPrimitive.Provider duration={5000} swipeDirection="right">
        {children}
        {container
          ? createPortal(
              <>
                {toasts.map((toast) => (
                  <ToastPrimitive.Root
                    className={cn("ui-toast", `ui-toast-${toast.tone ?? "neutral"}`)}
                    duration={toast.duration}
                    key={toast.id}
                    onOpenChange={(open) => {
                      if (!open) {
                        setToasts((current) => current.filter((item) => item.id !== toast.id));
                      }
                    }}
                    type={toast.priority === "assertive" ? "foreground" : "background"}
                  >
                    <div className="min-w-0">
                      <ToastPrimitive.Title className="text-sm font-semibold text-foreground">
                        {toast.title}
                      </ToastPrimitive.Title>
                      {toast.description ? (
                        <ToastPrimitive.Description className="mt-1 text-sm leading-5 text-muted">
                          {toast.description}
                        </ToastPrimitive.Description>
                      ) : null}
                    </div>
                    <ToastPrimitive.Close
                      aria-label="Dismiss notification"
                      className="ui-toast-close"
                    >
                      <XIcon />
                    </ToastPrimitive.Close>
                  </ToastPrimitive.Root>
                ))}
                <ToastPrimitive.Viewport aria-label="Notifications" className="ui-toast-viewport" />
              </>,
              container,
            )
          : null}
      </ToastPrimitive.Provider>
    </ToastContext>
  );
}
