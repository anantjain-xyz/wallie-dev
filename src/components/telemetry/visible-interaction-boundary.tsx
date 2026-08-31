"use client";

import { useEffect } from "react";

import { finishInteraction, type InteractionAction } from "@/lib/telemetry/interaction-rum";

type VisibleNavigationAction = Extract<
  InteractionAction,
  "pipeline_to_sessions" | "sessions_to_detail"
>;

export function VisibleInteractionBoundary({ action }: { action: VisibleNavigationAction }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => finishInteraction(action, "success"));
    return () => cancelAnimationFrame(frame);
  }, [action]);

  return null;
}
