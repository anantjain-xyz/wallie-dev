"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

import { LiveRegionProvider } from "@/components/ui/live-region";
import { PortalRootProvider } from "@/components/ui/portal-root";
import { ToastProvider } from "@/components/ui/toast";

export function OverlayProvider({ children }: { children: ReactNode }) {
  return (
    <PortalRootProvider>
      <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={300}>
        <LiveRegionProvider>
          <ToastProvider>{children}</ToastProvider>
        </LiveRegionProvider>
      </TooltipPrimitive.Provider>
    </PortalRootProvider>
  );
}
