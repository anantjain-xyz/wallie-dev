import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  factories: vi.fn(),
  rpc: vi.fn(),
  redirect: vi.fn<(location: string) => never>(() => {
    throw new Error("redirect");
  }),
}));
vi.mock("@/lib/factory-oauth/browser-auth", () => ({
  authenticateFactoryOAuthBrowser: mocks.actor,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          in: (idColumn: string, ids: string[]) =>
            mocks.factories(table, columns, column, value, idColumn, ids),
        }),
      }),
    }),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import FactoryOAuthAuthorizePage from "./page";
import AuthorizeLayout from "./layout";
import OAuthRecoveryPage from "./recover/page";

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
  mocks.actor.mockResolvedValue({ id: "user", sessionId: "session", email: "member@example.test" });
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
  expect(html).toContain("Signed in as");
  expect(html).toContain("member@example.test");
  expect(html).toContain("Use a different account");
  expect(html).toContain("Choose factories");
  expect(html).toContain("The app gets all listed actions for each factory you select.");
  expect(html).not.toContain("What this app can do");
  expect(html).toContain("If you deny, no access is granted.");
  expect(html).toContain(`aria-describedby="scopes-${readFactory}"`);
  expect(html).toMatch(new RegExp(`id="scopes-${readFactory}"[^>]*>.*?Read sessions.*?</ul>`));
  expect(html).toContain(`aria-describedby="scopes-${cancelFactory}"`);
  expect(html).toMatch(
    new RegExp(`id="scopes-${cancelFactory}"[^>]*>.*?Cancel session work.*?</ul>`),
  );
  expect(html).not.toContain('checked=""');
  expect(mocks.factories).not.toHaveBeenCalled();
});

it("disambiguates equal factory names with slugs visible to this account", async () => {
  mocks.rpc.mockReturnValue({
    single: async () => ({
      data: {
        authorization_id: "56800000-0000-4000-8000-000000000003",
        client_name: "Release tools",
        workspace_id: workspace,
        workspace_name: "Northwind",
        factories: [
          { factory_id: readFactory, name: "Release", scopes: ["sessions:read"] },
          { factory_id: cancelFactory, name: "Release", scopes: ["sessions:cancel"] },
        ],
      },
      error: null,
    }),
  });
  mocks.factories.mockResolvedValue({
    data: [
      { id: readFactory, slug: "release-public" },
      { id: cancelFactory, slug: "release-internal" },
    ],
    error: null,
  });
  const html = renderToStaticMarkup(await authorization());
  expect(html).toContain("(release-public)");
  expect(html).toContain("(release-internal)");
  expect(mocks.factories).toHaveBeenCalledExactlyOnceWith(
    "factories",
    "id,slug",
    "workspace_id",
    workspace,
    "id",
    [readFactory, cancelFactory],
  );
});

it("shows the exact factory and actions before decisions, with resource and issuer in details", async () => {
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
  expect(html).not.toContain("What this app can do");
  expect(html).toMatch(/<details[^>]*>.*?Technical details/);
  expect(html.indexOf("Read sessions")).toBeLessThan(html.indexOf("Allow access"));
  expect(html.indexOf("Allow access")).toBeLessThan(html.indexOf("Technical details"));
  expect(html.slice(0, html.indexOf("<details"))).not.toContain(">Resource<");
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
  expect(renderToStaticMarkup(await authorization(invalid))).toContain("Start authorization again");
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

it("composes the consent render inside one focusable main landmark", async () => {
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

  const html = renderToStaticMarkup(<AuthorizeLayout>{await authorization()}</AuthorizeLayout>);
  expect(html.match(/id="main-content"/g)).toHaveLength(1);
  expect(html).toContain('tabindex="-1"');
  expect(html).toContain("Review app access");
  expect(html).toContain("Release tools");
  expect(html).toContain("Customer tools");
});

it("composes the unavailable render inside one focusable main landmark", async () => {
  mocks.rpc.mockReturnValue({
    single: async () => ({ data: null, error: { code: "42501" } }),
  });

  const html = renderToStaticMarkup(<AuthorizeLayout>{await authorization()}</AuthorizeLayout>);
  expect(html.match(/id="main-content"/g)).toHaveLength(1);
  expect(html).toContain('tabindex="-1"');
  expect(html).toContain("Start authorization again");
  expect(html).toContain("Return to the app that requested access and connect again.");
  expect(html).toContain("Use a different account");
  expect(html).toContain('action="/auth/signout"');
  expect(html).toContain('name="switchAccount" value="1"');
  expect(html).toContain('name="next" value="/oauth/authorize?');
  expect(html).not.toContain('href="https://client.example.test');
});

it("tells people how to restart a malformed request without offering a redirect", async () => {
  const html = renderToStaticMarkup(
    await FactoryOAuthAuthorizePage({ searchParams: Promise.resolve({}) }),
  );
  expect(html).toContain("Start authorization again");
  expect(html).toContain("Return to the app that requested access and connect again.");
  expect(html).not.toContain("Use a different account");
  expect(html).not.toContain('href="');
  expect(mocks.actor).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("offers sign-in without inventing an OAuth resume target after sign-out", async () => {
  const html = renderToStaticMarkup(
    await OAuthRecoveryPage({ searchParams: Promise.resolve({ reason: "signed_out" }) }),
  );
  expect(html).toContain("Start authorization again");
  expect(html).toMatch(/href="\/login"[^>]*>Sign in to Wallie/);
  expect(html).not.toContain("Use a different account");
  expect(html).not.toContain('name="next"');
});
