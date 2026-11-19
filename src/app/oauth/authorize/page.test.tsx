import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/factory-oauth/browser-auth", () => ({
  authenticateFactoryOAuthBrowser: async () => ({ id: "user", sessionId: "session" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));

import FactoryOAuthAuthorizePage from "./page";

it("shows the exact offered scopes next to each selectable factory", async () => {
  const readFactory = "56800000-0000-4000-8000-000000000001";
  const cancelFactory = "56800000-0000-4000-8000-000000000002";
  mocks.rpc.mockReturnValue({
    single: async () => ({
      data: {
        authorization_id: "56800000-0000-4000-8000-000000000003",
        client_name: "Release tools",
        workspace_name: "Northwind",
        scopes: ["sessions:read", "sessions:cancel"],
        factories: [
          { factory_id: readFactory, name: "Customer tools", scopes: ["sessions:read"] },
          { factory_id: cancelFactory, name: "Batch jobs", scopes: ["sessions:cancel"] },
        ],
      },
      error: null,
    }),
  });

  const html = renderToStaticMarkup(
    await FactoryOAuthAuthorizePage({
      searchParams: Promise.resolve({
        response_type: "code",
        client_id: "56800000-0000-4000-8000-000000000004",
        redirect_uri: "https://client.example.test/callback",
        scope: "sessions:read sessions:cancel",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      }),
    }),
  );
  expect(html).toContain(`aria-describedby="scopes-${readFactory}"`);
  expect(html).toContain(`id="scopes-${readFactory}">Read sessions</p>`);
  expect(html).toContain(`aria-describedby="scopes-${cancelFactory}"`);
  expect(html).toContain(`id="scopes-${cancelFactory}">Cancel session work</p>`);
});
