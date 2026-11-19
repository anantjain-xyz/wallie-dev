"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { ProjectionAction } from "@/features/factory-overview/projection-health-contracts";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";

const confirmations = {
  pause: "Analytics projection paused.",
  resume: "Analytics projection resumed.",
  rebuild: "Rebuild requested.",
} satisfies Record<ProjectionAction, string>;

export function ProjectionControls({
  factoryId,
  workspaceId,
  paused,
  rebuilding,
}: {
  factoryId: string;
  workspaceId: string;
  paused: boolean;
  rebuilding: boolean;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const command = useApiAction<unknown, [ProjectionAction]>({
    call: (action) =>
      fetch(`/api/workspaces/${workspaceId}/factories/${factoryId}/projection-control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }),
    errorText: "Could not update the analytics projection.",
    successText: (_, [action]) => confirmations[action],
    setFlashMessage: setMessage,
    onSuccess: () => startRefresh(() => router.refresh()),
  });
  const busy = command.isBusy || refreshing;
  function run(action: ProjectionAction) {
    setMessage(null);
    void command.run(action);
  }

  return (
    <div className="space-y-2 border-t border-border px-4 py-3 sm:px-5">
      <div className="flex flex-wrap gap-2" aria-busy={busy}>
        <button
          className="ui-button min-h-9 px-3 py-1.5 text-sm"
          disabled={busy}
          onClick={() => run(paused ? "resume" : "pause")}
          type="button"
        >
          {paused ? "Resume projection" : "Pause projection"}
        </button>
        <button
          className="ui-button min-h-9 px-3 py-1.5 text-sm"
          disabled={busy || rebuilding}
          onClick={() => run("rebuild")}
          type="button"
        >
          Rebuild projection
        </button>
      </div>
      <InlineActionMessage message={message} />
    </div>
  );
}
