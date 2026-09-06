"use client";

import { createContext, useContext } from "react";

export const SessionRefreshContext = createContext<{
  refresh: () => void;
  pending: boolean;
} | null>(null);

export function useSessionRefresh() {
  const context = useContext(SessionRefreshContext);
  if (!context) throw new Error("Session refresh requires the session detail provider.");
  return context;
}
