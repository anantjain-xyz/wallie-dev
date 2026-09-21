import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DevLayout from "./layout";

beforeEach(() => {
  vi.stubEnv("WALLIE_DEPLOY_ENV", undefined);
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("development fixture access", () => {
  it("returns not found on a production server without Vercel metadata", () => {
    expect(() => DevLayout({ children: "fixture" })).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("returns not found for explicit production regardless of Vercel preview metadata", () => {
    vi.stubEnv("WALLIE_DEPLOY_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(() => DevLayout({ children: "fixture" })).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("keeps Vercel previews accessible with NODE_ENV=production", () => {
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(DevLayout({ children: "fixture" })).toBe("fixture");
  });

  it.each(["preview", "development"])("allows an explicit %s environment", (environment) => {
    vi.stubEnv("WALLIE_DEPLOY_ENV", environment);

    expect(DevLayout({ children: "fixture" })).toBe("fixture");
  });

  it("allows local development without deployment configuration", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(DevLayout({ children: "fixture" })).toBe("fixture");
  });

  it("checks production access after a preview setting changes", () => {
    vi.stubEnv("WALLIE_DEPLOY_ENV", "preview");
    expect(DevLayout({ children: "fixture" })).toBe("fixture");

    vi.stubEnv("WALLIE_DEPLOY_ENV", "production");
    expect(() => DevLayout({ children: "fixture" })).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("does not expose fixtures for an invalid explicit environment", () => {
    vi.stubEnv("WALLIE_DEPLOY_ENV", "prod");
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(() => DevLayout({ children: "fixture" })).toThrow("WALLIE_DEPLOY_ENV");
  });
});
