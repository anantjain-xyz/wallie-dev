import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { expect, test, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";

const registrationReceipt = z.object({ client: z.object({ id: z.string().uuid() }) });
const tokenReceipt = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
});

test.use({ screenshot: "off", trace: "off" });

function localOrigin(value: string | undefined) {
  const url = new URL(value ?? "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("OAuth browser qualification requires a disposable loopback stack.");
  }
  return url.origin;
}

async function checked<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  return data as NonNullable<T>;
}

function sha256(value: string, encoding: "hex" | "base64url") {
  return createHash("sha256").update(value).digest(encoding);
}

test("registers a client, consents with PKCE, rotates credentials and disconnects", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(process.env.WALLIE_OAUTH_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(65_000);
  const app = localOrigin(baseURL);
  const api = localOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Set the disposable Supabase service key.");
  const admin = createClient<Database>(api, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const slug = `oauth-proof-${randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const clientName = "Release console";
  const account = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (account.error) throw account.error;
  const user = account.data.user;
  let workspaceId: string | undefined;
  let memberContext: BrowserContext | undefined;
  let consentingUserId: string | undefined;
  const callbackReferrers: (string | undefined)[] = [];
  const listener = createServer((request, response) => {
    callbackReferrers.push(request.headers.referer);
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("OAuth fixture callback");
  });

  try {
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("OAuth callback did not bind.");
    const callback = new URL(`http://127.0.0.1:${address.port}/oauth-callback`);

    const workspace = await checked(
      admin.rpc("create_workspace", {
        actor_user_id: user.id,
        actor_email: email,
        requested_slug: slug,
        workspace_name: "OAuth qualification",
      }),
    );
    workspaceId = workspace.id;
    const [factory, member] = await Promise.all([
      checked(
        admin
          .from("factories")
          .select("id, name")
          .eq("workspace_id", workspace.id)
          .eq("is_default", true)
          .single(),
      ),
      checked(
        admin
          .from("workspace_members")
          .select("id")
          .eq("workspace_id", workspace.id)
          .eq("user_id", user.id)
          .single(),
      ),
    ]);
    const ordinal = randomInt(100_000_000, 1_000_000_000);
    const installation = await checked(
      admin
        .from("github_installations")
        .insert({
          app_id: 1,
          installation_id: ordinal,
          installation_url: "https://github.com/apps/oauth-qualification",
          permissions: { contents: "write" },
          target_name: slug,
          target_type: "Organization",
          workspace_id: workspace.id,
        })
        .select("id")
        .single(),
    );
    const repository = await checked(
      admin
        .from("github_repositories")
        .insert({
          workspace_id: workspace.id,
          factory_id: factory.id,
          github_installation_id: installation.id,
          repo_id: ordinal,
          name: "fixture",
          full_name: `${slug}/fixture`,
          html_url: `https://github.com/${slug}/fixture`,
          private: true,
          default_branch: "main",
        })
        .select("id")
        .single(),
    );
    await checked(
      admin
        .from("workspace_onboarding")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          selected_github_repository_id: repository.id,
        })
        .eq("workspace_id", workspace.id),
    );
    const policy = await checked(
      admin.rpc("save_execution_policy", {
        p_workspace_id: workspace.id,
        p_actor_user_id: user.id,
        p_expected_revision: 0,
        p_requirements: {
          version: 1,
          maxRepairAttempts: 2,
          maxExecutionMs: 30_000,
          maxTotalTokens: 1_000,
          maxCostUsd: 1,
        },
      }),
    );
    const scope = {
      p_workspace_id: workspace.id,
      p_factory_id: factory.id,
      p_actor_user_id: user.id,
    };
    const principal = await checked(
      admin.rpc("create_service_principal", {
        ...scope,
        p_name: "Release console principal",
        p_slug: "release-console",
      }),
    );
    const grant = await checked(
      admin.rpc("approve_factory_execution_grant", {
        ...scope,
        p_service_principal_id: principal.id,
        p_github_repository_id: repository.id,
        p_read_context_repository_ids: [],
        p_tool_ids: [],
        p_command_scopes: ["sessions:read"],
        p_execution_policy_revision_id: policy.id,
        p_budget_payer_member_id: member.id,
        p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        p_expected_version: 0,
      }),
    );

    const consentingEmail = `${slug}-member@example.test`;
    const consentingAccount = await admin.auth.admin.createUser({
      email: consentingEmail,
      email_confirm: true,
    });
    if (consentingAccount.error) throw consentingAccount.error;
    consentingUserId = consentingAccount.data.user.id;
    const consentingMember = await checked(
      admin
        .from("workspace_members")
        .insert({
          workspace_id: workspace.id,
          user_id: consentingUserId,
          email: consentingEmail,
          full_name: "Release collaborator",
          kind: "human",
          role: "member",
        })
        .select("id")
        .single(),
    );
    await checked(
      admin.rpc("grant_factory_membership", {
        ...scope,
        p_member_id: consentingMember.id,
        p_role: "member",
      }),
    );

    const governance = `/w/${workspace.slug}/governance`;
    await signInViaMagicLink(page, governance, { baseURL: app, email });
    const clients = page.locator("#oauth-clients");
    await clients.getByLabel("Client name").fill(clientName);
    await clients.getByLabel("Redirect URIs").fill(callback.href);
    await clients.getByLabel(`${factory.name} execution grant`).selectOption(grant.id);
    await clients.getByRole("checkbox", { name: "Read sessions" }).check();
    const registered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/oauth-clients"),
    );
    await clients.getByRole("button", { name: "Register OAuth client", exact: true }).click();
    const registration = await registered;
    expect(registration.status()).toBe(201);
    const clientId = registrationReceipt.parse(await registration.json()).client.id;
    await expect(clients.getByText(clientName, { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("01-registered-oauth-client.png"),
      fullPage: true,
    });

    memberContext = await browser.newContext({ baseURL: app });
    const memberPage = await memberContext.newPage();
    await signInViaMagicLink(memberPage, `/w/${workspace.slug}/sessions`, {
      baseURL: app,
      email: consentingEmail,
    });
    async function consent(capture: boolean) {
      const verifier = randomBytes(32).toString("base64url");
      const state = randomUUID();
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: callback.href,
        scope: "sessions:read",
        code_challenge: sha256(verifier, "base64url"),
        code_challenge_method: "S256",
        state,
      });
      await memberPage.goto(`/oauth/authorize?${query}`);
      await expect(memberPage.getByText(clientName, { exact: true })).toBeVisible();
      await expect(memberPage.getByText("Read sessions", { exact: true }).first()).toBeVisible();
      await memberPage.getByRole("checkbox", { name: factory.name, exact: true }).check();
      if (capture) {
        await memberPage.screenshot({
          path: testInfo.outputPath("02-oauth-consent.png"),
          fullPage: true,
        });
      }
      const decision = memberPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/oauth/authorize/decision",
        { timeout: 10_000 },
      );
      await memberPage
        .getByRole("button", { name: "Allow access", exact: true })
        .click({ timeout: 10_000 });
      expect(
        (await decision).status(),
        "Consent POST must redirect to the registered callback",
      ).toBe(303);

      await memberPage.waitForURL(
        (url) => url.origin === callback.origin && url.pathname === callback.pathname,
        { timeout: 10_000, waitUntil: "domcontentloaded" },
      );
      expect(
        callbackReferrers.at(-1) === undefined,
        "Callback does not receive the consent referrer",
      ).toBe(true);
      const result = new URL(memberPage.url()).searchParams;
      expect(result.get("state")).toBe(state);
      const code = result.get("code");
      if (!code) throw new Error("OAuth callback did not receive an authorization code.");
      return { code, verifier };
    }

    const token = (form: Record<string, string>) =>
      memberPage.request.post(`${app}/oauth/token`, { form: { client_id: clientId, ...form } });
    const exchange = ({ code, verifier }: Awaited<ReturnType<typeof consent>>) =>
      token({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: callback.href,
      });
    const refresh = (value: string) => token({ grant_type: "refresh_token", refresh_token: value });
    const readScope = async (
      value: string,
      command: "sessions:read" | "sessions:cancel" = "sessions:read",
    ) => {
      const credential = /^wallie_oa_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (!credential) throw new Error("OAuth API returned an invalid access credential shape.");
      return admin
        .rpc("authorize_factory_oauth_access_token", {
          p_workspace_id: workspace.id,
          p_factory_id: factory.id,
          p_access_token_id: credential[1],
          p_access_token_digest: sha256(credential[2], "hex"),
          p_scope: command,
        })
        .maybeSingle();
    };
    const pending = await consent(true);
    const wrongProof = await exchange({
      code: pending.code,
      verifier: randomBytes(32).toString("base64url"),
    });
    expect(wrongProof.status()).toBe(400);
    expect(await wrongProof.json()).toMatchObject({ error: "invalid_grant" });
    const exchanged = await exchange(pending);
    expect(exchanged.status()).toBe(200);
    expect(exchanged.headers()["cache-control"]).toContain("no-store");
    const original = tokenReceipt.parse(await exchanged.json());
    const authority = await checked(readScope(original.access_token));
    expect(authority).toMatchObject({ factory_id: factory.id, service_principal_id: principal.id });
    expect((await readScope(original.access_token, "sessions:cancel")).data).toBeNull();

    const rotated = await refresh(original.refresh_token);
    expect(rotated.status()).toBe(200);
    const successor = tokenReceipt.parse(await rotated.json());
    expect(successor.refresh_token !== original.refresh_token).toBe(true);
    const replay = await refresh(original.refresh_token);
    expect(replay.status()).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    const deniedSuccessor = await readScope(successor.access_token);
    expect(deniedSuccessor.data).toBeNull();

    const second = await exchange(await consent(false));
    expect(second.status()).toBe(200);
    const active = tokenReceipt.parse(await second.json());
    expect(await checked(readScope(active.access_token))).toMatchObject({
      execution_grant_id: grant.id,
      execution_grant_version: grant.version,
    });
    await memberPage.goto(`/w/${workspace.slug}/sessions`);
    await memberPage.getByRole("link", { name: "Settings", exact: true }).click();
    await memberPage
      .getByRole("navigation", { name: "Settings categories" })
      .locator(`a[href="/w/${workspace.slug}/settings?category=workspace"]`)
      .click();
    await memberPage.getByRole("link", { name: "Connected clients", exact: true }).click();
    const connections = memberPage.locator("#connected-clients");
    await expect(connections.getByText(clientName, { exact: true }).first()).toBeVisible();
    await memberPage.screenshot({
      path: testInfo.outputPath("03-oauth-connection.png"),
      fullPage: true,
    });
    await connections.getByRole("button", { name: "Disconnect client", exact: true }).click();
    const dialog = memberPage.getByRole("alertdialog");
    const disconnected = memberPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/oauth-clients"),
      { timeout: 10_000 },
    );
    await dialog.getByRole("button", { name: "Disconnect client", exact: true }).click();
    expect((await disconnected).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(connections.getByRole("button", { name: "Disconnect client" })).toHaveCount(0);
    expect((await readScope(active.access_token)).data).toBeNull();
    await memberPage.screenshot({
      path: testInfo.outputPath("04-oauth-disconnected.png"),
      fullPage: true,
    });
  } finally {
    await memberContext?.close();
    if (listener.listening) await once(listener.close(), "close");
    if (workspaceId) await checked(admin.from("workspaces").delete().eq("id", workspaceId));
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw deleted.error;
    if (consentingUserId) {
      const memberDelete = await admin.auth.admin.deleteUser(consentingUserId);
      if (memberDelete.error) throw memberDelete.error;
    }
  }
});
