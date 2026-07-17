"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const OverlayContainerContext = createContext<HTMLElement | null>(null);

export const OVERLAY_ROOT_ID = "wallie-overlay-root";

export function useOverlayContainer() {
  return useContext(OverlayContainerContext);
}

export function PortalRootProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const setRoot = useCallback((node: HTMLDivElement | null) => setContainer(node), []);

  return (
    <OverlayContainerContext value={container}>
      {children}
      <div data-wallie-overlay-root="" id={OVERLAY_ROOT_ID} ref={setRoot} />
    </OverlayContainerContext>
  );
}
