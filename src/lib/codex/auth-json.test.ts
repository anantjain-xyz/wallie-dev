import { describe, expect, it } from "vitest";

import { parseCodexChatGptAuthJson } from "@/lib/codex/auth-json";

function unsignedJwt(payload: Record<string, unknown>) {
  return [
    "header",
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
    "signature",
  ].join(".");
}

describe("parseCodexChatGptAuthJson", () => {
  it("validates Codex ChatGPT auth cache and extracts metadata", () => {
    const result = parseCodexChatGptAuthJson(
      JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: "2026-05-19T00:00:00.000Z",
        tokens: {
          access_token: "access-token-value-1234567890",
          id_token: unsignedJwt({ email: "person@example.com", sub: "acct-1" }),
          refresh_token: "refresh-token-value-1234567890",
        },
      }),
    );

    expect(result).toEqual({
      accountEmail: "person@example.com",
      accountId: "acct-1",
      lastRefresh: "2026-05-19T00:00:00.000Z",
    });
  });

  it("rejects API-key auth caches", () => {
    expect(() =>
      parseCodexChatGptAuthJson(
        JSON.stringify({
          auth_mode: "api_key",
          tokens: {
            access_token: "access-token-value-1234567890",
            refresh_token: "refresh-token-value-1234567890",
          },
        }),
      ),
    ).toThrow(/chatgpt/);
  });
});
