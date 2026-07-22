import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getEnabledSandboxProviders,
  loadDaytonaSandboxConnectionPreview,
  loadWorkspaceSandboxConnection,
  normalizeDaytonaApiUrl,
} from "./server";

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

  it("reports stored connections rejected by the current allowlist as invalid", async () => {
    const row = {
      api_key_preview: "daytona_…1234",
      api_url: "https://retired-daytona.example/api",
      connection_revision: "revision-daytona",
      encrypted_api_key: "encrypted-key",
      last_validated_at: "2026-07-22T00:00:00.000Z",
      last_validation_error: null,
      status: "connected",
      target: null,
      updated_at: "2026-07-22T00:00:00.000Z",
      workspace_id: "workspace-1",
    };
    const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    const admin = {
      from: vi.fn(() => ({
        select: () => ({ eq: () => ({ maybeSingle }) }),
      })),
    };

    await expect(
      loadDaytonaSandboxConnectionPreview(admin as never, row.workspace_id),
    ).resolves.toMatchObject({
      lastValidationError: "Daytona API URL is not allowed by this Wallie deployment.",
      status: "error",
    });
    await expect(
      loadWorkspaceSandboxConnection(admin as never, row.workspace_id, "daytona"),
    ).rejects.toMatchObject({
      message: "Daytona API URL is not allowed by this Wallie deployment.",
      name: "SandboxConnectionInvalidError",
      provider: "daytona",
    });
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
