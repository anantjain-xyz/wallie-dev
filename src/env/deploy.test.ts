import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDeploymentEnvironment,
  isPreviewDeploy,
  isProductionDeploy,
  isVercelTelemetryEnabled,
} from "@/env/deploy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deployment environment", () => {
  it.each([
    [{ WALLIE_DEPLOY_ENV: "production" }, "production"],
    [{ WALLIE_DEPLOY_ENV: "preview", VERCEL_ENV: "production" }, "preview"],
    [{ WALLIE_DEPLOY_ENV: "development", NODE_ENV: "production" }, "development"],
    [{ WALLIE_DEPLOY_ENV: "production", VERCEL_ENV: "preview" }, "production"],
    [{ WALLIE_DEPLOY_ENV: " production " }, "production"],
    [{ VERCEL_ENV: "production" }, "production"],
    [{ VERCEL_ENV: "preview", NODE_ENV: "production" }, "preview"],
    [{ VERCEL_ENV: "development", NODE_ENV: "production" }, "development"],
    [{ NODE_ENV: "production" }, "production"],
    [{ NODE_ENV: "development" }, "development"],
    [{ NODE_ENV: "test" }, "development"],
    [{}, "development"],
    [{ WALLIE_DEPLOY_ENV: "", NODE_ENV: "production" }, "production"],
    [{ WALLIE_DEPLOY_ENV: "  ", VERCEL_ENV: "preview" }, "preview"],
    [{ VERCEL_ENV: "unrecognized", NODE_ENV: "production" }, "production"],
  ])("resolves %j as %s", (input, expected) => {
    expect(getDeploymentEnvironment(input)).toBe(expected);
    expect(isProductionDeploy(input)).toBe(expected === "production");
    expect(isPreviewDeploy(input)).toBe(expected === "preview");
  });

  it.each(["prod", "staging", "false"])(
    "rejects invalid explicit configuration instead of falling back: %s",
    (value) => {
      const input = { WALLIE_DEPLOY_ENV: value, VERCEL_ENV: "preview", NODE_ENV: "production" };
      expect(() => isProductionDeploy(input)).toThrow("WALLIE_DEPLOY_ENV");
      expect(() => isPreviewDeploy(input)).toThrow("WALLIE_DEPLOY_ENV");
      expect(() => isVercelTelemetryEnabled(input)).toThrow("WALLIE_DEPLOY_ENV");
    },
  );

  it("reads deployment settings when called rather than caching module initialization", () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WALLIE_DEPLOY_ENV", "preview");
    expect(isPreviewDeploy()).toBe(true);

    vi.stubEnv("WALLIE_DEPLOY_ENV", "production");
    expect(isProductionDeploy()).toBe(true);
    expect(isPreviewDeploy()).toBe(false);
  });
});

describe("Vercel telemetry", () => {
  it.each([
    [{ VERCEL_ENV: "production" }, true],
    [{ WALLIE_DEPLOY_ENV: "production", VERCEL_ENV: "production" }, true],
    [{ WALLIE_DEPLOY_ENV: "preview", VERCEL_ENV: "production" }, false],
    [{ WALLIE_DEPLOY_ENV: "development", VERCEL_ENV: "production" }, false],
    [{ WALLIE_DEPLOY_ENV: "production", VERCEL_ENV: "preview" }, false],
    [{ WALLIE_DEPLOY_ENV: "production" }, false],
    [{ NODE_ENV: "production" }, false],
    [{ VERCEL_ENV: "preview", NODE_ENV: "production" }, false],
    [{ NODE_ENV: "development" }, false],
  ])("enables Vercel telemetry for %j: %s", (input, expected) => {
    expect(isVercelTelemetryEnabled(input)).toBe(expected);
  });
});
