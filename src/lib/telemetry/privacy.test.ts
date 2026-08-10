import { describe, expect, it } from "vitest";

import { routeTemplateForPath, sanitizeTelemetryUrl } from "@/lib/telemetry/privacy";

describe("telemetry route privacy", () => {
  it("removes workspace slugs, session numbers, queries, and fragments", () => {
    expect(routeTemplateForPath("/w/acme-corp/sessions/42")).toBe(
      "/w/[workspaceSlug]/sessions/[sessionNumber]",
    );
    const sanitized = sanitizeTelemetryUrl(
      "https://wallie.dev/w/acme-corp/sessions/42?title=secret#artifact",
    );
    expect(sanitized).toBe("https://wallie.dev/w/[workspaceSlug]/sessions/[sessionNumber]");
    expect(sanitized).not.toMatch(/acme-corp|42|secret|artifact/);
  });

  it("redacts unknown routes instead of leaking identifiers", () => {
    expect(sanitizeTelemetryUrl("https://wallie.dev/invite/private-token")).toBe(
      "https://wallie.dev/redacted",
    );
  });

  it("redacts retired compatibility routes", () => {
    expect(routeTemplateForPath("/signup")).toBe("/redacted");
    expect(routeTemplateForPath("/w/acme-corp/pipeline")).toBe("/redacted");
    expect(routeTemplateForPath("/auth/oauth")).toBe("/redacted");
    expect(sanitizeTelemetryUrl("https://wallie.dev/signup?next=%2Fw%2Facme")).toBe(
      "https://wallie.dev/redacted",
    );
  });
});
