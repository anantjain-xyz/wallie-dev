"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";

export function WorkspaceSettingsLoadError({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="ui-sheet flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p className="type-body text-danger" role="alert">
        Could not load {label}.
      </p>
      <button
        aria-label={`Retry loading ${label}`}
        className="ui-button min-h-9"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
        type="button"
      >
        <ActionButtonLabel idle="Retry" pending={pending} pendingLabel="Retrying…" />
      </button>
    </div>
  );
}
