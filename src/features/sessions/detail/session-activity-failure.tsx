"use client";

import { useSessionRefresh } from "@/features/sessions/detail/session-refresh-context";

import { ActionButtonLabel } from "@/components/ui/action-feedback";

export function SessionActivityFailure() {
  const { refresh, pending } = useSessionRefresh();

  return (
    <div className="rounded-[6px] border border-border bg-control-muted p-4">
      <p className="text-sm font-medium text-foreground" role="status">
        Run activity is temporarily unavailable.
      </p>
      <p className="mt-1 text-sm leading-6 text-muted">
        Session review is still available. Try loading the run history again.
      </p>
      <button
        className="ui-button mt-3 min-h-11 sm:min-h-9"
        type="button"
        disabled={pending}
        onClick={refresh}
      >
        <ActionButtonLabel
          idle="Retry loading history"
          pending={pending}
          pendingLabel="Loading history…"
        />
      </button>
    </div>
  );
}
