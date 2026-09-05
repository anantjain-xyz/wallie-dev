"use client";

import Link from "next/link";
import { useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";

export function PageFailure({
  notFound = false,
  reset,
  returnHref = "/",
  returnLabel = "Back to Wallie",
}: {
  notFound?: boolean;
  reset?: () => void;
  returnHref?: string;
  returnLabel?: string;
}) {
  const [pending, startRetry] = useTransition();
  return (
    <section className="mx-auto w-full max-w-xl px-6 py-16 sm:py-24" data-route-error>
      <p className="text-sm font-semibold text-accent">Wallie</p>
      <h1 className="mt-4 type-page-title">
        {notFound ? "This page isn’t available" : "This page couldn’t load"}
      </h1>
      <p className="mt-3 text-base leading-7 text-muted">
        {notFound
          ? "The link may be out of date, or you may not have access to this page."
          : "Try loading it again. If the problem continues, return to your workspace and try another page."}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {reset ? (
          <button
            className="ui-button-primary"
            disabled={pending}
            onClick={() => startRetry(reset)}
            type="button"
          >
            <ActionButtonLabel idle="Try again" pending={pending} pendingLabel="Trying again…" />
          </button>
        ) : null}
        <Link className="ui-button" href={returnHref}>
          {returnLabel}
        </Link>
      </div>
    </section>
  );
}
