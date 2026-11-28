import { randomInt, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { inspect } from "node:util";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";
import {
  openDropdownListbox,
  selectDropdownOption,
  selectWorkspaceFactory,
  workspaceFactoryPicker,
} from "./helpers/select";

function localOrigin(value: string | undefined) {
  const url = value ? new URL(value) : null;
  if (
    !url ||
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Factory creation qualification requires loopback app and Supabase URLs.");
  }
  return url.origin;
}

async function read<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  if (data == null) throw new Error("The factory creation fixture row was not returned.");
  return data;
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", caret: "hide", path });
  await info.attach(name, { contentType: "image/png", path });
}

test("workspace factory creation preserves the default and lands in the returned scope", async ({
  page,
  baseURL,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_QUALIFICATION !== "1",
    "Requires disposable local Supabase.",
  );
  test.setTimeout(120_000);
  const base = localOrigin(baseURL);
  const supabase = localOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Set the local Supabase service key for disposable fixtures.");
  const admin = createClient<Database>(supabase, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const userIds: string[] = [];
  const slug = `northwind-${randomUUID().slice(0, 8)}`;
  async function makeUser(label: string) {
    const email = `${slug}-${label}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    userIds.push(data.user.id);
    return { email, id: data.user.id };
  }

  const workspacePath = `/w/${slug}`;
  const settingsPath = `${workspacePath}/settings`;
  const factoriesPath = `${settingsPath}?category=workspace#factories`;
  const sessionsPath = `${workspacePath}/sessions`;
  const factories = page.getByRole("list", { name: "Factories", exact: true });
  const factoriesHeading = page.getByRole("heading", { name: "Factories", exact: true });
  const newFactory = page.getByRole("button", { name: "New factory", exact: true });
  const menu = page.getByRole("menu", { name: "Factory", exact: true });
  const manageFactories = menu.getByRole("menuitem", { name: "Manage factories", exact: true });
  const picker = workspaceFactoryPicker(page);
  let workspaceId: string | undefined;

  try {
    const owner = await makeUser("owner");
    const workspace = await read(
      admin.rpc("create_workspace", {
        actor_email: owner.email,
        actor_user_id: owner.id,
        requested_slug: slug,
        workspace_name: "Northwind Studio",
      }),
    );
    workspaceId = workspace.id;
    const factoryApi = `/api/workspaces/${workspace.id}/factories`;
    const defaultFactory = await read(
      admin
        .from("factories")
        .select("id,name,slug,is_default")
        .eq("workspace_id", workspace.id)
        .eq("is_default", true)
        .single(),
    );
    const pipelineRows = () =>
      read(
        admin
          .from("pipelines")
          .select("id,factory_id,name,is_default")
          .eq("workspace_id", workspace.id),
      );
    const defaultPipeline = await pipelineRows();
    expect(defaultPipeline).toEqual([
      expect.objectContaining({ factory_id: defaultFactory.id, is_default: true }),
    ]);
    const installation = await read(
      admin
        .from("github_installations")
        .insert({
          app_id: 1,
          installation_id: randomInt(100_000_000, 2_000_000_000),
          installation_url: "https://github.com/settings/installations",
          permissions: {},
          target_name: slug,
          target_type: "Organization",
          workspace_id: workspace.id,
        })
        .select("id")
        .single(),
    );
    const repository = await read(
      admin
        .from("github_repositories")
        .insert({
          default_branch: "main",
          factory_id: defaultFactory.id,
          full_name: `${slug}/starter`,
          github_installation_id: installation.id,
          html_url: `https://github.com/${slug}/starter`,
          name: "starter",
          private: true,
          repo_id: randomInt(100_000_000, 2_000_000_000),
          workspace_id: workspace.id,
        })
        .select("id,factory_id")
        .single(),
    );
    await admin
      .from("workspace_onboarding")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("workspace_id", workspace.id)
      .throwOnError();
    const viewers = await Promise.all(
      (["admin", "member", "factory-manager"] as const).map(async (role) => {
        const user = await makeUser(role);
        const member = await read(
          admin
            .from("workspace_members")
            .insert({
              email: user.email,
              full_name: role,
              kind: "human",
              role: role === "admin" ? "admin" : "member",
              user_id: user.id,
              workspace_id: workspace.id,
            })
            .select("id")
            .single(),
        );
        if (role !== "admin") {
          await admin
            .rpc("grant_factory_membership", {
              p_workspace_id: workspace.id,
              p_factory_id: defaultFactory.id,
              p_actor_user_id: owner.id,
              p_member_id: member.id,
              p_role: role === "factory-manager" ? "manager" : "member",
            })
            .throwOnError();
        }
        return { role, email: user.email, memberId: member.id };
      }),
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, settingsPath, { baseURL: base, email: owner.email });
    const settings = page.getByRole("navigation", { name: "Settings categories" });
    await settings.getByRole("link", { name: "Workspace", exact: true }).click();
    await settings.getByRole("link", { name: "Factories", exact: true }).press("Enter");
    await expect(page).toHaveURL(
      (url) => url.hash === "#factories" && url.searchParams.get("category") === "workspace",
    );
    await expect(factoriesHeading).toBeFocused();
    await expect(factories.getByRole("listitem")).toHaveCount(1);
    await expect(factories.getByRole("listitem")).toContainText(defaultFactory.name);
    await expect(factories.getByText("Default", { exact: true })).toHaveCount(1);
    await expect(newFactory).toBeVisible();
    await capture(page, info, "01-workspace-factories");

    await page.goto(workspacePath);
    await expect(page.getByRole("link", { name: "Manage factories", exact: true })).toHaveCount(0);
    await expect(picker).toHaveAttribute("data-value", defaultFactory.id);
    await picker.press("Enter");
    await expect(manageFactories).toHaveAttribute("href", factoriesPath);
    await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText(
      defaultFactory.name,
    );
    await expect(menu.getByRole("menuitemradio").first()).toHaveText("All factories");
    await expect(menu.getByRole("separator")).toHaveCount(2);
    await capture(page, info, "02-sessions-board-shortcut");
    await page.goto(sessionsPath);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(picker).toHaveAttribute("data-value", defaultFactory.id);
    await expect(page.getByRole("link", { name: "Manage factories", exact: true })).toHaveCount(0);
    await page.goto(`${sessionsPath}?factory=all`);
    await expect(picker).toHaveAttribute("data-value", "all");
    await picker.press("Enter");
    await expect(
      menu.getByRole("menuitemradio", { name: "All factories", checked: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
    await picker.press("Enter");
    await page.keyboard.press("End");
    await expect(manageFactories).toBeFocused();
    await capture(page, info, "03-sessions-mobile-shortcut");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL((url) => url.pathname + url.search + url.hash === factoriesPath);
    await expect(factoriesHeading).toBeFocused();

    await test.step("guard the directory link while editing or saving a sole-factory draft", async () => {
      const agentPath = `${workspacePath}/agents?factory=${defaultFactory.id}&new=1#new-agent`;
      const agentApi = `${factoryApi}/${defaultFactory.id}/agents`;
      await page.goto(agentPath);
      const name = page.getByRole("textbox", { name: "Agent name", exact: true });
      await name.fill("Delivery reviewer");
      await page
        .getByRole("textbox", { name: "Implementation prompt" })
        .fill("Check the fictional delivery notes.");
      await picker.press("Enter");
      await expect(menu.getByRole("separator")).toHaveCount(1);
      await page.keyboard.press("End");
      await expect(manageFactories).toBeFocused();
      await page.keyboard.press("Enter");
      const leave = page.getByRole("alertdialog", { name: "Leave without saving?" });
      await expect(leave.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(picker).toBeFocused();
      await expect(name).toHaveValue("Delivery reviewer");
      await expect(page).toHaveURL((url) => url.pathname + url.search + url.hash === agentPath);

      const response = Promise.withResolvers<void>();
      await page.route(
        agentApi,
        async (route) => {
          await response.promise;
          await route.fulfill({ status: 503, json: { error: "Synthetic interrupted save." } });
        },
        { times: 1 },
      );
      try {
        await page.getByRole("button", { name: "Create agent", exact: true }).click();
        await expect(page.getByRole("button", { name: "Creating…", exact: true })).toBeVisible();
        await picker.press("Enter");
        await expect(manageFactories).toBeDisabled();
        await expect(manageFactories).not.toHaveAttribute("href");
        await page.keyboard.press("Escape");
      } finally {
        response.resolve();
      }

      await expect(page.getByText("Synthetic interrupted save.", { exact: true })).toBeVisible();
      await expect(name).toHaveValue("Delivery reviewer");
      await picker.press("Enter");
      await manageFactories.press("Enter");
      await leave.getByRole("button", { name: "Discard and leave", exact: true }).click();
      await expect(factoriesHeading).toBeFocused();
      await expect(page).toHaveURL((url) => url.pathname + url.search + url.hash === factoriesPath);
    });

    await newFactory.press("Enter");
    const dialog = page.getByRole("dialog", { name: "New factory" });
    await expect(dialog).toHaveAccessibleDescription(/Northwind Studio/);
    const name = dialog.getByRole("textbox", { name: "Display name" });
    const slugInput = dialog.getByRole("textbox", { name: "Factory slug" });
    await expect(name).toBeFocused();
    await name.fill("Discard me");
    await expect(slugInput).toHaveValue("discard-me");
    await page.keyboard.press("Escape");
    await expect(newFactory).toBeFocused();
    await newFactory.press("Enter");
    await expect(name).toHaveValue("");
    await name.fill("Payments + Billing");
    await expect(slugInput).toHaveValue("payments-billing");
    const create = dialog.getByRole("button", { name: "Create factory" });
    await slugInput.fill("Payments--Ops");
    await create.press("Enter");
    await expect(slugInput).toBeFocused();
    await expect(slugInput).toHaveValue("Payments--Ops");
    await expect(dialog.getByRole("alert")).toContainText("Use lowercase letters");
    await slugInput.fill(defaultFactory.slug);
    await name.fill("Payments Lab");
    await expect(slugInput).toHaveValue(defaultFactory.slug);
    await create.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("That factory slug is already reserved");
    await expect(slugInput).toHaveAccessibleDescription(/That factory slug is already reserved/);
    await expect(slugInput).toBeFocused();
    await expect(slugInput).toHaveValue(defaultFactory.slug);
    await expect(name).toHaveValue("Payments Lab");
    await capture(page, info, "04-mobile-slug-collision");

    await slugInput.fill("payments-ops");
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === factoryApi && response.request().method() === "POST",
    );
    await create.press("Enter");
    const response = await created;
    expect(response.status()).toBe(201);
    const { factory } = await response.json();
    expect(factory).toMatchObject({
      name: "Payments Lab",
      slug: "payments-ops",
      is_default: false,
    });
    expect(factory.id).not.toBe(defaultFactory.id);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === settingsPath &&
        url.searchParams.get("factory") === factory.id &&
        url.hash === "#factory-setup",
    );
    await expect(dialog).toHaveCount(0);
    const setup = page.locator("#factory-setup");
    const setupHeading = setup.getByRole("heading", { name: "Set up Payments Lab" });
    await expect(setupHeading).toBeFocused();
    await expect
      .poll(
        () =>
          setupHeading.evaluate(
            (element) =>
              element.getBoundingClientRect().top -
              document.querySelector("[data-shell-header]")!.getBoundingClientRect().bottom,
          ),
        { timeout: 3000 },
      )
      .toBeGreaterThanOrEqual(4);
    const configure = setup.getByRole("link", { name: "Configure factory" });
    const definitionPath = `${settingsPath}/factory-definition?factory=${factory.id}#factory-setup`;
    await expect(configure).toHaveAttribute("href", definitionPath);
    const viewSessions = setup.getByRole("link", { name: "View sessions" });
    await expect(setup.getByRole("link")).toHaveCount(2);
    await expect(viewSessions).toHaveAttribute("href", `${sessionsPath}?factory=${factory.id}`);
    await expect(
      factories.getByRole("listitem").filter({ hasText: defaultFactory.name }),
    ).toContainText("Default");
    await expect(factories.getByRole("listitem").filter({ hasText: "Payments Lab" })).toContainText(
      "payments-ops",
    );
    await capture(page, info, "05-mobile-new-factory-setup");
    await configure.press("Enter");
    await expect(page).toHaveURL((url) => url.pathname + url.search + url.hash === definitionPath);
    await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
    await capture(page, info, "08-canonical-setup-mobile");
    await page.goBack();
    await expect(setupHeading).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(configure).toHaveAttribute("href", definitionPath);
    await capture(page, info, "09-desktop-new-factory-setup");
    await configure.click();
    await expect(page).toHaveURL((url) => url.pathname + url.search + url.hash === definitionPath);
    await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
    await page.goBack();
    await page.setViewportSize({ width: 390, height: 844 });
    await viewSessions.press("Enter");
    await expect(picker).toHaveAttribute("data-value", factory.id);
    await expect(page.getByText("No sessions in this factory yet.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View sessions across factories" }),
    ).toHaveAttribute("href", `${sessionsPath}?factory=all`);
    const newSession = page.getByRole("button", { name: "New session", exact: true });
    await newSession.press("Enter");
    const composer = page.getByRole("dialog", { name: "Start a new session", exact: true });
    await expect(composer.getByText("Payments Lab", { exact: true })).toBeVisible();
    await expect(composer.getByLabel("Linear issue URL")).toHaveCount(0);
    await expect(
      composer.getByRole("button", { name: "Start session", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(composer).toBeHidden();
    await expect(newSession).toBeFocused();
    await capture(page, info, "06-new-factory-sessions");
    await selectWorkspaceFactory(page, defaultFactory.id);
    await expect(picker).toHaveAttribute("data-value", defaultFactory.id);
    await picker.click();
    await manageFactories.click();
    await expect(factories.getByRole("listitem")).toHaveCount(2);

    expect(
      await read(
        admin
          .from("factories")
          .select("id,name,slug,is_default")
          .eq("workspace_id", workspace.id)
          .eq("is_default", true)
          .single(),
      ),
    ).toEqual(defaultFactory);
    expect(await pipelineRows()).toEqual(defaultPipeline);
    expect(
      await read(
        admin.from("github_repositories").select("id,factory_id").eq("workspace_id", workspace.id),
      ),
    ).toEqual([repository]);

    await test.step("check the list after a committed create loses its response", async () => {
      let committedStatus: number | undefined;
      await page.route(
        factoryApi,
        async (route) => {
          committedStatus = (await route.fetch()).status();
          await route.abort();
        },
        { times: 1 },
      );
      await newFactory.press("Enter");
      await name.fill("Support Ops");
      await create.press("Enter");
      const error = dialog.getByRole("alert");
      await expect(error).toBeVisible();
      expect(committedStatus).toBe(201);
      await expect(error).toContainText("confirm creation", { timeout: 3000 });
      await expect(name).toHaveValue("Support Ops");
      await expect(slugInput).toHaveValue("support-ops");
      await expect(create).toHaveCount(0);
      await capture(page, info, "07-mobile-check-factories");

      await dialog.getByRole("button", { name: "Check factories" }).press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(newFactory).toBeFocused();
      await expect(page).toHaveURL((url) => url.pathname + url.search + url.hash === factoriesPath);
      await expect(factories.getByRole("listitem")).toHaveCount(3);
      await expect(
        factories.getByRole("listitem").filter({ hasText: "Support Ops" }),
      ).toContainText("support-ops");
    });

    for (const { role, email, memberId } of viewers) {
      await page.context().clearCookies();
      await signInViaMagicLink(page, sessionsPath, { baseURL: base, email });
      if (role === "admin") {
        await picker.press("Enter");
        await expect(manageFactories).toHaveAttribute("href", factoriesPath);
        await manageFactories.press("Enter");
      } else {
        await expect(picker).toHaveCount(0);
        await expect(page.getByRole("link", { name: "Manage factories", exact: true })).toHaveCount(
          0,
        );
        await page.goto(factoriesPath);
      }
      await expect(factoriesHeading).toBeVisible();
      if (role === "admin") {
        await expect(newFactory).toBeVisible();
        await expect(factories.getByRole("listitem")).toHaveCount(3);
        const createdAsAdmin = await page.request.post(factoryApi, {
          data: { name: "Operations", slug: "operations" },
        });
        expect(createdAsAdmin.status()).toBe(201);
      } else {
        await expect(newFactory).toHaveCount(0);
        await expect(factories.getByRole("listitem")).toHaveCount(1);
        await expect(factories.getByRole("listitem")).toContainText(defaultFactory.name);
        await expect(factories.getByText("Payments Lab", { exact: true })).toHaveCount(0);
        const forbidden = await page.request.post(factoryApi, {
          data: { name: "Not allowed", slug: "not-allowed" },
        });
        expect(forbidden.status()).toBe(403);
        await page.goto(`${settingsPath}?category=workspace&factory=${factory.id}#factory-setup`);
        await expect(page.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
        await expect(page.locator("#factory-setup").getByRole("link")).toHaveCount(0);
        if (role === "factory-manager") {
          await admin
            .rpc("grant_factory_membership", {
              p_workspace_id: workspace.id,
              p_factory_id: factory.id,
              p_actor_user_id: owner.id,
              p_member_id: memberId,
              p_role: "manager",
            })
            .throwOnError();
          await page.reload();
          await expect(setupHeading).toBeVisible();
          await expect(configure).toHaveCount(0);
          await expect(viewSessions).toBeVisible();
        }
      }
    }
  } finally {
    if (workspaceId) await admin.from("workspaces").delete().eq("id", workspaceId).throwOnError();
    for (const id of userIds) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
    }
  }
});

test("factory management changes only the selected factory and leaves workspace roles intact", async ({
  page,
  baseURL,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_QUALIFICATION !== "1",
    "Requires disposable local Supabase.",
  );
  test.setTimeout(120_000);
  const base = localOrigin(baseURL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Set the local Supabase service key for disposable fixtures.");
  const admin = createClient<Database>(localOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL), key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const userIds: string[] = [];
  const slug = `northwind-${randomUUID().slice(0, 8)}`;
  const settings = `/w/${slug}/settings?category=workspace`;
  const managePath = (id: string) => `${settings}&manageFactory=${id}#factory-management`;
  async function makeUser(label: string) {
    const email = `${label}@${slug}.example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    userIds.push(data.user.id);
    return { email, id: data.user.id };
  }

  let workspaceId: string | undefined;
  let workflowFailed = false;
  const cleanupErrors: unknown[] = [];
  try {
    const owner = await makeUser("owner");
    const workspace = await read(
      admin.rpc("create_workspace", {
        actor_email: owner.email,
        actor_user_id: owner.id,
        requested_slug: slug,
        workspace_name: "Northwind Studio",
      }),
    );
    workspaceId = workspace.id;
    await admin
      .from("workspace_onboarding")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("workspace_id", workspace.id)
      .throwOnError();
    const operatorArgs = { p_actor_user_id: owner.id, p_workspace_id: workspace.id };
    const payments = await read(
      admin.rpc("create_factory", { ...operatorArgs, p_name: "Payments Lab", p_slug: "payments" }),
    );
    const support = await read(
      admin.rpc("create_factory", { ...operatorArgs, p_name: "Support Lab", p_slug: "support" }),
    );
    const defaultFactory = await read(
      admin
        .from("factories")
        .select("id,name,slug,is_default,status")
        .eq("workspace_id", workspace.id)
        .eq("is_default", true)
        .single(),
    );
    async function addMember(
      label: string,
      fullName: string,
      role: "admin" | "member",
      isActive = true,
    ) {
      const user = await makeUser(label);
      const member = await read(
        admin
          .from("workspace_members")
          .insert({
            email: user.email,
            full_name: fullName,
            is_active: isActive,
            kind: "human",
            role,
            user_id: user.id,
            workspace_id: workspace.id,
          })
          .select("id")
          .single(),
      );
      return { ...user, memberId: member.id };
    }
    const operator = await addMember("admin", "Alex Reed", "admin");
    const manager = await addMember("manager", "Mika Lane", "member");
    const member = await addMember("member", "Jo Rivera", "member");
    await addMember("inactive", "Sam Quinn", "member", false);
    const ownerMember = await read(
      admin
        .from("workspace_members")
        .select("id")
        .eq("workspace_id", workspace.id)
        .eq("user_id", owner.id)
        .single(),
    );
    await admin
      .rpc("grant_factory_membership", {
        ...operatorArgs,
        p_factory_id: payments.id,
        p_member_id: manager.memberId,
        p_role: "manager",
      })
      .throwOnError();
    await admin
      .rpc("revoke_factory_membership", {
        ...operatorArgs,
        p_factory_id: payments.id,
        p_member_id: ownerMember.id,
      })
      .throwOnError();
    await admin
      .rpc("grant_factory_membership", {
        ...operatorArgs,
        p_factory_id: support.id,
        p_member_id: member.memberId,
        p_role: "member",
      })
      .throwOnError();

    const directory = page.getByRole("list", { name: "Factories", exact: true });
    const rows = directory.locator(":scope > li");
    const panel = directory.locator('li > [role="region"]:not([hidden])');
    const manage = (name: string) =>
      rows.getByRole("button", { name: `Manage ${name}`, exact: true });
    const close = (name: string) =>
      rows.getByRole("button", { name: `Close ${name}`, exact: true });
    const activePay = close("Payments Lab");
    const displayName = panel.getByRole("textbox", { name: "Display name" });
    const factorySlug = panel.getByRole("textbox", { name: "Factory slug" });
    const saveName = panel.getByRole("button", { name: "Save name" });
    const saveSlug = panel.getByRole("button", { name: "Save slug" });
    const factoryApi = `/api/workspaces/${workspace.id}/factories`;
    const paymentApi = `/api/workspaces/${workspace.id}/factories/${payments.id}`;
    const defaultApi = `${factoryApi}/${defaultFactory.id}`;
    const readDefault = () =>
      read(
        admin
          .from("factories")
          .select("id,name,slug,is_default,status")
          .eq("workspace_id", workspace.id)
          .eq("is_default", true)
          .single(),
      );
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInViaMagicLink(page, `${settings}#factories`, { baseURL: base, email: owner.email });
    await expect(rows).toHaveCount(3);
    await capture(page, info, "01-directory-desktop");
    const defaultTrigger = manage(defaultFactory.name);
    await expect(defaultTrigger).toHaveAttribute("aria-expanded", "false");
    await defaultTrigger.press("Enter");
    const defaultClose = close(defaultFactory.name);
    await expect(defaultClose).toBeFocused();
    await expect(defaultClose).toHaveAttribute("aria-expanded", "true");
    await expect(defaultClose).toHaveAttribute(
      "aria-controls",
      `factory-management-${defaultFactory.id}`,
    );
    await expect(rows.first().getByRole("region", { name: defaultFactory.name })).toBeVisible();
    await expect(saveName).toBeEnabled();
    await expect(panel.getByRole("button", { name: "Archive factory" })).toHaveCount(0);
    await expect(panel.getByText("The workspace default cannot be archived.")).toBeVisible();
    await displayName.fill("Studio Operations");
    await saveName.click();
    await expect(close("Studio Operations")).toBeVisible();
    expect(await readDefault()).toEqual({ ...defaultFactory, name: "Studio Operations" });
    await expect(factorySlug).toHaveValue(defaultFactory.slug);
    await expect(factorySlug).toHaveAccessibleDescription(
      /factory list API.*Links use the factory ID/,
    );
    await capture(page, info, "02-default-expanded-desktop");
    expect((await page.request.patch(defaultApi, { data: { action: "archive" } })).status()).toBe(
      422,
    );

    const v1Factories = `/api/v1/workspaces/${workspace.id}/factories`;
    const v1Default = `${v1Factories}/${defaultFactory.id}/sessions`;
    expect((await page.request.get(v1Default)).status()).toBe(401);
    await factorySlug.fill("studio");
    await saveSlug.click();
    await expect(rows.first().getByText("studio", { exact: true })).toBeVisible();
    expect(await readDefault()).toEqual({
      ...defaultFactory,
      name: "Studio Operations",
      slug: "studio",
    });
    const scope = await page.request.get(factoryApi);
    expect(scope.ok()).toBe(true);
    expect((await scope.json()).factories).toContainEqual(
      expect.objectContaining({ factoryId: defaultFactory.id, isDefault: true, slug: "studio" }),
    );
    expect((await page.request.get(v1Default)).status()).toBe(401);
    expect((await page.request.get(`${v1Factories}/studio/sessions`)).status()).toBe(400);
    const oldSlug = await page.request.post(factoryApi, {
      data: { name: "Other factory", slug: defaultFactory.slug },
    });
    expect(oldSlug.status()).toBe(409);
    expect(await oldSlug.json()).toMatchObject({ code: "factory_slug_taken" });

    const sessionsPage = await page.context().newPage();
    const sessionsPath = `/w/${slug}/sessions`;
    for (const path of [sessionsPath, `${sessionsPath}?factory=${defaultFactory.id}`]) {
      await sessionsPage.goto(path);
      await expect(workspaceFactoryPicker(sessionsPage)).toHaveAttribute(
        "data-value",
        defaultFactory.id,
      );
    }
    await sessionsPage.close();

    const managePayments = manage("Payments Lab");
    await displayName.fill("Unsaved name");
    const discardPrompt = page.waitForEvent("dialog").then(async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await managePayments.click();
    expect(await discardPrompt).toBe("Discard unsaved changes to this factory?");
    await expect(displayName).toHaveValue("Unsaved name");
    await expect(close("Studio Operations")).toHaveAttribute("aria-expanded", "true");
    page.once("dialog", (dialog) => dialog.accept());
    await managePayments.press("Enter");
    await expect(activePay).toBeFocused();
    await expect(rows.nth(1).getByRole("region", { name: "Payments Lab" })).toBeVisible();
    await expect(panel).toHaveCount(1);
    await expect(panel.getByRole("textbox", { name: "Display name" })).toHaveValue("Payments Lab");
    await activePay.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(managePayments).toBeFocused();
    await manage("Studio Operations").click();
    await expect(displayName).toHaveValue("Studio Operations");
    await close("Studio Operations").click();
    await expect(manage("Studio Operations")).toBeFocused();

    await manage("Studio Operations").click();
    await displayName.fill("Unsubmitted category rename");
    const editorUrl = page.url();
    const settingsCategories = page.getByRole("navigation", { name: "Settings categories" });
    const usageCategory = settingsCategories.getByRole("link", { name: "Usage & retention" });
    const [categoryPrompt] = await Promise.all([
      page.waitForEvent("dialog", { timeout: 4000 }).then(async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        return message;
      }),
      usageCategory.click(),
    ]);
    expect(categoryPrompt).toBe("Discard unsaved changes to this factory?");
    await expect(page).toHaveURL(editorUrl);
    await expect(displayName).toHaveValue("Unsubmitted category rename");
    page.once("dialog", (dialog) => dialog.accept());
    await usageCategory.click();
    await expect(page).toHaveURL((url) => url.searchParams.get("category") === "advanced");
    await expect(displayName).toHaveCount(0);

    await page.context().clearCookies();
    await signInViaMagicLink(page, managePath(payments.id.toUpperCase()), {
      baseURL: base,
      email: operator.email,
    });
    await expect(activePay).toBeFocused();
    await expect(rows.nth(1).getByRole("region", { name: "Payments Lab" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Archive factory" })).toBeVisible();
    await expect(activePay).toHaveAttribute("aria-expanded", "true");
    await expect(directory.locator('button[aria-expanded="true"]')).toHaveCount(1);

    const chunks = readdirSync(".next/static/chunks")
      .filter(
        (file) =>
          file.endsWith(".js") &&
          readFileSync(`.next/static/chunks/${file}`, "utf8").includes("Remove factory access?"),
      )
      .map((file) => `**/_next/static/chunks/${file}`);
    expect(chunks.length).toBeGreaterThan(0);
    let failDownloads!: () => void;
    const downloads = new Promise<void>((resolve) => (failDownloads = resolve));
    const requestedChunks: string[] = [];
    for (const chunk of chunks) {
      await page.route(chunk, async (route) => {
        requestedChunks.push(route.request().url());
        await downloads;
        await route.abort();
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${settings}#factories`);
    await expect(rows).toHaveCount(3);
    expect(requestedChunks).toEqual([]);
    try {
      await managePayments.click();
      await expect(panel.getByRole("status")).toHaveText("Loading factory management…");
    } finally {
      failDownloads();
    }
    await expect(panel.getByRole("alert")).toHaveText("Could not load factory management.");
    expect(requestedChunks.length).toBeGreaterThan(0);
    await expect(rows).toHaveCount(3);
    await expect(activePay).toHaveAttribute("aria-expanded", "true");
    await directory.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await capture(page, info, "05-management-load-failure-mobile");
    await activePay.click();
    await expect(panel).toHaveCount(0);
    await expect(directory).toBeVisible();
    await expect(managePayments).toBeFocused();
    await managePayments.click();
    await expect(panel.getByRole("alert")).toHaveText("Could not load factory management.");
    for (const chunk of chunks) await page.unroute(chunk);
    const reloaded = page.waitForEvent(
      "request",
      (request) => request.isNavigationRequest() && request.resourceType() === "document",
    );
    await panel.getByRole("button", { name: "Reload Settings" }).click();
    expect(new URL((await reloaded).url()).searchParams.get("manageFactory")).toBe(payments.id);
    await expect(displayName).toHaveValue("Payments Lab");

    await page.context().clearCookies();
    await page.setViewportSize({ width: 320, height: 760 });
    await signInViaMagicLink(page, `${settings}#factories`, {
      baseURL: base,
      email: manager.email,
    });
    await expect(manage("Support Lab")).toHaveCount(0);
    await expect(manage("Studio Operations")).toHaveCount(0);
    await managePayments.press("Enter");
    await expect(activePay).toBeFocused();
    await expect(page).toHaveURL(
      (url) => url.pathname + url.search + url.hash === managePath(payments.id),
    );
    const memberSelect = panel.getByRole("combobox", { name: "Workspace member" });
    const roleSelect = panel.getByRole("combobox", { name: "Factory role" });
    const saveAccess = panel.getByRole("button", { name: "Save access" });
    const accessFields = () =>
      memberSelect.evaluate((input: HTMLInputElement) => {
        if (!input.form) throw new Error("Missing factory access form.");
        const fields = new FormData(input.form);
        return {
          memberId: fields.get("memberId"),
          role: fields.get("role"),
          valid: input.form.checkValidity(),
        };
      });
    expect(
      await memberSelect.evaluate((field) => field.getBoundingClientRect().width),
    ).toBeGreaterThan(180);
    const workspaceOptions = page.getByRole("listbox", { name: "Workspace members" });
    async function chooseMember(query: string) {
      await memberSelect.fill(query);
      await expect(workspaceOptions.getByRole("option")).toHaveCount(1);
      await memberSelect.press("ArrowDown");
      await memberSelect.press("Enter");
      await expect(memberSelect).toHaveValue(new RegExp(query, "i"));
    }
    await memberSelect.click();
    await expect(workspaceOptions.getByRole("option", { name: /Alex Reed|Sam Quinn/ })).toHaveCount(
      0,
    );
    await chooseMember("Mika Lane");
    const roles = await openDropdownListbox(roleSelect);
    await expect(roles.getByRole("option", { name: "Member", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(roleSelect).toBeFocused();
    await expect(
      panel.getByRole("button", { name: /Remove factory access for Mika Lane/ }),
    ).toHaveCount(0);
    await memberSelect.fill("Unlisted member");
    await expect(page.getByText("No matching members.")).toBeVisible();
    expect(await accessFields()).toEqual({ memberId: "", role: "member", valid: false });
    await memberSelect.press("Enter");
    await expect(saveAccess).toBeDisabled();
    await chooseMember("Jo Rivera");
    expect(await accessFields()).toEqual({
      memberId: member.memberId,
      role: "member",
      valid: true,
    });
    await page.route(
      `**${paymentApi}/members`,
      (route) => route.fulfill({ json: { error: "The member changed. Try again." }, status: 409 }),
      { times: 1 },
    );
    await saveAccess.click();
    await expect(panel.getByRole("alert")).toHaveText("The member changed. Try again.");
    expect(await accessFields()).toEqual({
      memberId: member.memberId,
      role: "member",
      valid: true,
    });
    await saveAccess.click();
    const memberRow = panel.getByRole("listitem").filter({ hasText: "Jo Rivera" });
    await expect(memberRow.getByText("Member", { exact: true })).toBeVisible();
    await expect(memberSelect).toBeFocused();
    await expect(memberSelect).toHaveValue("");
    await expect(memberSelect).toHaveAttribute("aria-expanded", "false");
    await chooseMember("Jo Rivera");
    await selectDropdownOption(roleSelect, "manager");
    await saveAccess.click();
    await expect(memberRow.getByText("Manager", { exact: true })).toBeVisible();

    await displayName.fill("Payments Operations");
    await panel.scrollIntoViewIfNeeded();
    await capture(page, info, "06-rename-draft-mobile");
    await admin
      .rpc("rename_factory", {
        ...operatorArgs,
        p_expected_name: "Payments Lab",
        p_factory_id: payments.id,
        p_name: "Payments Studio",
      })
      .throwOnError();
    await saveName.click();
    await expect(panel.getByRole("alert")).toHaveText(
      "The factory name changed. Reload and try again.",
    );
    await expect(displayName).toHaveValue("Payments Operations");
    await expect(saveName).toHaveCount(0);
    await panel.scrollIntoViewIfNeeded();
    await capture(page, info, "07-rename-conflict-mobile");
    await panel.getByRole("button", { name: "Discard draft and reload" }).click();
    await expect(close("Payments Studio")).toBeVisible();
    await expect(displayName).toHaveValue("Payments Studio");
    await expect(saveName).toBeEnabled();
    await displayName.fill("Payments Operations");
    await saveName.click();
    await expect(close("Payments Operations")).toBeVisible();
    await expect(
      directory.getByRole("listitem").filter({ hasText: "Payments Operations" }),
    ).toContainText("payments");
    await panel.scrollIntoViewIfNeeded();
    await capture(page, info, "02-management-mobile");
    expect(
      (
        await page.request.patch(paymentApi, {
          data: { action: "rename", expectedName: "Payments Lab", name: "Stale rename" },
        })
      ).status(),
    ).toBe(409);

    await factorySlug.fill("default");
    await saveSlug.click();
    await expect(panel.getByRole("alert")).toContainText("already reserved");
    await expect(factorySlug).toHaveValue("default");
    await expect(factorySlug).toBeFocused();
    await factorySlug.fill("payments-operations");
    await admin
      .rpc("set_factory_slug", {
        ...operatorArgs,
        p_expected_slug: "payments",
        p_factory_id: payments.id,
        p_slug: "payments-team",
      })
      .throwOnError();
    await saveSlug.click();
    await expect(panel.getByRole("alert")).toHaveText(
      "The factory slug changed. Reload and try again.",
    );
    await expect(factorySlug).toHaveValue("payments-operations");
    await panel.getByRole("button", { name: "Discard draft and reload" }).click();
    await expect(factorySlug).toHaveValue("payments-team");
    await factorySlug.fill("payments-operations");
    await saveSlug.click();
    await expect(rows.getByText("payments-operations", { exact: true })).toBeVisible();
    await expect(displayName).toHaveValue("Payments Operations");

    const remove = memberRow.getByRole("button", { name: /Remove factory access for Jo Rivera/ });
    await remove.press("Enter");
    const removal = page.getByRole("alertdialog", { name: "Remove factory access?" });
    await expect(removal.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(remove).toBeFocused();
    await remove.press("Enter");
    await removal.getByRole("button", { name: "Remove factory access" }).click();
    await expect(memberRow).toHaveCount(0);
    await expect(memberSelect).toBeFocused();
    const unchangedMember = await read(
      admin.from("workspace_members").select("role,is_active").eq("id", member.memberId).single(),
    );
    expect(unchangedMember).toEqual({ is_active: true, role: "member" });
    const supportGrant = await read(
      admin
        .from("factory_members")
        .select("role,revoked_at")
        .eq("factory_id", support.id)
        .eq("member_id", member.memberId)
        .single(),
    );
    expect(supportGrant).toEqual({ revoked_at: null, role: "member" });

    const archive = panel.getByRole("button", { name: "Archive factory", exact: true });
    await archive.press("Enter");
    const confirmation = page.getByRole("alertdialog", { name: "Archive Payments Operations?" });
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(confirmation).toHaveAccessibleDescription(/blocks new sessions.*records are kept/);
    await capture(page, info, "03-archive-confirmation-mobile");
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(archive).toBeFocused();
    await archive.press("Enter");
    await confirmation.getByRole("button", { name: "Archive factory" }).click();
    const restore = panel.getByRole("button", { name: "Restore factory", exact: true });
    await expect(restore).toBeVisible();
    await expect(restore).toBeFocused();
    await expect(memberSelect).toHaveCount(0);
    await expect(displayName).toHaveCount(0);
    await expect(factorySlug).toHaveCount(0);
    expect(
      (
        await page.request.post(`${paymentApi}/members`, {
          data: { memberId: member.memberId, role: "member" },
        })
      ).status(),
    ).toBe(409);
    await restore.press("Enter");
    const restoration = page.getByRole("alertdialog", { name: "Restore Payments Operations?" });
    await restoration.getByRole("button", { name: "Restore factory" }).click();
    await expect(displayName).toHaveValue("Payments Operations");
    await expect(factorySlug).toHaveValue("payments-operations");
    await expect(archive).toBeFocused();
    await expect(panel.getByRole("listitem").filter({ hasText: "Mika Lane" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, "04-restored-mobile");
    await page.reload();
    await expect(memberSelect).toBeVisible();
    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await memberSelect.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await memberSelect.fill("Jo Rivera");
    await expect(workspaceOptions.getByRole("option", { name: /Jo Rivera/ })).toBeVisible();
    await capture(page, info, "08-member-search-dark-mobile");
    await memberSelect.press("ArrowDown");
    await memberSelect.press("Enter");
    await page.setViewportSize({ width: 1440, height: 900 });
    await directory.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await openDropdownListbox(roleSelect);
    await capture(page, info, "09-factory-role-dark-desktop");
    await page.keyboard.press("Escape");
    await memberSelect.fill("");

    await admin
      .rpc("grant_factory_membership", {
        ...operatorArgs,
        p_factory_id: payments.id,
        p_member_id: member.memberId,
        p_role: "member",
      })
      .throwOnError();
    await page.context().clearCookies();
    await signInViaMagicLink(page, managePath(payments.id), { baseURL: base, email: member.email });
    await expect(directory.getByText("Payments Operations", { exact: true })).toBeVisible();
    await expect(manage("Payments Operations")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Factory management unavailable" }),
    ).toBeVisible();
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    expect(
      (
        await page.request.patch(paymentApi, {
          data: {
            action: "rename",
            expectedName: "Payments Operations",
            name: "Unauthorized rename",
          },
        })
      ).status(),
    ).toBe(403);
    const deniedSlug = await page.request.patch(paymentApi, {
      data: { action: "set-slug", expectedSlug: "payments-operations", slug: "denied" },
    });
    expect(deniedSlug.status()).toBe(403);
  } catch (error) {
    workflowFailed = true;
    throw error;
  } finally {
    if (workspaceId) {
      try {
        await admin.from("workspaces").delete().eq("id", workspaceId).throwOnError();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const id of userIds) {
      try {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) throw error;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (workflowFailed && cleanupErrors.length) {
      await info
        .attach("fixture cleanup errors", {
          body: inspect(cleanupErrors),
          contentType: "text/plain",
        })
        .catch(() => {});
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, "Factory management fixture cleanup failed.");
  }
});
