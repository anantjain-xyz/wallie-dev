"use client";

import { createContext, type ReactNode, useContext } from "react";

import { SessionWalliePanel } from "@/features/wallie/session-wallie-panel";
import type { WallieSessionData } from "@/features/wallie/types";

const SessionActivityArchivedAtContext = createContext<string | null | undefined>(undefined);

export function SessionActivityArchivedAtProvider({
  archivedAt,
  children,
}: {
  archivedAt: string | null;
  children: ReactNode;
}) {
  return (
    <SessionActivityArchivedAtContext.Provider value={archivedAt}>
      {children}
    </SessionActivityArchivedAtContext.Provider>
  );
}

export function useSessionActivityArchivedAt(initialArchivedAt: string | null) {
  const archivedAt = useContext(SessionActivityArchivedAtContext);

  return archivedAt === undefined ? initialArchivedAt : archivedAt;
}

export function SessionActivityPanel({
  initialArchivedAt,
  initialData,
  sessionId,
  workspaceId,
  workspaceSlug,
}: {
  initialArchivedAt: string | null;
  initialData: WallieSessionData;
  sessionId: string;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const archivedAt = useSessionActivityArchivedAt(initialArchivedAt);

  return (
    <SessionWalliePanel
      initialData={initialData}
      session={{
        archivedAt,
        id: sessionId,
        workspaceId,
      }}
      workspaceSlug={workspaceSlug}
    />
  );
}
