"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { FACTORY_ROW_ANCHOR_PREFIX } from "@/features/settings/settings-categories";

type LeaveGuard = { busy: boolean; dirty: boolean };
const allowLeave = () => true;

const ManagementNavigation = createContext<{
  blocked: boolean;
  confirmLeave: () => boolean;
  moving: boolean;
  register: (id: string, guard: LeaveGuard) => () => void;
  toggle: (factoryId: string, open: boolean, trigger: HTMLButtonElement) => void;
} | null>(null);

export function FactoryManagementNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [moving, startTransition] = useTransition();
  const [guards, setGuards] = useState(() => new Map<string, LeaveGuard>());
  const register = useCallback((id: string, guard: LeaveGuard) => {
    setGuards((current) => new Map(current).set(id, guard));
    return () => {
      setGuards((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    };
  }, []);
  const blocked = moving || [...guards.values()].some(({ busy }) => busy);
  const dirty = [...guards.values()].some((guard) => guard.dirty);

  function confirmLeave() {
    return !blocked && (!dirty || window.confirm("Discard unsaved changes to this factory?"));
  }

  function toggle(factoryId: string, open: boolean, trigger: HTMLButtonElement) {
    if (!confirmLeave()) return;
    trigger.focus({ preventScroll: true });
    const url = new URL(window.location.href);
    if (open) url.searchParams.delete("manageFactory");
    else url.searchParams.set("manageFactory", factoryId);
    url.hash = open ? `${FACTORY_ROW_ANCHOR_PREFIX}${factoryId}` : "factory-management";
    startTransition(() => router.replace(url.pathname + url.search + url.hash, { scroll: false }));
  }

  return (
    <ManagementNavigation.Provider value={{ blocked, confirmLeave, moving, register, toggle }}>
      {children}
    </ManagementNavigation.Provider>
  );
}

export function useFactoryManagementLeaveGuard() {
  const navigation = useContext(ManagementNavigation);
  return {
    blocked: navigation?.blocked ?? false,
    confirmLeave: navigation?.confirmLeave ?? allowLeave,
  };
}

export function FactoryManagementToggle({
  factoryId,
  factoryName,
  open,
  panelId,
}: {
  factoryId: string;
  factoryName: string;
  open: boolean;
  panelId: string;
}) {
  const navigation = useContext(ManagementNavigation);
  return (
    <button
      aria-controls={panelId}
      aria-disabled={navigation?.blocked || undefined}
      aria-expanded={open}
      aria-label={`${open ? "Close" : "Manage"} ${factoryName}`}
      className="ui-button min-h-11 touch-manipulation sm:min-h-9"
      data-settings-heading=""
      onClick={(event) => navigation?.toggle(factoryId, open, event.currentTarget)}
      type="button"
    >
      {open ? "Close" : "Manage"}
      <ChevronDownIcon className={open ? "rotate-180" : undefined} />
    </button>
  );
}

export function useFactoryManagementGuard(dirty: boolean, busy: boolean) {
  const id = useId();
  const navigation = useContext(ManagementNavigation);
  const register = navigation?.register;
  useLayoutEffect(() => {
    if (dirty || busy) return register?.(id, { dirty, busy });
  }, [busy, dirty, id, register]);
  useEffect(() => {
    if (!dirty) return;
    function preventUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);
  return navigation?.moving ?? false;
}
