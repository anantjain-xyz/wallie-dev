"use client";

import Link from "next/link";
import {
  createContext,
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

export function PersonalSettingsLink(props: Omit<ComponentProps<typeof Link>, "onNavigate">) {
  const blocked = useContext(PersonalNavigationContext)?.blocked;
  const [showWarning, setShowWarning] = useState(false);
  return (
    <>
      <Link
        {...props}
        onNavigate={(event) => {
          if (!blocked) return;
          event.preventDefault();
          setShowWarning(true);
        }}
      />
      {blocked && showWarning ? (
        <p className="my-1 w-full type-secondary text-muted" role="status">
          Save or discard your changes before opening Personal settings.
        </p>
      ) : null}
    </>
  );
}
