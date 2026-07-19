"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  resolveSettingsHashRoute,
  settingsCategoryFromPathname,
} from "@/features/settings/settings-hash-routes";

type DirtyRegistration = {
  canEdit: boolean;
  isDirty: boolean;
};

type SettingsDirtyRegistryValue = {
  confirmLeaveIfDirty: () => boolean;
  hasUnsavedChanges: boolean;
  registerDirtySource: (id: string, registration: DirtyRegistration) => void;
  unregisterDirtySource: (id: string) => void;
};

const SettingsDirtyRegistryContext = createContext<SettingsDirtyRegistryValue | null>(null);

const UNSAVED_MESSAGE = "You have unsaved settings changes. Leave this page anyway?";

/** Set when a click handler already confirmed leave; consumed by the next programmatic nav. */
let suppressNextLeaveConfirm = false;

export function markSettingsLeaveConfirmed() {
  suppressNextLeaveConfirm = true;
}

export function confirmSettingsLeave(hasUnsavedChanges: boolean): boolean {
  if (!hasUnsavedChanges) return true;
  if (suppressNextLeaveConfirm) {
    suppressNextLeaveConfirm = false;
    return true;
  }
  return window.confirm(UNSAVED_MESSAGE);
}

export function SettingsDirtyRegistryProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<Record<string, DirtyRegistration>>({});

  const registerDirtySource = useCallback((id: string, registration: DirtyRegistration) => {
    setSources((current) => {
      const existing = current[id];
      if (
        existing &&
        existing.canEdit === registration.canEdit &&
        existing.isDirty === registration.isDirty
      ) {
        return current;
      }
      return { ...current, [id]: registration };
    });
  }, []);

  const unregisterDirtySource = useCallback((id: string) => {
    setSources((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const hasUnsavedChanges = useMemo(
    () => Object.values(sources).some((source) => source.canEdit && source.isDirty),
    [sources],
  );

  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);

  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  const confirmLeaveIfDirty = useCallback(
    () => confirmSettingsLeave(hasUnsavedChangesRef.current),
    [],
  );

  useEffect(() => {
    let restoringHistory = false;

    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!hasUnsavedChangesRef.current) return;
      event.preventDefault();
      event.returnValue = UNSAVED_MESSAGE;
    }

    function onPopState() {
      if (restoringHistory) return;
      if (!hasUnsavedChangesRef.current) return;

      if (!window.confirm(UNSAVED_MESSAGE)) {
        restoringHistory = true;
        window.history.go(1);
        queueMicrotask(() => {
          restoringHistory = false;
        });
        return;
      }

      markSettingsLeaveConfirmed();
    }

    function onDocumentClick(event: MouseEvent) {
      if (!hasUnsavedChangesRef.current) return;
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      if (href.startsWith("#")) {
        const route = resolveSettingsHashRoute(href);
        const currentCategory = settingsCategoryFromPathname(window.location.pathname);
        if (!route || !currentCategory || route.category === currentCategory) {
          return;
        }

        if (!window.confirm(UNSAVED_MESSAGE)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        markSettingsLeaveConfirmed();
        return;
      }

      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;
      if (
        nextUrl.pathname === window.location.pathname &&
        nextUrl.search === window.location.search
      ) {
        return;
      }

      if (!window.confirm(UNSAVED_MESSAGE)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, []);

  const value = useMemo(
    () => ({
      confirmLeaveIfDirty,
      hasUnsavedChanges,
      registerDirtySource,
      unregisterDirtySource,
    }),
    [confirmLeaveIfDirty, hasUnsavedChanges, registerDirtySource, unregisterDirtySource],
  );

  return (
    <SettingsDirtyRegistryContext.Provider value={value}>
      {children}
    </SettingsDirtyRegistryContext.Provider>
  );
}

export function useRegisterSettingsDirtySource(id: string, isDirty: boolean, canEdit: boolean) {
  const registry = useContext(SettingsDirtyRegistryContext);

  useEffect(() => {
    if (!registry) return;
    registry.registerDirtySource(id, { canEdit, isDirty });
    return () => registry.unregisterDirtySource(id);
  }, [canEdit, id, isDirty, registry]);
}

export function useSettingsHasUnsavedChanges() {
  return useContext(SettingsDirtyRegistryContext)?.hasUnsavedChanges ?? false;
}

export function useConfirmSettingsLeave() {
  const registry = useContext(SettingsDirtyRegistryContext);
  return registry?.confirmLeaveIfDirty ?? (() => true);
}
