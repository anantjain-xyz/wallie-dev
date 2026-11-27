import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { signInViaMagicLink } from "./helpers/auth";

type Admin = SupabaseClient<Database>;

function localOrigin(value: string | undefined) {
  if (!value) throw new Error("Set a disposable local app and Supabase URL.");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Inbox qualification requires loopback services.");
  return url.origin;
}

async function read<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  if (data == null) throw new Error("Inbox fixture row is missing.");
  return data;
}

async function write(operation: PromiseLike<{ error: unknown }>) {
  const { error } = await operation;
  if (error) throw error;
}

async function publishFixture(
  admin: Admin,
  session: { id: string; workspace_id: string },
  stage: { id: string; slug: string },
  version: number,
  body: string,
) {
  const artifact = await read(
    admin
      .from("session_artifacts")
      .insert({
        session_id: session.id,
        workspace_id: session.workspace_id,
        stage_id: stage.id,
        stage_slug: stage.slug,
        version,
        artifact_json: body,
      })
      .select("id")
      .single(),
  );
  await write(
    admin
      .from("sessions")
      .update({
        current_artifact_id: artifact.id,
        current_artifact_version: version,
        phase_status: "awaiting_review",
      })
      .eq("id", session.id)
      .eq("workspace_id", session.workspace_id),
  );
  return artifact;
}

async function seedReview(
  admin: Admin,
  input: {
    workspaceId: string;
    factoryId: string;
    number: number;
    title: string;
    restricted?: boolean;
  },
) {
  const pipeline = await read(
    admin
      .from("pipelines")
      .insert({ workspace_id: input.workspaceId, factory_id: input.factoryId, name: input.title })
      .select("id")
      .single(),
  );
  const stage = await read(
    admin
      .from("pipeline_stages")
      .insert({
        workspace_id: input.workspaceId,
        pipeline_id: pipeline.id,
        name: "Verify",
        slug: "verify",
        position: 1,
        anyone_can_approve: !input.restricted,
      })
      .select("id,slug")
      .single(),
  );
  const session = await read(
    admin
      .from("sessions")
      .insert({
        workspace_id: input.workspaceId,
        factory_id: input.factoryId,
        pipeline_id: pipeline.id,
        current_stage_id: stage.id,
        number: input.number,
        title: input.title,
      })
      .select("id,workspace_id")
      .single(),
  );
  await write(
    admin
      .from("session_selected_stages")
      .upsert(
        { session_id: session.id, workspace_id: input.workspaceId, stage_id: stage.id },
        { ignoreDuplicates: true },
      ),
  );
  const body = `Original output for ${input.title}.`;
  const artifact = await publishFixture(admin, session, stage, 1, body);
  return { session, stage, artifact, body };
}

test("Inbox opens exact reviews and reconciles supersession, approval and access loss", async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(process.env.WALLIE_INBOX_E2E !== "1", "Requires a disposable local Supabase stack.");
  test.setTimeout(90_000);
  const app = localOrigin(baseURL);
  const supabaseUrl = localOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Set the disposable Supabase service key.");
  const admin = createClient<Database>(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slug = `inbox-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `${slug}-owner@example.test`;
  const memberEmail = `${slug}-reviewer@example.test`;
  const users: string[] = [];
  let workspaceId: string | undefined;
  async function createUser(email: string) {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    users.push(data.user.id);
    return data.user.id;
  }

  try {
    const owner = await createUser(ownerEmail);
    const reviewer = await createUser(memberEmail);
    const workspace = await read(
      admin.rpc("create_workspace", {
        actor_user_id: owner,
        actor_email: ownerEmail,
        requested_slug: slug,
        workspace_name: "Harbor Studio",
      }),
    );
    workspaceId = workspace.id;
    const member = await read(
      admin
        .from("workspace_members")
        .insert({
          kind: "human",
          email: memberEmail,
          full_name: "Jamie Sample",
          role: "member",
          user_id: reviewer,
          workspace_id: workspace.id,
        })
        .select("id")
        .single(),
    );
    const primary = await read(
      admin
        .from("factories")
        .select("id")
        .eq("workspace_id", workspace.id)
        .eq("is_default", true)
        .single(),
    );
    const createFactory = (name: string, factorySlug: string) =>
      read(
        admin.rpc("create_factory", {
          p_workspace_id: workspace.id,
          p_actor_user_id: owner,
          p_name: name,
          p_slug: factorySlug,
        }),
      );
    const delegated = await createFactory("Customer Tools", "customer-tools");
    const confidential = await createFactory("Confidential Factory", "confidential-factory");
    const membership = {
      p_workspace_id: workspace.id,
      p_factory_id: delegated.id,
      p_actor_user_id: owner,
      p_member_id: member.id,
    };
    await write(admin.rpc("grant_factory_membership", { ...membership, p_role: "member" }));
    await write(
      admin
        .from("workspace_onboarding")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspace.id),
    );

    const defaultTitle = "Review the delivery checklist";
    const delegatedTitle = "Review the invitation settings";
    const defaultReview = await seedReview(admin, {
      workspaceId: workspace.id,
      factoryId: primary.id,
      number: 1,
      title: defaultTitle,
    });
    const delegatedReview = await seedReview(admin, {
      workspaceId: workspace.id,
      factoryId: delegated.id,
      number: 2,
      title: delegatedTitle,
    });
    await seedReview(admin, {
      workspaceId: workspace.id,
      factoryId: delegated.id,
      number: 3,
      title: "Directors only",
      restricted: true,
    });
    await seedReview(admin, {
      workspaceId: workspace.id,
      factoryId: confidential.id,
      number: 4,
      title: "Private draft",
    });

    const workspacePath = `/w/${workspace.slug}`;
    const allInboxHref = `${workspacePath}/inbox?factory=all`;
    const main = page.getByRole("main");
    const rail = page.getByRole("navigation", { name: "Workspace navigation" });
    const inbox = rail.getByRole("link", { name: "Inbox", exact: true });
    const factory = page.getByRole("combobox", { name: "Factory", exact: true });
    const defaultLink = main.getByRole("link", { name: defaultTitle, exact: true });
    const delegatedLink = main.getByRole("link", { name: delegatedTitle, exact: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, `${workspacePath}/sessions`, {
      baseURL: app,
      email: memberEmail,
    });
    await expect(inbox).toHaveAttribute("href", `${workspacePath}/inbox?factory=${primary.id}`);
    await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/factories/inbox" && response.ok(),
      ),
      inbox.press("Enter"),
    ]);
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    await expect(factory).toHaveAttribute("data-value", primary.id);
    await factory.press("Enter");
    await factory.press("Home");
    await factory.press("Enter");
    await expect(page).toHaveURL(allInboxHref);
    await expect(factory).toHaveText("All factories");
    await expect(factory).toHaveAttribute("data-value", "all");
    const itemTypes = main.getByRole("navigation", { name: "Inbox item type" });
    await expect(itemTypes.getByRole("link", { name: "All items 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(itemTypes.getByRole("link", { name: "Clarifications 0" })).toBeVisible();
    await expect(delegatedLink).toBeVisible();
    await expect(main.getByText("Directors only", { exact: true })).toHaveCount(0);
    await expect(main.getByText("Private draft", { exact: true })).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("01-inbox-desktop-light.png"),
    });

    const aggregateReviewHref = await delegatedLink.getAttribute("href");
    if (!aggregateReviewHref) throw new Error("Missing the aggregate Inbox review link.");
    const aggregateReview = new URL(aggregateReviewHref, app);
    expect(aggregateReview.pathname).toBe(`${workspacePath}/sessions/2`);
    expect(Object.fromEntries(aggregateReview.searchParams)).toMatchObject({
      artifactStage: delegatedReview.stage.slug,
      artifactId: delegatedReview.artifact.id,
      artifactVersion: "1",
      reviewStageId: delegatedReview.stage.id,
      returnTo: allInboxHref,
    });
    await delegatedLink.press("Enter");
    await expect(page).toHaveURL(aggregateReview.href);
    await expect(inbox).toHaveAttribute("href", allInboxHref);
    await expect(rail.getByRole("link", { name: "Activity", exact: true })).toHaveAttribute(
      "href",
      `${workspacePath}/runs?factory=${delegated.id}`,
    );
    await inbox.press("Enter");
    await expect(page).toHaveURL(allInboxHref);

    const originalHref = await defaultLink.getAttribute("href");
    if (!originalHref) throw new Error("Missing the original exact review link.");
    expect(new URL(originalHref, app).searchParams.get("artifactId")).toBe(
      defaultReview.artifact.id,
    );
    expect(new URL(originalHref, app).searchParams.get("returnTo")).toBe(allInboxHref);
    // Require the new item well before the periodic access recheck could update it.
    const replacement = await publishFixture(
      admin,
      defaultReview.session,
      defaultReview.stage,
      2,
      "Updated delivery checklist.",
    );
    await expect(defaultLink).toHaveAttribute(
      "href",
      new RegExp(`artifactId=${replacement.id}.*artifactVersion=2`),
      {
        timeout: 8_000,
      },
    );

    const stale = await context.newPage();
    await stale.goto(originalHref);
    await expect(stale.getByText(defaultReview.body, { exact: true })).toBeVisible();
    await expect(stale.getByText("This review link is no longer current.")).toBeVisible();
    await expect(stale.getByRole("button", { name: /^Approve / })).toHaveCount(0);
    await stale.close();

    await defaultLink.press("Enter");
    const approval = page.getByRole("button", { name: /^Approve / });
    await expect(approval).toBeEnabled();
    const fullArtifact = page.getByRole("tab", { name: "Full artifact" });
    if (await fullArtifact.count()) await fullArtifact.click();
    await expect(page.getByText("Updated delivery checklist.", { exact: true })).toBeVisible();
    await approval.click();
    await expect(page.getByText("Review approved.", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(itemTypes.getByRole("link", { name: "Reviews 1" })).toBeVisible();
    await expect(defaultLink).toHaveCount(0);

    await factory.click();
    await page
      .getByRole("listbox", { name: "Factory", exact: true })
      .getByRole("option", { name: "Customer Tools", exact: true })
      .click();
    await expect(factory).toHaveText("Customer Tools");
    await expect(factory).toHaveAttribute("data-value", delegated.id);
    await expect(main.getByText(delegatedTitle, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      391,
    );
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("02-inbox-mobile-dark.png"),
    });
    await itemTypes.getByRole("link", { name: "Clarifications 0" }).press("Enter");
    await expect(itemTypes.getByRole("link", { name: "Clarifications 0" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(new URL(page.url()).searchParams.get("factory")).toBe(delegated.id);
    await expect(main.getByText("No pending clarifications in this factory.")).toBeVisible();
    await expect(main.getByRole("link", { name: "View all factories" })).toHaveAttribute(
      "href",
      `${workspacePath}/inbox?factory=all&kind=clarification`,
    );
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("03-inbox-mobile-filtered-empty.png"),
    });
    await itemTypes.getByRole("link", { name: "Reviews 1" }).press("Enter");
    await expect(main.getByText(delegatedTitle, { exact: true })).toBeVisible();
    const delegatedHref = await delegatedLink.getAttribute("href");
    if (!delegatedHref) throw new Error("Missing the filtered review link.");
    expect(new URL(delegatedHref, app).searchParams.get("returnTo")).toBe(
      `${workspacePath}/inbox?factory=${delegated.id}&kind=review`,
    );
    await page.getByRole("button", { name: "Workspace navigation: Inbox" }).press("Enter");
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    const drawerInbox = drawer.getByRole("link", { name: "Inbox", exact: true });
    await expect(drawerInbox).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Workspace navigation: Inbox" })).toBeFocused();

    await context.setOffline(true);
    await expect(main.getByText("You’re offline. Reconnect to refresh your Inbox.")).toBeVisible();
    await expect(main.getByRole("button", { name: "Refresh" })).toBeDisabled();
    await expect(main.getByText(delegatedTitle, { exact: true })).toHaveCount(0);
    await write(admin.rpc("revoke_factory_membership", membership));
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/factories/inbox" && response.status() === 404,
      ),
      context.setOffline(false),
    ]);
    await expect(main.getByText("Factory unavailable.")).toBeVisible();
    await expect(main.getByText(delegatedTitle, { exact: true })).toHaveCount(0);
    await expect(itemTypes).toHaveCount(0);
    await main.getByRole("link", { name: "View all factories" }).press("Enter");
    await expect(factory).toHaveText("All factories");
    await expect(itemTypes.getByRole("link", { name: "Reviews 0" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  } finally {
    if (workspaceId) await write(admin.from("workspaces").delete().eq("id", workspaceId));
    for (const user of users) await write(admin.auth.admin.deleteUser(user));
  }
});
