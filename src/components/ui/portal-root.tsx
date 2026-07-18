"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const OverlayContainerContext = createContext<HTMLElement | null>(null);
const AnnouncementContainerContext = createContext<HTMLElement | null>(null);

export const OVERLAY_ROOT_ID = "wallie-overlay-root";
export const ANNOUNCEMENT_ROOT_ID = "wallie-announcement-root";

export function useOverlayContainer() {
  return useContext(OverlayContainerContext);
}

/**
 * Separate from the overlay root: Radix modal dialogs apply `aria-hidden` to
 * siblings of their portaled content, so live regions and the toast viewport
 * must live here to stay audible while a dialog is open.
 */
export function useAnnouncementContainer() {
  return useContext(AnnouncementContainerContext);
}

export function PortalRootProvider({ children }: { children: ReactNode }) {
  const [overlayContainer, setOverlayContainer] = useState<HTMLDivElement | null>(null);
  const [announcementContainer, setAnnouncementContainer] = useState<HTMLDivElement | null>(null);
  const setOverlayRoot = useCallback(
    (node: HTMLDivElement | null) => setOverlayContainer(node),
    [],
  );
  const setAnnouncementRoot = useCallback(
    (node: HTMLDivElement | null) => setAnnouncementContainer(node),
    [],
  );

  return (
    <AnnouncementContainerContext value={announcementContainer}>
      <OverlayContainerContext value={overlayContainer}>
        {children}
        <div data-wallie-overlay-root="" id={OVERLAY_ROOT_ID} ref={setOverlayRoot} />
        <div data-wallie-announcement-root="" id={ANNOUNCEMENT_ROOT_ID} ref={setAnnouncementRoot} />
      </OverlayContainerContext>
    </AnnouncementContainerContext>
  );
}
