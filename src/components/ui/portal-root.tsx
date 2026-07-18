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
 * Ancestor of the overlay root: Radix modal dialogs apply `aria-hidden` outside
 * the ancestry of their portaled content. Keeping announcements in this outer
 * container prevents that modal isolation from hiding live status updates.
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
        <div data-wallie-announcement-root="" id={ANNOUNCEMENT_ROOT_ID} ref={setAnnouncementRoot}>
          <div data-wallie-overlay-root="" id={OVERLAY_ROOT_ID} ref={setOverlayRoot} />
        </div>
      </OverlayContainerContext>
    </AnnouncementContainerContext>
  );
}
