import { afterEach, describe, expect, it } from "vitest";

import { getEnabledSandboxProviders, normalizeDaytonaApiUrl } from "./server";

const previousAllowlist = process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST;
const previousEnabled = process.env.WALLIE_ENABLED_SANDBOX_PROVIDERS;

afterEach(() => {
  if (previousAllowlist === undefined) delete process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST;
  else process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST = previousAllowlist;
  if (previousEnabled === undefined) delete process.env.WALLIE_ENABLED_SANDBOX_PROVIDERS;
  else process.env.WALLIE_ENABLED_SANDBOX_PROVIDERS = previousEnabled;
});

describe("Daytona control-plane policy", () => {
  it("allows Daytona Cloud by default and normalizes trailing slashes", () => {
    expect(normalizeDaytonaApiUrl()).toBe("https://app.daytona.io/api");
    expect(normalizeDaytonaApiUrl("https://app.daytona.io/api///")).toBe(
      "https://app.daytona.io/api",
    );
  });

  it("allows only exact deployment-approved HTTPS endpoints", () => {
    process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST = "https://daytona.acme.test/api/";
    expect(normalizeDaytonaApiUrl("https://daytona.acme.test/api")).toBe(
      "https://daytona.acme.test/api",
    );
    expect(() => normalizeDaytonaApiUrl("https://daytona.acme.test/other")).toThrow(/not allowed/);
  });

  it("rejects insecure URLs, embedded credentials, queries, and fragments", () => {
    for (const value of [
      "http://daytona.acme.test/api",
      "https://user:pass@daytona.acme.test/api",
      "https://daytona.acme.test/api?token=x",
      "https://daytona.acme.test/api#fragment",
    ]) {
      expect(() => normalizeDaytonaApiUrl(value)).toThrow();
    }
  });
});

describe("sandbox provider rollout gating", () => {
  it("defaults to all providers and supports an incremental allowlist", () => {
    delete process.env.WALLIE_ENABLED_SANDBOX_PROVIDERS;
    expect(getEnabledSandboxProviders()).toEqual(["vercel", "e2b", "daytona"]);
    process.env.WALLIE_ENABLED_SANDBOX_PROVIDERS = "vercel, e2b";
    expect(getEnabledSandboxProviders()).toEqual(["vercel", "e2b"]);
  });
});
