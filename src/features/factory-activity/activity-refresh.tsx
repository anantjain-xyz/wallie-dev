"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { TimeDisplay } from "@/components/shared/time-display";

const STALE_AFTER_MS = 5 * 60 * 1000;

export function ActivityRefresh({ capturedAt }: { capturedAt: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [staleSnapshot, setStaleSnapshot] = useState<string | null>(null);

  useEffect(() => {
    if (capturedAt === null) return;
    const delay = Math.max(0, Date.parse(capturedAt) + STALE_AFTER_MS - Date.now());
    const timeout = window.setTimeout(() => setStaleSnapshot(capturedAt), delay);
    return () => window.clearTimeout(timeout);
  }, [capturedAt]);

  const stale = capturedAt !== null && (capturedAt === staleSnapshot || pending);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p aria-live="polite" className={stale ? "text-xs text-warning" : "text-xs text-muted"}>
        {stale ? "Activity snapshot is stale. " : null}
        {capturedAt ? (
          <>
            Updated <TimeDisplay initialNow={capturedAt} value={capturedAt} variant="relative" />
          </>
        ) : null}
      </p>
      <button
        className="ui-button"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
        type="button"
      >
        <ActionButtonLabel idle="Refresh" pending={pending} pendingLabel="Refreshing…" />
      </button>
    </div>
  );
}
