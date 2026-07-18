"use client";

import type { ReactNode } from "react";

import { Spinner } from "@/components/shared/spinner";
import { cn } from "@/lib/utils";

export type ActionStatus = "idle" | "pending" | "success" | "error";

export type ActionFeedback = {
  message: string | null;
  status: ActionStatus;
};

export const idleActionFeedback: ActionFeedback = {
  message: null,
  status: "idle",
};

/**
 * Keeps both the idle and pending labels in layout so a control never changes
 * width when its request starts. Pending text remains the primary signal; the
 * spinner is supplementary and may stop moving under reduced motion.
 */
export function ActionButtonLabel({
  className,
  idle,
  pending,
  pendingLabel,
}: {
  className?: string;
  idle: ReactNode;
  pending: boolean;
  pendingLabel: ReactNode;
}) {
  return (
    <span className={cn("grid items-center", className)} data-action-label>
      <span
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5"
      >
        <Spinner className="animate-none" />
        {pendingLabel}
      </span>
      <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">
        {pending ? (
          <>
            <Spinner />
            <span>{pendingLabel}</span>
          </>
        ) : (
          idle
        )}
      </span>
    </span>
  );
}
