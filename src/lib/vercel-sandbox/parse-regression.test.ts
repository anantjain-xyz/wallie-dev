import { APIError, Sandbox } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";

import { formatVercelSandboxError } from "./errors";

const NON_JSON_BODY = "1x";
const V110_PARSE_MESSAGE =
  "Can't parse JSON: SyntaxError: Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)";

/**
 * `@vercel/sandbox` 1.10.0 `parse()` in `dist/api-client/base-client.js`
 * JSON.parsed every REST body before it looked at the HTTP status. The
 * production capability check stored only `error.message`, which is this
 * string, and dropped `APIError.text`.
 */
async function parseVercelSandboxV110(response: Response): Promise<APIError<unknown>> {
  const text = await response.text();
  try {
    JSON.parse(text || "{}");
  } catch (error) {
    return new APIError(response, {
      message: `Can't parse JSON: ${String(error)}`,
      text,
    });
  }
  throw new Error("Expected the 1.10.0 parse path to reject a non-JSON body.");
}

describe("Vercel Sandbox response parsing", () => {
  it("reproduces the 1.10.0 parse failure on a non-JSON body", async () => {
    const response = new Response(NON_JSON_BODY, { status: 200 });
    Object.defineProperty(response, "url", {
      value: "https://vercel.com/api/v1/sandboxes/sb/cmd",
    });

    const error = await parseVercelSandboxV110(response);

    expect(error).toBeInstanceOf(APIError);
    expect(error.message).toBe(V110_PARSE_MESSAGE);
    expect(error.message).not.toContain(NON_JSON_BODY);
    expect(error.text).toBe(NON_JSON_BODY);
    expect(error.response.status).toBe(200);
  });

  it("accepts a v2 list response and still reports a non-JSON body with its text", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({ method, url });
      if (url.includes("non-json")) {
        const response = new Response(NON_JSON_BODY, { status: 200 });
        Object.defineProperty(response, "url", { value: url });
        Object.defineProperty(response, "method", { value: method });
        return response;
      }
      const response = new Response(
        JSON.stringify({ pagination: { count: 0, next: null }, sandboxes: [] }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const credentials = {
      fetch: fetchImpl,
      limit: 1,
      projectId: "prj_test",
      teamId: "team_test",
      token: "vca_testtoken",
    };

    const listed = await Sandbox.list(credentials);

    expect(listed.sandboxes).toEqual([]);
    expect(requests[0]?.url).toContain("/v2/sandboxes");
    expect(requests[0]?.url).not.toContain("/v1/sandboxes");
    expect(requests[0]?.method).toBe("GET");

    const nonJsonFetch: typeof fetch = async (input, init) => {
      const url = `${input instanceof Request ? input.url : input.toString()}&non-json=1`;
      return fetchImpl(url, init);
    };
    const failure = await Sandbox.list({ ...credentials, fetch: nonJsonFetch }).then(
      () => {
        throw new Error("Expected the v2 client to reject a non-JSON body.");
      },
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      message: V110_PARSE_MESSAGE,
      text: NON_JSON_BODY,
    });
    const formatted = formatVercelSandboxError(failure);
    expect(formatted).toContain(`body: ${NON_JSON_BODY}`);
    expect(formatted).toContain("GET");
    expect(formatted).toContain("/v2/sandboxes");
  });
});
