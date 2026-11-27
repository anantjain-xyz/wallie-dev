import { randomInt, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { inspect } from "node:util";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";
import { selectDropdownOption } from "./helpers/select";

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
  const manageFactories = page.getByRole("link", { name: "Manage factories", exact: true });
  const picker = page.getByRole("combobox", { name: "Factory", exact: true });
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
    await expect(manageFactories).toHaveAttribute("href", factoriesPath);
    await capture(page, info, "02-sessions-board-shortcut");
    await page.goto(sessionsPath);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(picker).toHaveCount(0);
    await expect(manageFactories).toHaveAttribute("href", factoriesPath);
    await page.goto(`${sessionsPath}?factory=all`);
    await expect(picker).toHaveAttribute("data-value", "all");
    await picker.press("Enter");
    const options = page.getByRole("listbox");
    await expect(options.getByRole("option", { name: "All factories" })).toBeVisible();
    await expect(options.getByText("Manage factories")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
    await manageFactories.focus();
    await capture(page, info, "03-sessions-mobile-shortcut");
    await manageFactories.press("Enter");
    await expect(page).toHaveURL((url) => url.pathname + url.search + url.hash === factoriesPath);
    await expect(factoriesHeading).toBeFocused();

    await newFactory.press("Enter");
    const dialog = page.getByRole("dialog", { name: "New factory" });
    await expect(dialog).toHaveAccessibleDescription(/Northwind Studio/);
    const name = dialog.getByRole("textbox", { name: "Factory name" });
    const address = dialog.getByRole("textbox", { name: "Address" });
    await expect(name).toBeFocused();
    await name.fill("Discard me");
    await expect(address).toHaveValue("discard-me");
    await page.keyboard.press("Escape");
    await expect(newFactory).toBeFocused();
    await newFactory.press("Enter");
    await expect(name).toHaveValue("");
    await name.fill("Payments + Billing");
    await expect(address).toHaveValue("payments-billing");
    await address.fill(defaultFactory.slug);
    await name.fill("Payments Lab");
    await expect(address).toHaveValue(defaultFactory.slug);
    const create = dialog.getByRole("button", { name: "Create factory" });
    await create.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("That address is already used");
    await expect(address).toHaveAccessibleDescription(/That address is already used/);
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(defaultFactory.slug);
    await expect(name).toHaveValue("Payments Lab");
    await capture(page, info, "04-mobile-address-collision");

    await address.fill("payments-ops");
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
    await selectDropdownOption(picker, defaultFactory.id);
    await expect(picker).toHaveAttribute("data-value", defaultFactory.id);
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
      await expect(address).toHaveValue("support-ops");
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
      await expect(manageFactories).toHaveCount(role === "admin" ? 1 : 0);
      await page.goto(factoriesPath);
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
        .select("id,name")
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
    const panel = page.locator("#factory-management");
    const paymentApi = `/api/workspaces/${workspace.id}/factories/${payments.id}`;
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInViaMagicLink(page, `${settings}#factories`, { baseURL: base, email: owner.email });
    await expect(directory.getByRole("listitem")).toHaveCount(3);
    await capture(page, info, "01-directory-desktop");
    await directory.getByRole("link", { name: `Manage ${defaultFactory.name}` }).press("Enter");
    await expect(panel.getByRole("heading", { name: defaultFactory.name })).toBeFocused();
    await expect(panel.getByRole("button", { name: "Archive factory" })).toHaveCount(0);
    await expect(panel.getByText("The workspace default cannot be archived.")).toBeVisible();
    expect(
      (
        await page.request.patch(`/api/workspaces/${workspace.id}/factories/${defaultFactory.id}`, {
          data: { action: "archive" },
        })
      ).status(),
    ).toBe(422);
    await panel.getByRole("link", { name: "Close factory management" }).press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Factories", exact: true })).toBeFocused();

    await page.context().clearCookies();
    await signInViaMagicLink(page, managePath(payments.id.toUpperCase()), {
      baseURL: base,
      email: operator.email,
    });
    await expect(panel.getByRole("heading", { name: "Payments Lab" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Archive factory" })).toBeVisible();
    const managePayments = directory.getByRole("link", { name: "Manage Payments Lab" });
    await expect(managePayments).toHaveAttribute("aria-current", "location");
    await expect(directory.locator('[aria-current="location"]')).toHaveCount(1);

    const chunks = readdirSync(".next/static/chunks")
      .filter(
        (file) =>
          file.endsWith(".js") &&
          readFileSync(`.next/static/chunks/${file}`, "utf8").includes("Remove factory access?"),
      )
      .map((file) => `**/_next/static/chunks/${file}`);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) await page.route(chunk, (route) => route.abort());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${settings}#factories`);
    await managePayments.click();
    await expect(panel.getByRole("alert")).toHaveText("Could not load factory management.");
    await expect(directory.getByRole("listitem")).toHaveCount(3);
    await expect(managePayments).toHaveAttribute("aria-current", "location");
    await directory.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await capture(page, info, "05-management-load-failure-mobile");
    await panel.getByRole("link", { name: "Close factory management" }).click();
    await expect(panel).toHaveCount(0);
    await expect(directory).toBeVisible();
    await managePayments.click();
    await expect(panel.getByRole("alert")).toHaveText("Could not load factory management.");
    for (const chunk of chunks) await page.unroute(chunk);
    const reloaded = page.waitForEvent(
      "request",
      (request) => request.isNavigationRequest() && request.resourceType() === "document",
    );
    await panel.getByRole("button", { name: "Reload Settings" }).click();
    expect(new URL((await reloaded).url()).searchParams.get("manageFactory")).toBe(payments.id);
    await expect(panel.getByRole("textbox", { name: "Factory name" })).toHaveValue("Payments Lab");

    await page.context().clearCookies();
    await page.setViewportSize({ width: 320, height: 760 });
    await signInViaMagicLink(page, `${settings}#factories`, {
      baseURL: base,
      email: manager.email,
    });
    await expect(directory.getByRole("link", { name: "Manage Support Lab" })).toHaveCount(0);
    await expect(
      directory.getByRole("link", { name: `Manage ${defaultFactory.name}` }),
    ).toHaveCount(0);
    await expect(managePayments).toHaveAttribute("href", managePath(payments.id));
    await managePayments.press("Enter");
    await expect(panel.getByRole("heading", { name: "Payments Lab" })).toBeFocused();
    const memberSelect = panel.getByRole("combobox", { name: "Workspace member" });
    const roleSelect = panel.getByRole("combobox", { name: "Factory role" });
    const saveAccess = panel.getByRole("button", { name: "Save access" });
    const rename = panel.getByRole("textbox", { name: "Factory name" });
    expect(
      await memberSelect.evaluate((field) => field.getBoundingClientRect().width),
    ).toBeGreaterThan(180);
    await expect(memberSelect.getByRole("option", { name: /Alex Reed|Sam Quinn/ })).toHaveCount(0);
    await memberSelect.selectOption(manager.memberId);
    await expect(roleSelect.locator('option[value="member"]')).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: /Remove factory access for Mika Lane/ }),
    ).toHaveCount(0);
    await memberSelect.selectOption(member.memberId);
    await saveAccess.click();
    const memberRow = panel.getByRole("listitem").filter({ hasText: "Jo Rivera" });
    await expect(memberRow.getByText("Member", { exact: true })).toBeVisible();
    await memberSelect.selectOption(member.memberId);
    await roleSelect.selectOption("manager");
    await saveAccess.click();
    await expect(memberRow.getByText("Manager", { exact: true })).toBeVisible();

    const saveName = panel.getByRole("button", { name: "Save name" });
    await rename.fill("Payments Operations");
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
    await expect(rename).toHaveValue("Payments Operations");
    await expect(saveName).toHaveCount(0);
    await panel.scrollIntoViewIfNeeded();
    await capture(page, info, "07-rename-conflict-mobile");
    await panel.getByRole("button", { name: "Discard draft and reload" }).click();
    await expect(panel.getByRole("heading", { name: "Payments Studio" })).toBeVisible();
    await expect(rename).toHaveValue("Payments Studio");
    await expect(saveName).toBeDisabled();
    await rename.fill("Payments Operations");
    await saveName.click();
    await expect(panel.getByRole("heading", { name: "Payments Operations" })).toBeVisible();
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
    await expect(rename).toHaveCount(0);
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
    await expect(rename).toHaveValue("Payments Operations");
    await expect(archive).toBeFocused();
    await expect(panel.getByRole("listitem").filter({ hasText: "Mika Lane" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, "04-restored-mobile");

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
    await expect(directory.getByRole("link", { name: "Manage Payments Operations" })).toHaveCount(
      0,
    );
    await expect(
      panel.getByRole("heading", { name: "Factory management unavailable" }),
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
