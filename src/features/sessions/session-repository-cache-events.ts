"use client";

export const SESSION_REPOSITORIES_CHANGED_EVENT = "wallie:session-repositories-changed";

export type SessionRepositoriesChangedDetail = {
  workspaceId: string;
};

export function notifySessionRepositoriesChanged(workspaceId: string) {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent<SessionRepositoriesChangedDetail>(SESSION_REPOSITORIES_CHANGED_EVENT, {
      detail: { workspaceId },
    }),
  );
}
