"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

import { useOverlayContainer } from "@/components/ui/portal-root";

type TooltipProps = {
  children: ReactElement;
  content: ReactNode;
  delayDuration?: number;
};

export function Tooltip({ children, content, delayDuration }: TooltipProps) {
  const container = useOverlayContainer();

  // Server-rendered feature tests and embedders without Wallie's overlay root
  // still receive the fully named control; the visible enhancement mounts once
  // PortalRootProvider publishes its container.
  if (!container) return children;

  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Content
          className="ui-tooltip-content"
          collisionPadding={8}
          sideOffset={6}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-foreground" width={8} height={4} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
