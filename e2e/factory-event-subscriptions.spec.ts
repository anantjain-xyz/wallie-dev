import { randomBytes, randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";

async function checked<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  return data as NonNullable<T>;
}

function localOrigin(value: string | undefined) {
  const url = new URL(value ?? "");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Event subscription qualification requires a disposable loopback stack.");
  }
  return url.origin;
}

// Keep credentials out of browser traces and automatic failure screenshots.
test.use({ screenshot: "off", trace: "off" });

test("Governance manages receiver metadata and shows the signing secret only once", async ({
  baseURL,
  page,
}, testInfo) => {
  test.skip(process.env.WALLIE_EVENT_SUBSCRIPTIONS_E2E !== "1", "Requires a disposable stack.");
  test.setTimeout(90_000);
  const app = localOrigin(baseURL);
  const api = localOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Set the disposable Supabase service credential.");
  const admin = createClient<Database>(api, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slug = `outbound-${randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const account = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (account.error) throw account.error;
  const { user } = account.data;
  let workspaceId: string | undefined;
  try {
    const workspace = await checked(
      admin.rpc("create_workspace", {
        actor_user_id: user.id,
        actor_email: email,
        requested_slug: slug,
        workspace_name: "Release Engineering",
      }),
    );
    workspaceId = workspace.id;
    const factory = await checked(
      admin
        .from("factories")
        .select("id")
        .eq("workspace_id", workspace.id)
        .eq("is_default", true)
        .single(),
    );
    const member = await checked(
      admin
        .from("workspace_members")
        .select("id")
        .eq("workspace_id", workspace.id)
        .eq("user_id", user.id)
        .single(),
    );
    const target = randomInt(100_000_000, 1_000_000_000);
    const installation = await checked(
      admin
        .from("github_installations")
        .insert({
          app_id: 1,
          installation_id: target,
          installation_url: "https://github.com/apps/release-fixture",
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
          factory_id: factory.id,
          workspace_id: workspace.id,
          github_installation_id: installation.id,
          repo_id: target,
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
          maxExecutionMs: 30000,
          maxTotalTokens: 1000,
          maxCostUsd: 1,
        },
      }),
    );
    const authority = {
      p_workspace_id: workspace.id,
      p_factory_id: factory.id,
      p_actor_user_id: user.id,
    };
    const principal = await checked(
      admin.rpc("create_service_principal", {
        ...authority,
        p_name: "Release integration",
        p_slug: "release-integration",
      }),
    );
    const grant = await checked(
      admin.rpc("approve_factory_execution_grant", {
        ...authority,
        p_service_principal_id: principal.id,
        p_github_repository_id: repository.id,
        p_read_context_repository_ids: [],
        p_tool_ids: [],
        p_command_scopes: ["sessions:read"],
        p_execution_policy_revision_id: policy.id,
        p_budget_payer_member_id: member.id,
        p_expected_version: 0,
        p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const tokenId = randomUUID();
    await checked(
      admin.rpc("issue_factory_machine_token", {
        ...authority,
        p_grant_id: grant.id,
        p_grant_version: grant.version,
        p_token_id: tokenId,
        p_digest: randomBytes(32).toString("hex"),
        p_name: "Release status reader",
        p_scopes: ["sessions:read"],
      }),
    );

    const governance = `/w/${workspace.slug}/governance?factory=${factory.id}#event-subscriptions`;
    await signInViaMagicLink(page, governance, { baseURL: app, email });
    await page.goto(governance);
    const events = page.locator("#event-subscriptions");
    await expect(events.getByRole("heading", { name: "Event subscriptions" })).toBeVisible();
    await events.getByLabel("Name", { exact: true }).fill("Release reporting");
    await events.getByLabel("HTTPS endpoint").fill("https://receiver.example.com/wallie");
    await events
      .getByRole("combobox", { name: "Authorization", exact: true })
      .selectOption(`machine_token:${tokenId}`);
    await events.getByRole("checkbox", { name: "Review ready" }).check();
    await events.getByRole("checkbox", { name: "Review approved" }).check();
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/event-subscriptions"),
    );
    await events.getByRole("button", { name: "Create subscription" }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(response.headers()["cache-control"]).toBe("private, no-store");

    const secretRegion = events.getByRole("region", { name: "Signing secret" });
    await expect(secretRegion).toBeVisible();
    await expect(secretRegion.getByRole("button", { name: "Copy secret" })).toBeFocused();
    const secret = secretRegion.locator("code");
    expect((await secret.textContent())?.length).toBe(43);
    const receiver = events.getByRole("listitem").filter({ hasText: "Release reporting" });
    await expect(receiver.getByText("Awaiting verification", { exact: false })).toBeVisible();
    await events.screenshot({
      animations: "disabled",
      mask: [secret],
      path: testInfo.outputPath("01-event-subscriptions.png"),
    });

    await secretRegion.getByRole("button", { name: "Dismiss secret" }).click();
    await expect(secretRegion).toHaveCount(0);
    await page.reload();
    await expect(secretRegion).toHaveCount(0);
    await receiver.getByRole("button", { name: "Inspect deliveries" }).click();
    await expect(receiver.getByText("No deliveries on this page.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await receiver.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("02-event-deliveries-mobile-dark.png"),
    });

    await receiver.getByRole("button", { name: "Revoke subscription" }).click();
    await page
      .getByRole("alertdialog", { name: "Revoke Release reporting?" })
      .getByRole("button", { name: "Revoke subscription" })
      .click();
    await expect(receiver.getByText("Revoked", { exact: false })).toBeVisible();
    await expect(receiver.getByRole("button", { name: "Verify endpoint" })).toHaveCount(0);
  } finally {
    if (workspaceId) await checked(admin.from("workspaces").delete().eq("id", workspaceId));
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw deleted.error;
  }
});
