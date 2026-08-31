import { describe, expect, it } from "vitest";

import { validateSandboxConnection } from "./index";

const e2bApiKey = process.env.E2B_API_KEY;
const daytonaApiKey = process.env.DAYTONA_API_KEY;

describe.runIf(Boolean(e2bApiKey))("E2B live smoke", () => {
  it("validates the configured managed-service account", async () => {
    const result = await validateSandboxConnection({
      credentials: { apiKey: e2bApiKey! },
      provider: "e2b",
      revision: "live-smoke",
    });

    expect(result).toEqual({ ok: true });
  });
});

describe.runIf(Boolean(daytonaApiKey))("Daytona live smoke", () => {
  it("validates the configured cloud or self-hosted account", async () => {
    const result = await validateSandboxConnection({
      credentials: {
        apiKey: daytonaApiKey!,
        apiUrl: process.env.DAYTONA_API_URL,
        target: process.env.DAYTONA_TARGET,
      },
      provider: "daytona",
      revision: "live-smoke",
    });

    expect(result).toEqual({ ok: true });
  });
});
