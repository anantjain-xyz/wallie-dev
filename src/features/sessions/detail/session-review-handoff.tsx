"use client";

import Link from "next/link";
import { type MouseEvent, useLayoutEffect, useRef } from "react";
import { WallieMark } from "@/components/shared/wallie-mark";
import { allowsMotion } from "@/components/ui/motion";

export const SESSION_REVIEW_DECISION_ID = "session-review-decision";

export function SessionReviewHandoff({
  title,
  status,
  detail,
  confirmation,
  jumpLabel,
  recoveryHref,
  recoveryLabel = "Open current review",
}: {
  title?: string;
  status?: string;
  detail?: string;
  confirmation?: string;
  jumpLabel?: string;
  recoveryHref?: string;
  recoveryLabel?: string;
}) {
  const markRef = useRef<HTMLSpanElement>(null);
  const playedConfirmation = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!confirmation || playedConfirmation.current === confirmation) return;
    playedConfirmation.current = confirmation;
    const mark = markRef.current;
    if (!mark?.animate || !allowsMotion()) return;
    const animation = mark.animate(
      [
        { opacity: 0.55, transform: "translateY(2px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 120, easing: "ease-out" },
    );
    return () => animation.cancel();
  }, [confirmation]);

  function jumpToDecision(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(SESSION_REVIEW_DECISION_ID);
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start", behavior: "instant" });
  }

  if (!title) return null;
  return (
    <section
      aria-labelledby="session-review-handoff-heading"
      className="flex min-w-0 items-start gap-2.5 py-2"
    >
      <span ref={markRef} className="mt-0.5 shrink-0 text-accent">
        <WallieMark className="size-5" />
      </span>
      <div className="min-w-0">
        <div aria-live="polite" aria-atomic="true">
          <h2
            className="text-pretty text-base font-semibold [overflow-wrap:anywhere]"
            id="session-review-handoff-heading"
          >
            {title}
          </h2>
          {status ? <p className="mt-1 text-sm text-foreground">{status}</p> : null}
          {detail ? <p className="mt-1 text-sm text-muted">{detail}</p> : null}
        </div>
        {recoveryHref ? (
          <Link
            className="inline-flex min-h-11 items-center rounded-[4px] text-sm text-accent hover:underline focus-visible:outline-accent sm:min-h-8"
            href={recoveryHref}
          >
            {recoveryLabel}
          </Link>
        ) : jumpLabel ? (
          <a
            className="inline-flex min-h-11 items-center gap-1 rounded-[4px] text-sm text-muted hover:text-foreground hover:underline focus-visible:outline-accent sm:min-h-8"
            href={`#${SESSION_REVIEW_DECISION_ID}`}
            onClick={jumpToDecision}
          >
            {jumpLabel} <span aria-hidden="true">↓</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
