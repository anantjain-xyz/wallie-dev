"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

type AuthFormProps = {
  action: string;
  ariaLabelledBy?: string;
  children: ReactNode;
  className?: string;
  feedback?: {
    kind: "error" | "status";
    message: string;
  } | null;
  method?: "post";
  pendingLabel: string;
  submitClassName?: string;
  submitLabel: string;
};

export function AuthForm({
  action,
  ariaLabelledBy,
  children,
  className,
  feedback,
  method = "post",
  pendingLabel,
  submitClassName = "ui-button-primary min-h-11 w-full",
  submitLabel,
}: AuthFormProps) {
  const [pending, setPending] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const pendingStatusId = useId();

  useEffect(() => {
    if (feedback?.kind === "error") {
      feedbackRef.current?.focus();
    }
  }, [feedback]);

  return (
    <form
      action={action}
      method={method}
      className={className}
      aria-busy={pending}
      aria-labelledby={ariaLabelledBy}
      onSubmit={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }

        setPending(true);
      }}
    >
      {feedback ? (
        <div
          ref={feedbackRef}
          role={feedback.kind === "error" ? "alert" : "status"}
          tabIndex={feedback.kind === "error" ? -1 : undefined}
          className={
            feedback.kind === "error"
              ? "rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2.5 text-sm leading-5 text-danger outline-none focus-visible:ring-2 focus-visible:ring-danger/30"
              : "rounded-[6px] border border-border bg-accent-soft px-3 py-2.5 text-sm leading-5 text-foreground"
          }
        >
          {feedback.message}
        </div>
      ) : null}

      <fieldset className="contents">
        {children}
        <button
          type="submit"
          className={submitClassName}
          aria-describedby={pendingStatusId}
          disabled={pending}
        >
          {pending ? pendingLabel : submitLabel}
        </button>
      </fieldset>
      <span id={pendingStatusId} role="status" aria-live="polite" className="sr-only">
        {pending ? pendingLabel : ""}
      </span>
    </form>
  );
}
