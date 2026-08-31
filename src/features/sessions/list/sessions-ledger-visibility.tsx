"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

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
  sessionIds,
}: {
  children: ReactNode;
  emptyFallback: ReactNode;
  /** Authoritative IDs for the current result set; stale hide entries are ignored. */
  sessionIds: readonly string[];
}) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());

  const sessionIdSet = useMemo(() => new Set(sessionIds), [sessionIds]);

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

  const hiddenCount = useMemo(() => {
    let count = 0;
    for (const id of hiddenIds) {
      if (sessionIdSet.has(id)) count += 1;
    }
    return count;
  }, [hiddenIds, sessionIdSet]);

  const value = useMemo(
    () => ({ hideSession, hiddenCount, showSession }),
    [hideSession, hiddenCount, showSession],
  );

  // Keep row islands mounted under the empty presentation so pending hide state
  // survives when a concurrent archive fails and the ledger restores.
  const allHidden = sessionIds.length > 0 && hiddenCount >= sessionIds.length;

  return (
    <SessionsLedgerVisibilityContext.Provider value={value}>
      {allHidden ? emptyFallback : null}
      <div hidden={allHidden}>{children}</div>
    </SessionsLedgerVisibilityContext.Provider>
  );
}

export function useSessionsLedgerVisibility() {
  return useContext(SessionsLedgerVisibilityContext);
}
