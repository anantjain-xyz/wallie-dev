"use client";

import { useSyncExternalStore } from "react";

import type { WorkflowGraphDraft } from "./editor-graph";

export const emptyTemplateRoles = { foreman: "", implementation: "", support: "", reviewer: "" };
export type TemplateRoles = typeof emptyTemplateRoles;

export type DraftRecovery = {
  graph: WorkflowGraphDraft;
  roles: TemplateRoles;
  draftId: string | null;
  activationId: string | null;
  baseActivationId: string | null;
};

const recoveryEvent = "wallie-workflow-draft-recovery";

function subscribe(listener: () => void) {
  window.addEventListener(recoveryEvent, listener);
  return () => window.removeEventListener(recoveryEvent, listener);
}

export function useWorkflowDraftRecovery(key: string) {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null,
  );
  if (!raw) return null;
  try {
    const copy = JSON.parse(raw) as DraftRecovery;
    return copy?.graph?.schemaVersion === 1 &&
      copy.graph.kind === "graph" &&
      Array.isArray(copy.graph.nodes) &&
      Array.isArray(copy.graph.edges) &&
      Array.isArray(copy.graph.grants) &&
      copy.roles
      ? copy
      : null;
  } catch {
    return null;
  }
}

export function writeWorkflowDraftRecovery(key: string, value: string | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
    window.dispatchEvent(new Event(recoveryEvent));
    return true;
  } catch {
    return false;
  }
}
