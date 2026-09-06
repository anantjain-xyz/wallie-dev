"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createRealtimeRecovery, type RealtimeRecovery } from "./realtime-recovery";

const RecoveryContext = createContext<RealtimeRecovery | null>(null);

export function RealtimeRecoveryProvider({ children }: { children: ReactNode }) {
  const [recovery] = useState(createRealtimeRecovery);
  useEffect(() => recovery.attach(), [recovery]);
  return <RecoveryContext value={recovery}>{children}</RecoveryContext>;
}

export function useRealtimeRecovery() {
  const shared = useContext(RecoveryContext);
  const [local] = useState(() => shared ?? createRealtimeRecovery());
  const recovery = shared ?? local;
  useEffect(() => (shared ? undefined : recovery.attach()), [recovery, shared]);
  const snapshot = useSyncExternalStore(
    recovery.subscribe,
    recovery.getSnapshot,
    recovery.getServerSnapshot,
  );
  return { recovery, ...snapshot };
}
