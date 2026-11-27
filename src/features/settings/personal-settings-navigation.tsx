"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

const PersonalNavigationContext = createContext<{
  blocked: boolean;
  setBlockers: Dispatch<SetStateAction<number>>;
} | null>(null);

export function PersonalSettingsNavigation({ children }: { children: ReactNode }) {
  const [blockers, setBlockers] = useState(0);
  return (
    <PersonalNavigationContext.Provider value={{ blocked: blockers > 0, setBlockers }}>
      {children}
    </PersonalNavigationContext.Provider>
  );
}

export function useBlockPersonalSettings(blocked: boolean) {
  const setBlockers = useContext(PersonalNavigationContext)?.setBlockers;
  useLayoutEffect(() => {
    if (!blocked || !setBlockers) return;
    setBlockers((count) => count + 1);
    return () => setBlockers((count) => count - 1);
  }, [blocked, setBlockers]);
}

export function usePersonalSettingsGuard() {
  const blocked = useContext(PersonalNavigationContext)?.blocked ?? false;
  const [showWarning, setShowWarning] = useState(false);
  if (!blocked && showWarning) setShowWarning(false);
  const stopNavigation = useCallback(() => {
    if (!blocked) return false;
    setShowWarning(true);
    return true;
  }, [blocked]);
  const warning =
    blocked && showWarning ? (
      <p className="my-1 w-full type-secondary text-muted" role="status">
        Save or discard your changes before opening Personal settings.
      </p>
    ) : null;
  return { stopNavigation, warning };
}

export function PersonalSettingsLink(props: Omit<ComponentProps<typeof Link>, "onNavigate">) {
  const { stopNavigation, warning } = usePersonalSettingsGuard();
  return (
    <>
      <Link
        {...props}
        onNavigate={(event) => {
          if (stopNavigation()) event.preventDefault();
        }}
      />
      {warning}
    </>
  );
}
