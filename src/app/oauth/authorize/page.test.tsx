import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  rpc: vi.fn(),
  redirect: vi.fn<(location: string) => never>(() => {
    throw new Error("redirect");
  }),
}));
vi.mock("@/lib/factory-oauth/browser-auth", () => ({
  authenticateFactoryOAuthBrowser: mocks.actor,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import FactoryOAuthAuthorizePage from "./page";

const issuer = "https://wallie.example.test";
const workspace = "56800000-0000-4000-8000-000000000005";
const readFactory = "56800000-0000-4000-8000-000000000001";
const cancelFactory = "56800000-0000-4000-8000-000000000002";
const target = `${issuer}/api/v1/workspaces/${workspace}/factories/${readFactory}/mcp`;

function authorization(resource?: string | string[]) {
  return FactoryOAuthAuthorizePage({
    searchParams: Promise.resolve({
      response_type: "code",
      client_id: "56800000-0000-4000-8000-000000000004",
      redirect_uri: "https://client.example.test/callback",
      scope: "sessions:read sessions:cancel",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "client state",
      resource,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", issuer);
  mocks.actor.mockResolvedValue({ id: "user", sessionId: "session" });
});

afterEach(() => vi.unstubAllEnvs());

it("shows the exact offered scopes next to each selectable factory", async () => {
  mocks.rpc.mockReturnValue({
    single: async () => ({
      data: {
        authorization_id: "56800000-0000-4000-8000-000000000003",
        client_name: "Release tools",
        workspace_id: workspace,
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

  const html = renderToStaticMarkup(await authorization());
  expect(html).toContain(`aria-describedby="scopes-${readFactory}"`);
  expect(html).toContain(`id="scopes-${readFactory}">Read sessions</p>`);
  expect(html).toContain(`aria-describedby="scopes-${cancelFactory}"`);
  expect(html).toContain(`id="scopes-${cancelFactory}">Cancel session work</p>`);
});

it("shows the exact factory, resource and issuer without a selectable factory", async () => {
  mocks.rpc.mockReturnValue({
    single: async () => ({
      data: {
        authorization_id: "56800000-0000-4000-8000-000000000003",
        client_name: "Release tools",
        workspace_id: workspace,
        workspace_name: "Northwind",
        factories: [{ factory_id: readFactory, name: "Customer tools", scopes: ["sessions:read"] }],
      },
      error: null,
    }),
  });
  const html = renderToStaticMarkup(await authorization(target));
  expect(mocks.rpc).toHaveBeenCalledWith(
    "begin_factory_oauth_authorization",
    expect.objectContaining({ p_resource: target }),
  );
  expect(html).toContain(`type="hidden" name="factoryIds" value="${readFactory}"`);
  expect(html).toContain("Customer tools");
  expect(html).toContain("Read sessions");
  expect(html).toContain(target);
  expect(html).toContain(`>${issuer}</dd>`);
  expect(html).not.toContain('type="checkbox"');
});

it("retains the exact configured resource through sign-in", async () => {
  mocks.actor.mockResolvedValueOnce(null);
  await expect(authorization(target)).rejects.toThrow("redirect");
  const login = new URL(mocks.redirect.mock.calls[0]![0], issuer);
  const next = login.searchParams.get("next");
  expect(login.pathname).toBe("/login");
  expect(next).not.toBeNull();
  expect(new URL(next!, issuer).searchParams.get("resource")).toBe(target);
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("sends invalid_target only after the exact registered callback passes database validation", async () => {
  mocks.rpc
    .mockReturnValueOnce({
      single: async () => ({ data: null, error: { code: "42501" } }),
    })
    .mockReturnValueOnce({
      single: async () => ({ data: null, error: { code: "PT400" } }),
    });

  const invalid = [target, target];
  expect(renderToStaticMarkup(await authorization(invalid))).toContain(
    "This authorization request is unavailable.",
  );
  expect(mocks.redirect).not.toHaveBeenCalled();
  await expect(authorization(invalid)).rejects.toThrow("redirect");
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    "begin_factory_oauth_authorization",
    expect.objectContaining({ p_resource: "" }),
  );
  const callback = new URL(mocks.redirect.mock.calls[0]![0]);
  expect(callback.origin + callback.pathname).toBe("https://client.example.test/callback");
  expect(Object.fromEntries(callback.searchParams)).toEqual({
    error: "invalid_target",
    state: "client state",
    iss: issuer,
  });
});
