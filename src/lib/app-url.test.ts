import { describe, expect, it } from "vitest";

import { buildAppUrl, resolveAppOrigin, resolveAppUrl } from "@/lib/app-url";

describe("app URL helpers", () => {
  it("resolves the configured app origin without path, search, or hash", () => {
    const input = {
      NEXT_PUBLIC_APP_URL: "https://www.wallie.dev/some/path?query=1#section",
    };

    expect(resolveAppUrl(input).toString()).toBe("https://www.wallie.dev/");
    expect(resolveAppOrigin(input)).toBe("https://www.wallie.dev");
  });

  it("builds app URLs from the configured origin", () => {
    expect(
      buildAppUrl("/auth/confirm?next=%2F", {
        NEXT_PUBLIC_APP_URL: "https://www.wallie.dev",
      }).toString(),
    ).toBe("https://www.wallie.dev/auth/confirm?next=%2F");
  });
});
