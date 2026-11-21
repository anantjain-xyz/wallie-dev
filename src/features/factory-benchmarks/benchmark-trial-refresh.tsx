"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";

export function BenchmarkTrialRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      aria-disabled={pending}
      className="ui-button aria-disabled:opacity-60"
      onClick={() => {
        if (!pending) startTransition(() => router.refresh());
      }}
      type="button"
    >
      <ActionButtonLabel
        idle="Refresh trial evidence"
        pending={pending}
        pendingLabel="Refreshing…"
      />
    </button>
  );
}
