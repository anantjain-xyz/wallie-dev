"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type SessionsLedgerVisibilityContextValue = {
  hideSession: (sessionId: string) => void;
  hiddenCount: number;
  showSession: (sessionId: string) => void;
};

const SessionsLedgerVisibilityContext = createContext<SessionsLedgerVisibilityContextValue | null>(
  null,
);

export function SessionsLedgerVisibilityProvider({
  children,
  emptyFallback,
  sessionCount,
}: {
  children: ReactNode;
  emptyFallback: ReactNode;
  sessionCount: number;
}) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());

  const hideSession = useCallback((sessionId: string) => {
    setHiddenIds((current) => {
      if (current.has(sessionId)) return current;
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
  }, []);

  const showSession = useCallback((sessionId: string) => {
    setHiddenIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ hideSession, hiddenCount: hiddenIds.size, showSession }),
    [hideSession, hiddenIds.size, showSession],
  );

  if (sessionCount > 0 && hiddenIds.size >= sessionCount) {
    return (
      <SessionsLedgerVisibilityContext.Provider value={value}>
        {emptyFallback}
      </SessionsLedgerVisibilityContext.Provider>
    );
  }

  return (
    <SessionsLedgerVisibilityContext.Provider value={value}>
      {children}
    </SessionsLedgerVisibilityContext.Provider>
  );
}

export function useSessionsLedgerVisibility() {
  return useContext(SessionsLedgerVisibilityContext);
}
