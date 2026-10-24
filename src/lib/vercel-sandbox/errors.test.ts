import { APIError } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";

import { formatVercelSandboxError } from "./errors";

describe("formatVercelSandboxError", () => {
  it("recognizes errors from the SDK's separate CommonJS export", () => {
    const { APIError: CommonJSAPIError } = createRequire(import.meta.url)("@vercel/sandbox");
    const error = new CommonJSAPIError(new Response(null, { status: 403 }), {
      message: "Status code 403 is not ok",
      json: { error: { code: "forbidden", message: "The saved token is invalid." } },
    });

    expect(formatVercelSandboxError(error)).toContain(
      "(403; forbidden): The saved token is invalid.",
    );
  });

  it("reports the provider's rejection reason and code", () => {
    const error = new APIError(new Response(null, { status: 403 }), {
      message: "Status code 403 is not ok",
      json: { error: { code: "forbidden", message: "This token cannot create sandboxes." } },
    });

    expect(formatVercelSandboxError(error)).toBe(
      "Vercel Sandbox request failed (403; forbidden): This token cannot create sandboxes.",
    );
  });

  it("redacts credentials and excludes other response fields", () => {
    const error = new APIError(new Response(null, { status: 403 }), {
      json: {
        error: {
          code: "forbidden",
          message: "Token vca_secret cannot clone with ghs_token.",
          request: { password: "do-not-persist" },
        },
      },
    });

    expect(formatVercelSandboxError(error, ["vca_secret", "ghs_token"])).toBe(
      "Vercel Sandbox request failed (403; forbidden): Token [REDACTED] cannot clone with [REDACTED].",
    );
  });

  it("gives actionable guidance when Vercel omits a rejection reason", () => {
    const error = new APIError(new Response(null, { status: 403 }), {
      message: "Status code 403 is not ok",
    });

    expect(formatVercelSandboxError(error)).toBe(
      "Vercel Sandbox request failed (403): Check the saved Vercel token, its team access, and the connected project.",
    );
  });

  it("supports top-level provider errors and ordinary errors", () => {
    const error = new APIError(new Response(null, { status: 402 }), {
      json: { code: "payment_required", message: "Sandbox usage is paused." },
    });
    expect(formatVercelSandboxError(error)).toContain(
      "(402; payment_required): Sandbox usage is paused.",
    );
    expect(formatVercelSandboxError(new Error("Request aborted"))).toBe("Request aborted");
  });
});
import { createRequire } from "node:module";
