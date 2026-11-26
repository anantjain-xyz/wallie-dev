"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";

export function PageFailure({
  actions,
  description,
  notFound = false,
  reset,
  returnHref = "/",
  returnLabel = "Back to Wallie",
}: {
  actions?: ReactNode;
  description?: string;
  notFound?: boolean;
  reset?: () => void;
  returnHref?: string;
  returnLabel?: string;
}) {
  const [pending, startRetry] = useTransition();
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const canRetry = Boolean(reset);
  useEffect(() => {
    if (canRetry) heading.current?.focus();
  }, [canRetry]);

  return (
    <section className="mx-auto w-full max-w-xl px-6 py-16 sm:py-24" data-route-error>
      <p className="text-sm font-semibold text-accent">Wallie</p>
      <h1 ref={heading} tabIndex={canRetry ? -1 : undefined} className="mt-4 type-page-title">
        {notFound ? "This page isn’t available" : "This page couldn’t load"}
      </h1>
      <p className="mt-3 text-base leading-7 text-muted">
        {description ??
          (notFound
            ? "The link may be outdated or access may be restricted."
            : "Try loading the page again.")}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {reset ? (
          <button
            className="ui-button-primary"
            disabled={pending}
            onClick={() =>
              startRetry(() => {
                router.refresh();
                reset();
              })
            }
            type="button"
          >
            <ActionButtonLabel idle="Try again" pending={pending} pendingLabel="Trying again…" />
          </button>
        ) : null}
        <Link className="ui-button" href={returnHref}>
          {returnLabel}
        </Link>
        {actions}
      </div>
      <span role="status" className="sr-only">
        {pending ? "Trying again…" : ""}
      </span>
    </section>
  );
}
