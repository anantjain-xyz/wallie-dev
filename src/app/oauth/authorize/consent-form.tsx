"use client";

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";

const selectionMessage = "Select at least one factory to allow access.";

export function ConsentForm({
  authorizationId,
  children,
  technicalDetails,
}: {
  authorizationId: string;
  children: ReactNode;
  technicalDetails?: { issuer: string; resource: string };
}) {
  const pendingRef = useRef(false);
  const firstError = useRef<HTMLParagraphElement>(null);
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [selectionError, setSelectionError] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    function resetPending(event: PageTransitionEvent) {
      if (!event.persisted) return;
      pendingRef.current = false;
      setPending(null);
    }
    window.addEventListener("pageshow", resetPending);
    return () => window.removeEventListener("pageshow", resetPending);
  }, []);

  useEffect(() => {
    if (selectionError) firstError.current?.focus();
  }, [selectionError]);

  function submit(event: FormEvent<HTMLFormElement>) {
    if (pendingRef.current) {
      event.preventDefault();
      return;
    }
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (!(submitter instanceof HTMLButtonElement)) return;
    if (submitter.value === "allow" && !new FormData(event.currentTarget).has("factoryIds")) {
      event.preventDefault();
      if (selectionError) firstError.current?.focus();
      setSelectionError(true);
      return;
    }
    pendingRef.current = true;
    setSelectionError(false);
    setPending(submitter.value === "allow" ? "allow" : "deny");
  }

  return (
    <form
      action="/oauth/authorize/decision"
      method="post"
      className="min-w-0 space-y-5"
      onSubmit={submit}
      onChange={() => setSelectionError(false)}
    >
      <input name="authorizationId" type="hidden" value={authorizationId} />
      {selectionError && (
        <p className="type-secondary text-danger" ref={firstError} role="alert" tabIndex={-1}>
          {selectionMessage}
        </p>
      )}
      {children}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          aria-disabled={!!pending}
          className="ui-button min-h-11"
          name="decision"
          type="submit"
          value="deny"
        >
          <ActionButtonLabel
            idle="Deny"
            pending={pending === "deny"}
            pendingLabel="Denying access…"
          />
        </button>
        <button
          aria-disabled={!!pending}
          className="ui-button-primary min-h-11"
          name="decision"
          type="submit"
          value="allow"
        >
          <ActionButtonLabel
            idle="Allow access"
            pending={pending === "allow"}
            pendingLabel="Allowing access…"
          />
        </button>
      </div>
      {technicalDetails && (
        <details className="border-t border-border pt-3">
          <summary className="type-label min-h-11 cursor-pointer content-center rounded-[6px] text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Technical details
          </summary>
          <dl className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
            <div>
              <dt className="type-label text-foreground">Issuer</dt>
              <dd className="type-secondary text-muted">{technicalDetails.issuer}</dd>
            </div>
            <div>
              <dt className="type-label text-foreground">Resource</dt>
              <dd className="type-secondary text-muted">{technicalDetails.resource}</dd>
            </div>
          </dl>
          <button
            className="ui-button mt-3 min-h-11"
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(technicalDetails.resource);
                setCopyStatus("Resource URL copied.");
              } catch {
                setCopyStatus(
                  "Couldn’t copy automatically. Select and copy the resource URL above.",
                );
              }
            }}
          >
            Copy resource URL
          </button>
          <p className="type-secondary mt-2 text-muted" role="status">
            {copyStatus}
          </p>
        </details>
      )}
      <span className="sr-only" role="status">
        {pending === "allow" ? "Allowing access…" : pending === "deny" ? "Denying access…" : ""}
      </span>
    </form>
  );
}
