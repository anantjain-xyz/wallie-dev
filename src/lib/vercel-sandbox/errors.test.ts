import { createRequire } from "node:module";

import { APIError } from "@vercel/sandbox";
import { describe, expect, it, vi } from "vitest";

import { formatVercelSandboxError, vercelSandboxFetch } from "./errors";

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
      [
        "Vercel Sandbox request failed (403; forbidden): This token cannot create sandboxes.",
        'body: {"error":{"code":"forbidden","message":"This token cannot create sandboxes."}}',
      ].join("\n"),
    );
  });

  it("redacts credentials inside the provider message and response body", () => {
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
      [
        "Vercel Sandbox request failed (403; forbidden): Token [REDACTED] cannot clone with [REDACTED].",
        'body: {"error":{"code":"forbidden","message":"Token [REDACTED] cannot clone with [REDACTED].","request":{"password":"[REDACTED]"}}}',
      ].join("\n"),
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

  it("records the request method, url, status, and a redacted truncated body", async () => {
    const token = "vca_1234567890abcdef";
    const body = `1x ${"a".repeat(3_000)} ${token}`;
    const response = new Response(body, { status: 502 });
    Object.defineProperty(response, "url", {
      value: `https://vercel.com/api/v1/sandboxes/sb/cmd?token=${token}`,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const traced = await vercelSandboxFetch("https://vercel.com/api/v1/sandboxes/sb/cmd", {
      method: "post",
    });
    fetchMock.mockRestore();

    const error = new APIError(traced, {
      message:
        "Can't parse JSON: SyntaxError: Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)",
      text: body,
    });
    const formatted = formatVercelSandboxError(error);

    expect(formatted).toContain(
      "Vercel Sandbox request failed (502 POST https://vercel.com/api/v1/sandboxes/sb/cmd?token=[REDACTED])",
    );
    expect(formatted).toContain("Can't parse JSON:");
    expect(formatted).not.toContain(token);
    const bodyLine = formatted.split("\n").find((line) => line.startsWith("body: "));
    expect(bodyLine).toBeDefined();
    expect(bodyLine!.endsWith("...")).toBe(true);
    expect(bodyLine!.length).toBeLessThanOrEqual("body: ".length + 2_048 + 3);
  });
});
