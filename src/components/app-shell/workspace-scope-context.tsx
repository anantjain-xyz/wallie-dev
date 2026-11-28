"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  restoreWorkspaceScope,
  workspaceScopePreference,
  workspaceScopePreferenceKey,
  type WorkspaceScope,
} from "@/components/app-shell/workspace-location";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";

export type WorkspaceScopeSnapshot = {
  locationKey: string;
  workspaceId: string;
  viewerId: string;
  scope: WorkspaceScope;
  factories: readonly FactorySelectionOption[];
  picker: "header" | "guarded" | "leaf" | "locked";
  manageFactoriesHref?: string;
  resetParams?: readonly string[];
};

export const WorkspaceScopeContext = createContext<{
  publish: (snapshot: WorkspaceScopeSnapshot) => () => void;
  ownsPicker: boolean;
  guardedPicker: { target: HTMLElement | null; manageFactoriesHref?: string } | null;
} | null>(null);

export function useWorkspaceScopeSnapshot(
  viewerId: string,
  workspaceId: string,
  locationKey: string,
) {
  const [current, setCurrent] = useState<WorkspaceScopeSnapshot | null>(null);
  const publish = useCallback((snapshot: WorkspaceScopeSnapshot) => {
    setCurrent(snapshot);
    return () => setCurrent((current) => (current === snapshot ? null : current));
  }, []);
  const snapshot =
    current?.viewerId === viewerId &&
    current.workspaceId === workspaceId &&
    current.locationKey === locationKey
      ? current
      : null;
  return { publish, snapshot };
}

export function WorkspaceScopeHandoff({ snapshot }: { snapshot: WorkspaceScopeSnapshot }) {
  const publish = useContext(WorkspaceScopeContext)?.publish;
  useLayoutEffect(() => publish?.(snapshot), [publish, snapshot]);
  return null;
}

export function useRememberedWorkspaceScope({
  factories,
  snapshot,
  viewerId,
  workspaceId,
}: {
  factories: readonly FactorySelectionOption[];
  snapshot: WorkspaceScopeSnapshot | null;
  viewerId: string;
  workspaceId: string;
}) {
  const key = workspaceScopePreferenceKey(viewerId, workspaceId);
  const read = useCallback(() => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }, [key]);
  const subscribe = useCallback(
    (notify: () => void) => {
      const changed = (event: StorageEvent) => {
        if (event.key === key || event.key === null) notify();
      };
      window.addEventListener("storage", changed);
      return () => window.removeEventListener("storage", changed);
    },
    [key],
  );
  const stored = useSyncExternalStore(subscribe, read, () => null);
  const value =
    snapshot && snapshot.picker !== "locked" ? workspaceScopePreference(snapshot.scope) : null;
  useEffect(() => {
    if (!value) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  }, [key, value]);
  return restoreWorkspaceScope(stored, factories);
}
