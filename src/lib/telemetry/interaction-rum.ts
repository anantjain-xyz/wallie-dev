"use client";

import { isProductionTelemetryEnabled } from "@/lib/telemetry/environment";

export const INTERACTION_SAMPLE_RATE = 0.1;
export const INTERACTION_EVENT_NAME = "wallie_interaction";

const SAMPLE_STORAGE_KEY = "wallie-interaction-rum-sampled-v1";
const MAX_DURATION_MS = 300_000;

export const interactionActions = [
  "pipeline_to_sessions",
  "sessions_to_detail",
  "open_create_dialog",
  "approve",
  "reject",
  "save_settings",
] as const;

export type InteractionAction = (typeof interactionActions)[number];
export type InteractionOutcome = "error" | "success";
export type DeviceClass = "desktop" | "mobile" | "tablet";
export type RouteTemplate =
  | "/w/[workspaceSlug]"
  | "/w/[workspaceSlug]/sessions"
  | "/w/[workspaceSlug]/sessions/[sessionNumber]"
  | "/w/[workspaceSlug]/settings";

export type InteractionPayload = Readonly<{
  action_name: InteractionAction;
  device_class: DeviceClass;
  duration_ms: number;
  outcome: InteractionOutcome;
  route_from: RouteTemplate;
  route_to: RouteTemplate;
}>;

type NavigationClick = Readonly<{
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}>;

type PendingInteraction = Readonly<{
  routeFrom: RouteTemplate;
  routeTo: RouteTemplate;
  startedAt: number;
}>;

const pendingInteractions = new Map<InteractionAction, PendingInteraction>();

export function isUnmodifiedPrimaryClick(event: NavigationClick) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function classifyDevice(width: number): DeviceClass {
  if (width < 768) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

export function chooseSessionSample(
  storage: Pick<Storage, "getItem" | "setItem">,
  random: () => number,
) {
  const stored = storage.getItem(SAMPLE_STORAGE_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;

  const sampled = random() < INTERACTION_SAMPLE_RATE;
  storage.setItem(SAMPLE_STORAGE_KEY, sampled ? "1" : "0");
  return sampled;
}

export function buildInteractionPayload(input: {
  action: InteractionAction;
  durationMs: number;
  outcome: InteractionOutcome;
  routeFrom: RouteTemplate;
  routeTo: RouteTemplate;
  viewportWidth: number;
}): InteractionPayload {
  return {
    action_name: input.action,
    device_class: classifyDevice(input.viewportWidth),
    duration_ms: Math.min(MAX_DURATION_MS, Math.max(0, Math.round(input.durationMs))),
    outcome: input.outcome,
    route_from: input.routeFrom,
    route_to: input.routeTo,
  };
}

export function interactionRouteTemplateForPath(pathname: string | null): RouteTemplate {
  if (pathname?.includes("/settings")) return "/w/[workspaceSlug]/settings";
  if (/\/sessions\/[^/]+$/.test(pathname ?? "")) {
    return "/w/[workspaceSlug]/sessions/[sessionNumber]";
  }
  if (pathname?.endsWith("/sessions")) return "/w/[workspaceSlug]/sessions";
  return "/w/[workspaceSlug]";
}

function browserRandom() {
  const value = new Uint32Array(1);
  window.crypto.getRandomValues(value);
  return value[0]! / 2 ** 32;
}

function shouldEmitInteraction() {
  if (!isProductionTelemetryEnabled() || typeof window === "undefined") return false;

  try {
    return chooseSessionSample(window.sessionStorage, browserRandom);
  } catch {
    return false;
  }
}

function markName(action: InteractionAction, edge: "end" | "start") {
  return `wallie:${action}:${edge}`;
}

export function startInteraction(
  action: InteractionAction,
  routeFrom: RouteTemplate,
  routeTo: RouteTemplate = routeFrom,
) {
  if (typeof performance === "undefined") return;

  pendingInteractions.set(action, {
    routeFrom,
    routeTo,
    startedAt: performance.now(),
  });
  performance.mark(markName(action, "start"));
}

export function finishInteraction(action: InteractionAction, outcome: InteractionOutcome) {
  if (typeof performance === "undefined") return null;

  const pending = pendingInteractions.get(action);
  if (!pending) return null;
  pendingInteractions.delete(action);

  performance.mark(markName(action, "end"));
  performance.measure(`wallie:${action}`, markName(action, "start"), markName(action, "end"));

  const payload = buildInteractionPayload({
    action,
    durationMs: performance.now() - pending.startedAt,
    outcome,
    routeFrom: pending.routeFrom,
    routeTo: pending.routeTo,
    viewportWidth: typeof window === "undefined" ? 1024 : window.innerWidth,
  });

  if (shouldEmitInteraction()) {
    void import("@vercel/analytics").then(({ track }) => {
      track(INTERACTION_EVENT_NAME, payload);
    });
  }

  return payload;
}
