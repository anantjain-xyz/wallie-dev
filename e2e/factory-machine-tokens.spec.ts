import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";

function localOrigin(value: string | undefined) {
  const url = new URL(value ?? "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Machine token browser qualification requires a disposable loopback stack.");
  }
  return url.origin;
}

async function checked<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  return data as NonNullable<T>;
}

// The one-time credential should never appear in a retained trace or failure screenshot.
test.use({ screenshot: "off", trace: "off" });

test("Governance shows a scoped machine token once and keeps only revocable metadata", async ({
  baseURL,
  page,
}, testInfo) => {
  test.skip(
    process.env.WALLIE_FACTORY_QUALIFICATION !== "1",
    "Requires a disposable local Supabase stack.",
  );
  const api = localOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const app = localOrigin(baseURL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Set the local Supabase service credential.");
  const admin = createClient<Database>(api, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slug = `machine-token-${randomUUID().slice(0, 8)}`;
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
        workspace_name: "Machine token qualification",
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
    const repositoryNumber = randomInt(100_000_000, 1_000_000_000);
    const installation = await checked(
      admin
        .from("github_installations")
        .insert({
          app_id: 1,
          installation_id: repositoryNumber,
          installation_url: "https://github.com/apps/machine-token-fixture",
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
          repo_id: repositoryNumber,
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
    const principal = await checked(
      admin.rpc("create_service_principal", {
        p_workspace_id: workspace.id,
        p_factory_id: factory.id,
        p_actor_user_id: user.id,
        p_name: "Release integration",
        p_slug: "release-integration",
      }),
    );
    const grant = await checked(
      admin.rpc("approve_factory_execution_grant", {
        p_workspace_id: workspace.id,
        p_factory_id: factory.id,
        p_actor_user_id: user.id,
        p_service_principal_id: principal.id,
        p_github_repository_id: repository.id,
        p_read_context_repository_ids: [],
        p_tool_ids: [],
        p_command_scopes: ["sessions:read", "sessions:cancel"],
        p_execution_policy_revision_id: policy.id,
        p_budget_payer_member_id: member.id,
        p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        p_expected_version: 0,
      }),
    );
    const governance = `/w/${workspace.slug}/governance?factory=${factory.id}&grant=${grant.id}`;
    await signInViaMagicLink(page, governance, { baseURL: app, email });
    await page.goto(governance);
    const tokens = page.locator("#machine-tokens");
    await expect(tokens.getByText("No machine tokens on this page.")).toBeVisible();
    await expect(tokens.getByRole("checkbox", { name: "Create sessions" })).toHaveCount(0);
    await tokens.getByLabel("Token name").fill("Release status reader");
    await tokens.getByRole("button", { name: "Create machine token" }).click();
    await expect(
      tokens.getByText("Enter a name and select at least one command scope."),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("01-machine-token-validation.png"),
    });

    await tokens.getByRole("checkbox", { name: "Read sessions" }).check();
    const [issued] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/machine-tokens"),
      ),
      tokens.getByRole("button", { name: "Create machine token" }).click(),
    ]);
    expect(issued.status()).toBe(201);
    expect(issued.headers()["cache-control"]).toBe("private, no-store");
    const secret = tokens.locator("code");
    await expect(secret).toBeVisible();
    expect((await secret.textContent())?.startsWith("wallie_mt_")).toBe(true);
    const listed = tokens.getByRole("article").filter({ hasText: "Release status reader" });
    await expect(listed).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      fullPage: true,
      mask: [secret],
      maskColor: "#687083",
      path: testInfo.outputPath("02-machine-token-one-time-display-redacted.png"),
    });
    await tokens.getByRole("button", { name: "Done" }).click();
    await expect(tokens.locator("code")).toHaveCount(0);

    await page.reload();
    await expect(listed.getByText("Read sessions", { exact: true })).toBeVisible();
    await expect(listed.getByText("Cancel session work", { exact: true })).toHaveCount(0);
    await expect(listed).not.toContainText("wallie_mt_");
    await expect(listed.getByText("Never", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("03-machine-tokens-mobile-dark.png"),
    });

    await listed.getByRole("button", { name: "Revoke token" }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Revoke Release status reader?" });
    await expect(confirmation).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("04-machine-token-revoke-dialog.png"),
    });
    await confirmation.getByRole("button", { name: "Revoke token" }).click();
    await expect(listed.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(listed.getByRole("button", { name: "Revoke token" })).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("05-machine-token-revoked.png"),
    });
  } finally {
    if (workspaceId) await checked(admin.from("workspaces").delete().eq("id", workspaceId));
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw deleted.error;
  }
});
