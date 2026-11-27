"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { ProjectionAction } from "@/features/factory-overview/projection-health-contracts";
import type { FlashMessage } from "@/features/settings/settings-types";
import { toneClass } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";

const confirmations = {
  pause: "Analytics projection paused.",
  resume: "Analytics projection resumed.",
  rebuild: "Rebuild requested.",
} satisfies Record<ProjectionAction, string>;
const actionLabels = {
  pause: "Pause projection",
  resume: "Resume projection",
  rebuild: "Rebuild projection",
} satisfies Record<ProjectionAction, string>;
const actionDescriptions = {
  pause: "Flow and delivery reports stop updating. Sessions and outcome capture continue.",
  resume: "Reporting updates resume. A queued rebuild can start when reporting resumes.",
  rebuild:
    "Queue a rebuild of flow and delivery reports from captured outcomes. If reporting is paused, the rebuild waits until it resumes.",
} satisfies Record<ProjectionAction, string>;
const pendingLabels = {
  pause: "Pausing…",
  resume: "Resuming…",
  rebuild: "Requesting rebuild…",
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
  const [actionInFlight, setActionInFlight] = useState<ProjectionAction | null>(null);
  const command = useApiAction<unknown, [ProjectionAction]>({
    call: (action) => {
      setActionInFlight(action);
      setMessage(null);
      return fetch(`/api/workspaces/${workspaceId}/factories/${factoryId}/projection-control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    },
    errorText: "Could not update the analytics projection.",
    successText: (_, [action]) => confirmations[action],
    setFlashMessage: setMessage,
    onSuccess: () => startRefresh(() => router.refresh()),
  });
  const busy = command.isBusy || refreshing;
  const activeAction = busy ? actionInFlight : null;
  const activeToggleAction =
    activeAction === "pause" || activeAction === "resume" ? activeAction : null;
  const toggleAction = paused ? "resume" : "pause";
  const result = busy ? null : message;
  function run(action: ProjectionAction) {
    if (busy || (rebuilding && action === "rebuild")) return;
    void command.run(action);
  }

  return (
    <div className="space-y-2 border-t border-border px-4 py-3 sm:px-5">
      <div className="flex flex-wrap gap-2" aria-busy={busy}>
        {([toggleAction, "rebuild"] as const).map((action) => {
          const isRebuild = action === "rebuild";
          const disabled = busy || (isRebuild && rebuilding);
          const pending = isRebuild
            ? activeAction === "rebuild"
              ? "rebuild"
              : null
            : activeToggleAction;
          return (
            <AlertDialog key={isRebuild ? "rebuild" : "toggle"}>
              <AlertDialogTrigger asChild>
                <button
                  aria-disabled={disabled}
                  className="ui-button min-h-9 px-3 py-1.5 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                  onClick={(event) => {
                    if (disabled) event.preventDefault();
                  }}
                  type="button"
                >
                  <ActionButtonLabel
                    idle={actionLabels[action]}
                    pending={pending !== null}
                    pendingLabel={pendingLabels[pending ?? action]}
                  />
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent
                title={`${actionLabels[action]}?`}
                description={actionDescriptions[action]}
              >
                <AlertDialogFooter className="flex-wrap">
                  <AlertDialogCancel className="ui-button">Cancel</AlertDialogCancel>
                  <AlertDialogAction className="ui-button" onClick={() => run(action)}>
                    {actionLabels[action]}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })}
      </div>
      <div
        className={
          result
            ? `type-secondary rounded-md border px-3 py-2 ${toneClass(result.kind)}`
            : undefined
        }
        role="status"
      >
        {result?.text ??
          (activeAction && <span className="sr-only">{pendingLabels[activeAction]}</span>)}
      </div>
    </div>
  );
}
