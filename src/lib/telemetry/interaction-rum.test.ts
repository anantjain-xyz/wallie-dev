import { describe, expect, it, vi } from "vitest";

import { isProductionTelemetryEnabled } from "@/lib/telemetry/environment";
import {
  buildInteractionPayload,
  chooseSessionSample,
  interactionRouteTemplateForPath,
  interactionActions,
} from "@/lib/telemetry/interaction-rum";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("interaction RUM", () => {
  it("uses one stable ten-percent choice for the browser session", () => {
    const sampledStorage = memoryStorage();
    const sampledRandom = vi.fn(() => 0.099);
    expect(chooseSessionSample(sampledStorage, sampledRandom)).toBe(true);
    expect(chooseSessionSample(sampledStorage, sampledRandom)).toBe(true);
    expect(sampledRandom).toHaveBeenCalledTimes(1);

    const excludedStorage = memoryStorage();
    expect(chooseSessionSample(excludedStorage, () => 0.1)).toBe(false);
  });

  it("builds the exact privacy allowlist for all six named actions", () => {
    expect(interactionActions).toEqual([
      "pipeline_to_sessions",
      "sessions_to_detail",
      "open_create_dialog",
      "approve",
      "reject",
      "save_settings",
    ]);

    const payload = buildInteractionPayload({
      action: "approve",
      durationMs: 42.6,
      outcome: "success",
      routeFrom: "/w/[workspaceSlug]/sessions/[sessionNumber]",
      routeTo: "/w/[workspaceSlug]/sessions/[sessionNumber]",
      viewportWidth: 390,
    });

    expect(payload).toEqual({
      action_name: "approve",
      device_class: "mobile",
      duration_ms: 43,
      outcome: "success",
      route_from: "/w/[workspaceSlug]/sessions/[sessionNumber]",
      route_to: "/w/[workspaceSlug]/sessions/[sessionNumber]",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "action_name",
      "device_class",
      "duration_ms",
      "outcome",
      "route_from",
      "route_to",
    ]);
    expect(JSON.stringify(payload)).not.toMatch(
      /acme|workspace-1|TEAM-42|prompt|repository|branch|email|artifact/i,
    );
  });

  it("disables production telemetry in development and test", () => {
    expect(isProductionTelemetryEnabled("production")).toBe(true);
    expect(isProductionTelemetryEnabled("development")).toBe(false);
    expect(isProductionTelemetryEnabled("test")).toBe(false);
  });

  it("classifies interaction paths without retaining identifiers", () => {
    expect(interactionRouteTemplateForPath("/w/acme-corp/settings")).toBe(
      "/w/[workspaceSlug]/settings",
    );
    expect(interactionRouteTemplateForPath("/w/acme-corp/sessions/42")).toBe(
      "/w/[workspaceSlug]/sessions/[sessionNumber]",
    );
  });
});
