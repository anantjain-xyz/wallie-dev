"use client";

import { useCallback, useEffect, useState } from "react";

import type { AgentConfigMap } from "@/features/settings/data";
import type { PipelineConfiguration } from "@/features/sessions/types";
import {
  dispatchSettingsEvent,
  SETTINGS_FACTORY_DEFINITION_CHANGED,
  SETTINGS_FACTORY_DEFINITION_RELOADED,
} from "@/features/settings/settings-island-events";
import type { DeliveryPolicy } from "@/lib/delivery-policy/contracts";
import type { ExecutionPolicy } from "@/lib/execution-policy/contracts";
import type { FactoryDefinitionDiagnostic } from "@/lib/factory-definitions/compiler";
import type { FactoryActivationSummary } from "@/lib/factory-definitions/mutations";
import {
  createEmptySettingsFactoryDefinitionState,
  type SettingsFactoryCommand,
  type SettingsFactoryDefinitionState,
  type SettingsFactoryPatch,
} from "@/lib/factory-definitions/settings-contracts";
import type { SandboxProvider } from "@/lib/sandbox/types";

export type FactoryDirtySection = "agent" | "delivery-policy" | "execution-policy" | "pipeline";

export type SettingsFactoryReloadPayload = {
  agentConfig?: AgentConfigMap;
  pipeline: PipelineConfiguration | null;
  sandboxProvider?: SandboxProvider;
  state: SettingsFactoryDefinitionState;
};

export type SettingsFactoryReloadEventDetail = {
  payload: SettingsFactoryReloadPayload;
  workspaceId: string;
};

export type SettingsFactoryMutationPayload = {
  activation?: FactoryActivationSummary;
  agentConfig?: AgentConfigMap;
  deliveryPolicy?: DeliveryPolicy | null;
  executionPolicy?: ExecutionPolicy | null;
  pipeline?: PipelineConfiguration;
  sandboxProvider?: SandboxProvider;
  state: SettingsFactoryDefinitionState;
};

type StoreEntry = {
  conflict: string | null;
  dirtySections: Set<FactoryDirtySection>;
  state: SettingsFactoryDefinitionState;
  subscribers: number;
};

const stores = new Map<string, StoreEntry>();

function getOrCreateStore(
  workspaceId: string,
  initialState?: SettingsFactoryDefinitionState,
): StoreEntry {
  const existing = stores.get(workspaceId);
  if (existing) return existing;
  const created: StoreEntry = {
    conflict: null,
    dirtySections: new Set(),
    state: initialState ?? createEmptySettingsFactoryDefinitionState(),
    subscribers: 0,
  };
  stores.set(workspaceId, created);
  return created;
}

function notifyStore(workspaceId: string) {
  const entry = stores.get(workspaceId);
  if (!entry) return;
  dispatchSettingsEvent(SETTINGS_FACTORY_DEFINITION_CHANGED, {
    conflict: entry.conflict,
    dirtySections: [...entry.dirtySections],
    state: entry.state,
    workspaceId,
  });
}

export function setFactorySectionDirty(
  workspaceId: string,
  section: FactoryDirtySection,
  dirty: boolean,
) {
  const entry = stores.get(workspaceId);
  if (!entry) return;
  const had = entry.dirtySections.has(section);
  if (had === dirty) return;
  if (dirty) entry.dirtySections.add(section);
  else entry.dirtySections.delete(section);
  notifyStore(workspaceId);
}

export function useFactoryDefinitionStore(
  workspaceId: string,
  initialState?: SettingsFactoryDefinitionState,
) {
  const entry = getOrCreateStore(workspaceId, initialState);
  const [snapshot, setSnapshot] = useState(() => ({
    conflict: entry.conflict,
    dirtySections: [...entry.dirtySections],
    state: entry.state,
  }));

  useEffect(() => {
    const store = getOrCreateStore(workspaceId, initialState);
    store.subscribers += 1;

    const handleChange = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          conflict: string | null;
          dirtySections: FactoryDirtySection[];
          state: SettingsFactoryDefinitionState;
          workspaceId: string;
        }>
      ).detail;
      if (detail.workspaceId !== workspaceId) return;
      setSnapshot({
        conflict: detail.conflict,
        dirtySections: detail.dirtySections,
        state: detail.state,
      });
    };

    window.addEventListener(SETTINGS_FACTORY_DEFINITION_CHANGED, handleChange);
    return () => {
      window.removeEventListener(SETTINGS_FACTORY_DEFINITION_CHANGED, handleChange);
      const current = stores.get(workspaceId);
      if (current) {
        current.subscribers = Math.max(0, current.subscribers - 1);
        if (current.subscribers === 0) {
          stores.delete(workspaceId);
        }
      }
    };
  }, [initialState, workspaceId]);

  const setDirty = useCallback(
    (section: FactoryDirtySection, dirty: boolean) => {
      setFactorySectionDirty(workspaceId, section, dirty);
    },
    [workspaceId],
  );

  return {
    ...snapshot,
    setDirty,
  };
}

export function useFactoryDefinitionReloadListener(
  workspaceId: string,
  enabled: boolean,
  onReload: (payload: SettingsFactoryReloadPayload) => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const handleReload = (event: Event) => {
      const detail = (event as CustomEvent<SettingsFactoryReloadEventDetail>).detail;
      if (detail.workspaceId !== workspaceId) return;
      onReload(detail.payload);
    };
    window.addEventListener(SETTINGS_FACTORY_DEFINITION_RELOADED, handleReload);
    return () => window.removeEventListener(SETTINGS_FACTORY_DEFINITION_RELOADED, handleReload);
  }, [enabled, onReload, workspaceId]);
}

export type FactoryMutationResponse =
  | { ok: true; data: SettingsFactoryMutationPayload }
  | {
      ok: false;
      status: number;
      error: string;
      diagnostics?: FactoryDefinitionDiagnostic[];
      fieldErrors?: Record<string, string>;
    };

export async function saveSettingsFactoryDraft(
  workspaceId: string,
  patch: SettingsFactoryPatch,
  fallbackState?: SettingsFactoryDefinitionState,
): Promise<FactoryMutationResponse> {
  const entry = getOrCreateStore(workspaceId, fallbackState);
  const command: SettingsFactoryCommand = {
    action: "draft",
    expectedActivationNumber: entry.state.expectedActivationNumber,
    expectedDraftId: entry.state.latestDraft?.id ?? null,
    patch,
  };

  const response = await fetch(`/api/workspaces/${workspaceId}/factory-definition/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await response.json().catch(() => null)) as
    | (SettingsFactoryMutationPayload & { error?: never })
    | {
        error?: string;
        diagnostics?: FactoryDefinitionDiagnostic[];
        fieldErrors?: Record<string, string>;
      }
    | null;

  if (response.status === 409) {
    const message =
      (body && "error" in body && body.error) ||
      "The factory definition changed. Reload before retrying.";
    entry.conflict = message;
    notifyStore(workspaceId);
    return { ok: false, status: 409, error: message };
  }

  if (!response.ok || !body || !("state" in body)) {
    return {
      ok: false,
      status: response.status,
      error: (body && "error" in body && body.error) || "Could not save factory definition draft.",
      diagnostics: body && "diagnostics" in body ? body.diagnostics : undefined,
      fieldErrors: body && "fieldErrors" in body ? body.fieldErrors : undefined,
    };
  }

  entry.state = body.state;
  entry.conflict = null;
  notifyStore(workspaceId);
  return { ok: true, data: body };
}

export async function publishSettingsFactoryDraft(
  workspaceId: string,
  fallbackState?: SettingsFactoryDefinitionState,
): Promise<FactoryMutationResponse> {
  const entry = getOrCreateStore(workspaceId, fallbackState);
  const draftId = entry.state.latestDraft?.id;
  if (!draftId) {
    return { ok: false, status: 400, error: "Save a draft before publishing." };
  }

  const command: SettingsFactoryCommand = {
    action: "publish",
    expectedActivationNumber: entry.state.expectedActivationNumber,
    draftId,
  };

  const response = await fetch(`/api/workspaces/${workspaceId}/factory-definition/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await response.json().catch(() => null)) as
    | (SettingsFactoryMutationPayload & { error?: never })
    | {
        error?: string;
        diagnostics?: FactoryDefinitionDiagnostic[];
        fieldErrors?: Record<string, string>;
      }
    | null;

  if (response.status === 409) {
    const message =
      (body && "error" in body && body.error) ||
      "The active definition changed. Reload before publishing.";
    entry.conflict = message;
    notifyStore(workspaceId);
    return { ok: false, status: 409, error: message };
  }

  if (!response.ok || !body || !("state" in body)) {
    return {
      ok: false,
      status: response.status,
      error:
        (body && "error" in body && body.error) || "Could not publish factory definition draft.",
      diagnostics: body && "diagnostics" in body ? body.diagnostics : undefined,
      fieldErrors: body && "fieldErrors" in body ? body.fieldErrors : undefined,
    };
  }

  entry.state = body.state;
  entry.conflict = null;
  notifyStore(workspaceId);
  return { ok: true, data: body };
}

export async function reloadSettingsFactoryDefinition(
  workspaceId: string,
  fallbackState?: SettingsFactoryDefinitionState,
): Promise<{ ok: true; data: SettingsFactoryReloadPayload } | { ok: false; error: string }> {
  const entry = getOrCreateStore(workspaceId, fallbackState);
  const response = await fetch(`/api/workspaces/${workspaceId}/factory-definition/settings`, {
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | (SettingsFactoryReloadPayload & { error?: never })
    | { error?: string }
    | null;

  if (!response.ok || !body || !("state" in body)) {
    return {
      ok: false,
      error:
        (body && "error" in body && body.error) || "Could not reload factory definition state.",
    };
  }

  entry.state = body.state;
  entry.conflict = null;
  entry.dirtySections.clear();
  notifyStore(workspaceId);
  dispatchSettingsEvent(SETTINGS_FACTORY_DEFINITION_RELOADED, {
    payload: body,
    workspaceId,
  } satisfies SettingsFactoryReloadEventDetail);
  return { ok: true, data: body };
}
