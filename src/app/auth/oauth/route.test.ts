import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { GET } from "@/app/auth/oauth/route";

describe("GET /auth/oauth", () => {
  it.each(["google", "github"])(
    "rejects %s social auth requests without starting OAuth",
    async (provider) => {
      const response = await GET(
        new NextRequest(`http://localhost:3000/auth/oauth?provider=${provider}&next=%2Fw%2Facme`),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/login?next=%2Fw%2Facme&error=invalid_provider",
      );
    },
  );
});
