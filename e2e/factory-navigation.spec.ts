import { randomUUID } from "node:crypto";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";
import { selectDropdownOption } from "./helpers/select";

type Admin = SupabaseClient<Database>;

function localUrl(value: string | undefined) {
  if (!value) throw new Error("Set the disposable local app and Supabase URLs.");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Factory navigation qualification requires loopback services.");
  }
  return url.origin;
}

async function read<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  if (data == null) throw new Error("The navigation fixture row was not returned.");
  return data;
}

async function write(operation: PromiseLike<{ error: unknown }>) {
  const { error } = await operation;
  if (error) throw error;
}

async function createUser(admin: Admin, email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

async function seedFactoryWork(
  admin: Admin,
  {
    workspaceId,
    factoryId,
    title,
    isDefault,
    count,
    firstNumber,
    actorMemberId,
    runActorMemberId = actorMemberId,
    runStatus = () => "success",
  }: {
    workspaceId: string;
    factoryId: string;
    title: string;
    isDefault: boolean;
    count: number;
    firstNumber: number;
    actorMemberId?: string;
    runActorMemberId?: string;
    runStatus?: (index: number) => Database["public"]["Enums"]["agent_run_status"];
  },
) {
  const pipeline = isDefault
    ? await read(
        admin
          .from("pipelines")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("is_default", true)
          .single(),
      )
    : await read(
        admin
          .from("pipelines")
          .insert({ workspace_id: workspaceId, factory_id: factoryId, name: title })
          .select("id")
          .single(),
      );
  const stage = isDefault
    ? await read(
        admin
          .from("pipeline_stages")
          .select("id,slug")
          .eq("pipeline_id", pipeline.id)
          .eq("slug", "plan")
          .single(),
      )
    : await read(
        admin
          .from("pipeline_stages")
          .insert({
            workspace_id: workspaceId,
            pipeline_id: pipeline.id,
            name: title,
            slug: "deliver",
            position: 1,
          })
          .select("id,slug")
          .single(),
      );
  const sessions = await read(
    admin
      .from("sessions")
      .insert(
        Array.from({ length: count }, (_, index) => ({
          workspace_id: workspaceId,
          factory_id: factoryId,
          pipeline_id: pipeline.id,
          current_stage_id: stage.id,
          number: firstNumber + index,
          title: `${title} session ${index + 1}`,
          creator_member_id: actorMemberId,
        })),
      )
      .select("id,number,title"),
  );
  const implementation = await read(
    admin
      .from("factory_agent_prompt_revisions")
      .select("id,agent_id,factory_agents!inner(is_default)")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("revision_number", 1)
      .eq("factory_agents.is_default", true)
      .single(),
  );
  await write(
    admin.from("agent_runs").insert(
      sessions.map((session, index): Database["public"]["Tables"]["agent_runs"]["Insert"] => ({
        agent_id: implementation.agent_id,
        agent_prompt_revision_id: implementation.id,
        workspace_id: workspaceId,
        session_id: session.id,
        stage_id: stage.id,
        triggered_by_member_id: runActorMemberId,
        model_name: "gpt-5.5",
        model_provider: "codex",
        run_type: "research",
        status: runStatus(index),
      })),
    ),
  );
  return { stage, sessions };
}

async function selectFactory(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Factory", exact: true }).click();
  await page
    .getByRole("listbox", { name: "Factory", exact: true })
    .getByRole("option", { name, exact: true })
    .click();
}

async function expectFactoryOptions(page: Page, labels: string[]) {
  const factory = page.getByRole("combobox", { name: "Factory", exact: true });
  await factory.click();
  const listbox = page.getByRole("listbox", { name: "Factory", exact: true });
  await expect(listbox.getByRole("option")).toHaveText(labels);
  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true, path });
  await info.attach(name, { contentType: "image/png", path });
}

test("Activity searches actors and pages filtered results within factory access", async ({
  page,
  baseURL,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_QUALIFICATION !== "1",
    "Requires a disposable local Supabase stack.",
  );
  const app = localUrl(baseURL);
  const url = localUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Export the disposable local Supabase keys.");
  const admin = createClient<Database>(url, key, { auth: { persistSession: false } });
  const slug = `activity-nav-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `${slug}-owner@example.test`;
  const memberEmail = `${slug}-member@example.test`;
  const ownerId = await createUser(admin, ownerEmail);
  let memberId: string | undefined;
  let workspaceId: string | undefined;
  try {
    memberId = await createUser(admin, memberEmail);
    const workspace = await read(
      admin.rpc("create_workspace", {
        actor_user_id: ownerId,
        actor_email: ownerEmail,
        requested_slug: slug,
        workspace_name: "Activity qualification",
      }),
    );
    workspaceId = workspace.id;
    const [actor, hiddenActor] = await read(
      admin
        .from("workspace_members")
        .insert([
          {
            workspace_id: workspace.id,
            user_id: memberId,
            email: memberEmail,
            full_name: "Jamie Sample",
            username: "jamie",
            kind: "human",
            role: "member",
          },
          {
            workspace_id: workspace.id,
            full_name: "Private automation",
            kind: "system",
            role: "agent",
          },
        ])
        .select("id,kind"),
    );
    if (actor?.kind !== "human" || hiddenActor?.kind !== "system")
      throw new Error("Missing Activity actors.");
    await write(
      admin
        .from("workspace_onboarding")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("workspace_id", workspace.id),
    );
    const visible = await read(
      admin
        .from("factories")
        .select("id")
        .eq("workspace_id", workspace.id)
        .eq("is_default", true)
        .single(),
    );
    const restricted = await read(
      admin.rpc("create_factory", {
        p_workspace_id: workspace.id,
        p_actor_user_id: ownerId,
        p_name: "Restricted factory",
        p_slug: "restricted-factory",
      }),
    );
    await seedFactoryWork(admin, {
      workspaceId: workspace.id,
      factoryId: visible.id,
      isDefault: true,
      title: "Activity fixture",
      count: 13,
      firstNumber: 1,
      actorMemberId: actor.id,
      runStatus: (index) => (index === 0 ? "success" : "error"),
    });
    await seedFactoryWork(admin, {
      workspaceId: workspace.id,
      factoryId: restricted.id,
      isDefault: false,
      title: "Restricted record",
      count: 1,
      firstNumber: 14,
      runActorMemberId: hiddenActor.id,
    });

    const activityPath = `/w/${workspace.slug}/activity`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, `${activityPath}?factory=${visible.id}`, {
      baseURL: app,
      email: memberEmail,
    });
    const actorTrigger = page.getByRole("button", { name: /^Actor:/ });
    await actorTrigger.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Filter by actor" });
    const search = dialog.getByRole("searchbox", { name: "Search actors" });
    await expect(search).toBeFocused();
    await search.fill("@jamie");
    await dialog.getByRole("link", { name: "Jamie Sample (@jamie)" }).press("Enter");
    await expect(actorTrigger).toHaveText("Actor: Jamie Sample (@jamie)");
    const runs = page.getByRole("region", { name: "Runs", exact: true });
    const sessions = page.getByRole("region", { name: "Sessions", exact: true });
    await selectDropdownOption(runs.getByRole("combobox", { name: "Status" }), "error");
    await expect(runs.getByText(/12 runs match/)).toBeVisible();
    await expect(sessions.getByText(/13 sessions match/)).toBeVisible();
    await expect(runs.getByText("Failed", { exact: true })).toHaveCount(10);
    await expect(runs.getByText("Complete", { exact: true })).toHaveCount(0);
    await capture(page, info, "activity-desktop-filtered");

    const runTitles = () =>
      runs
        .locator("li a")
        .filter({ hasText: /^Activity fixture session/ })
        .allTextContents();
    const latestTitles = await runTitles();
    await runs.getByRole("link", { name: "Older runs" }).press("Enter");
    await expect(page).toHaveURL(/runsBefore=/);
    expect(new URL(page.url()).searchParams.get("actor")).toBe(actor.id);
    expect(new URL(page.url()).searchParams.get("factory")).toBe(visible.id);
    expect(new URL(page.url()).searchParams.get("status")).toBe("error");
    await expect(runs.getByText(/12 runs match · Showing 2 older/)).toBeVisible();
    await expect(sessions.getByText(/13 sessions match · Showing 10 latest/)).toBeVisible();
    expect((await runTitles()).every((title) => !latestTitles.includes(title))).toBe(true);
    await page.goBack();
    await expect(runs.getByText(/12 runs match · Showing 10 latest/)).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "activity-mobile-filtered");
    await selectDropdownOption(runs.getByRole("combobox", { name: "Status" }), "canceled");
    await expect(runs.getByText("No runs match these filters.")).toBeVisible();
    await expect(actorTrigger).toHaveText("Actor: Jamie Sample (@jamie)");
    await runs.getByRole("link", { name: "Clear status filter" }).click();
    await expect(runs.getByText(/13 runs match/)).toBeVisible();

    await page.goto(`${activityPath}?factory=${restricted.id}`);
    await expect(page.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
    await page.getByRole("link", { name: "Show activity for all accessible factories" }).click();
    await actorTrigger.press("Enter");
    await search.fill("Private automation");
    await expect(dialog.getByText("No named actors match.")).toBeVisible();
    await search.press("Escape");
    await expect(actorTrigger).toBeFocused();
    await page.goto(`${activityPath}?actor=${hiddenActor.id}`);
    await expect(actorTrigger).toHaveText("Actor: Actor unavailable");
    await expect(runs.getByText("No runs match these filters.")).toBeVisible();
  } finally {
    if (workspaceId) await write(admin.from("workspaces").delete().eq("id", workspaceId));
    if (memberId) await write(admin.auth.admin.deleteUser(memberId));
    await write(admin.auth.admin.deleteUser(ownerId));
  }
});

test("factory navigation scopes lists, resets incompatible filters, and hides restricted factories", async ({
  page,
  baseURL,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_QUALIFICATION !== "1",
    "Requires a disposable local Supabase stack.",
  );
  test.setTimeout(90_000);
  const app = localUrl(baseURL);
  const url = localUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Export the disposable local Supabase keys.");
  }
  const admin = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slug = `factory-nav-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `${slug}-owner@example.test`;
  const memberEmail = `${slug}-member@example.test`;
  const ownerId = await createUser(admin, ownerEmail);
  let memberId: string | undefined;
  let workspaceId: string | undefined;
  try {
    memberId = await createUser(admin, memberEmail);
    const workspace = await read(
      admin.rpc("create_workspace", {
        actor_user_id: ownerId,
        actor_email: ownerEmail,
        requested_slug: slug,
        workspace_name: "Factory navigation qualification",
      }),
    );
    workspaceId = workspace.id;
    const current = await read(
      admin
        .from("workspace_members")
        .insert({
          workspace_id: workspace.id,
          user_id: memberId,
          email: memberEmail,
          full_name: "Jamie Sample",
          kind: "human",
          role: "member",
        })
        .select("id")
        .single(),
    );
    const createFactory = (name: string, factorySlug: string) =>
      read(
        admin.rpc("create_factory", {
          p_workspace_id: workspace.id,
          p_actor_user_id: ownerId,
          p_name: name,
          p_slug: factorySlug,
        }),
      );
    const defaultFactory = await read(
      admin
        .from("factories")
        .select("id,name")
        .eq("workspace_id", workspace.id)
        .eq("is_default", true)
        .single(),
    );
    const visibleFactory = await createFactory("Customer tools", "customer-tools");
    const restrictedFactory = await createFactory("Restricted factory", "restricted-factory");
    await write(
      admin.rpc("grant_factory_membership", {
        p_workspace_id: workspace.id,
        p_actor_user_id: ownerId,
        p_factory_id: visibleFactory.id,
        p_member_id: current.id,
        p_role: "member",
      }),
    );
    await write(
      admin
        .from("workspace_onboarding")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("workspace_id", workspace.id),
    );
    const initial = await seedFactoryWork(admin, {
      workspaceId: workspace.id,
      factoryId: defaultFactory.id,
      isDefault: true,
      title: "Default",
      count: 1,
      firstNumber: 1,
    });
    const visible = await seedFactoryWork(admin, {
      workspaceId: workspace.id,
      factoryId: visibleFactory.id,
      isDefault: false,
      title: "Customer tools",
      count: 1,
      firstNumber: 2,
      actorMemberId: current.id,
    });
    await seedFactoryWork(admin, {
      workspaceId: workspace.id,
      factoryId: restrictedFactory.id,
      isDefault: false,
      title: "Restricted",
      count: 2,
      firstNumber: 3,
    });

    const workspacePath = `/w/${workspace.slug}`;
    const agentsPath = `${workspacePath}/agents`;
    const sessionsPath = `${workspacePath}/sessions`;
    const runsPath = `${workspacePath}/runs`;
    const defaultLink = page.getByRole("link", { name: /Open session #\d+: Default session 1/ });
    const visibleLink = page.getByRole("link", {
      name: /Open session #\d+: Customer tools session 1/,
    });
    const factory = page.getByRole("combobox", { name: "Factory", exact: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(
      page,
      `${sessionsPath}?factory=${defaultFactory.id}&stage=${initial.stage.slug}&q=session&sort=oldest`,
      { baseURL: app, email: memberEmail },
    );
    await expect(defaultLink).toBeVisible();
    await expect(visibleLink).toHaveCount(0);
    await expectFactoryOptions(page, ["All factories", defaultFactory.name, visibleFactory.name]);
    await expect(page.getByRole("link", { name: "Factory definition", exact: true })).toHaveCount(
      0,
    );
    await selectFactory(page, "Customer tools");
    await expect(visibleLink).toBeVisible();
    await expect(defaultLink).toHaveCount(0);
    const switchedQuery = new URL(page.url()).searchParams;
    expect(switchedQuery.get("factory")).toBe(visibleFactory.id);
    expect(switchedQuery.has("stage")).toBe(false);
    expect(switchedQuery.get("q")).toBe("session");
    expect(switchedQuery.get("sort")).toBe("oldest");
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Agents", exact: true, level: 1 }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("factory")).toBe(visibleFactory.id);
    await expectFactoryOptions(page, [defaultFactory.name, visibleFactory.name]);
    await expect(page.getByRole("link", { name: "New agent" })).toHaveCount(0);
    const agents = page.getByRole("region", { name: "Factory agents" });
    const secondaryAgentHref = await agents.getByRole("link").getAttribute("href");
    if (!secondaryAgentHref) throw new Error("Missing the delegated factory agent.");
    expect(new URL(secondaryAgentHref, app).searchParams.get("factory")).toBe(visibleFactory.id);
    await capture(page, info, "05-agents-desktop-light");
    const wrongFactory = new URL(secondaryAgentHref, app);
    wrongFactory.searchParams.set("factory", defaultFactory.id);
    const wrongScope = await page.goto(wrongFactory.href);
    expect(wrongScope?.status()).toBe(404);
    await page.goto(`${agentsPath}?factory=${restrictedFactory.id}`);
    await expect(
      page.getByRole("heading", { name: "Factory unavailable", exact: true }),
    ).toBeVisible();
    await expect(agents).toHaveCount(0);
    await page.goto(`${sessionsPath}?factory=${visibleFactory.id}`);
    await selectFactory(page, "All factories");
    const ledger = page.getByRole("table", { name: "Sessions", exact: true });
    await expect(ledger.getByRole("row")).toHaveCount(3);
    await expect(defaultLink).toBeVisible();
    await expect(visibleLink).toBeVisible();
    await expect(page.getByText(/Restricted/u)).toHaveCount(0);
    await capture(page, info, "01-desktop-light-authorized-factories");

    await page.goto(`${sessionsPath}?factory=${restrictedFactory.id}`);
    await expect(
      page.getByRole("heading", { name: "Factory unavailable", exact: true }),
    ).toBeVisible();
    await expect(ledger).toHaveCount(0);
    await expect(page.getByText(/Restricted/u)).toHaveCount(0);
    await capture(page, info, "04-restricted-factory-unavailable");

    const defaultSession = initial.sessions[0];
    if (!defaultSession) throw new Error("Missing the default session fixture.");
    await page.goto(
      `${runsPath}?factory=${defaultFactory.id}&sessionId=${defaultSession.id}&stageId=${initial.stage.id}`,
    );
    await expect(page.getByText("1 run on this page", { exact: true })).toBeVisible();
    await selectFactory(page, "Customer tools");
    await expect(page.getByRole("list", { name: "Runs", exact: true })).toContainText(
      "Customer tools session 1",
    );
    expect(new URL(page.url()).searchParams.has("stageId")).toBe(false);
    expect(new URL(page.url()).searchParams.has("sessionId")).toBe(false);
    await selectFactory(page, "All factories");
    await expect(page.getByText("2 runs on this page", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${workspacePath}?factory=${visibleFactory.id}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.getByText("Customer tools session 1", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByText("Default session 1", { exact: true })).toHaveCount(0);
    await expectFactoryOptions(page, ["All factories", defaultFactory.name, visibleFactory.name]);
    await capture(page, info, "02-mobile-dark-factory-selector");
    const trigger = page.getByRole("button", { name: "Workspace navigation: Pipeline" });
    await trigger.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    await expect(drawer.getByRole("link", { name: "Pipeline", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(drawer.getByRole("link", { name: "Factory definition", exact: true })).toHaveCount(
      0,
    );
    await capture(page, info, "03-mobile-dark-navigation-drawer");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();

    const visibleSession = visible.sessions[0];
    if (!visibleSession) throw new Error("Missing the delegated factory session fixture.");
    await page.goto(`${sessionsPath}/${visibleSession.number}`);
    await expect(page.getByRole("heading", { level: 1, name: visibleSession.title })).toBeVisible();
    await seedFactoryWork(admin, {
      workspaceId: workspace.id,
      factoryId: defaultFactory.id,
      isDefault: true,
      title: "Older activity",
      count: 30,
      firstNumber: 5,
    });
    const selectedRun = await read(
      admin.from("agent_runs").select("id").eq("session_id", visibleSession.id).single(),
    );
    const activityPath = `${workspacePath}/activity`;
    const governancePath = `${workspacePath}/governance`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(activityPath);
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(factory).toHaveText("All factories");
    await expect(factory).toHaveAttribute("data-value", "all");
    await expect(page.getByRole("main").getByText(/Restricted/u)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Governance", exact: true })).toHaveCount(0);
    // The total reflects all authorized rows even when only a bounded preview is visible.
    await expect(page.getByRole("main")).toContainText(/32 sessions/i);
    await expect(page.getByRole("main")).toContainText(/32 runs/i);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await capture(page, info, "06-activity-desktop-light");

    await selectFactory(page, "Customer tools");
    const main = page.getByRole("main");
    await expect(
      main
        .getByRole("region", { name: "Sessions", exact: true })
        .getByRole("link", { name: visibleSession.title, exact: true }),
    ).toHaveAttribute("href", `${sessionsPath}/${visibleSession.number}`);
    await expect(main.locator(`a[href="${runsPath}/${selectedRun.id}"]`)).toBeVisible();
    const actor = main.getByRole("link", { name: "Jamie Sample", exact: true }).first();
    await actor.press("Enter");
    await expect(page).toHaveURL(new RegExp(`[?&]actor=${current.id}(?:&|$)`));
    await expect(main.getByText("Older activity", { exact: false })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "07-activity-mobile-dark");

    await page.goto(`${activityPath}?factory=all&actor=${randomUUID()}`);
    await expect(main.getByText("No sessions match these filters.", { exact: true })).toBeVisible();
    await expect(main.getByText("No runs match these filters.", { exact: true })).toBeVisible();

    await page.goto(`${activityPath}?factory=${restrictedFactory.id}`);
    await expect(page.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
    await page.goto(`${governancePath}?factory=${visibleFactory.id}`);
    await expect(
      page.getByRole("heading", { name: "Factory manager access required" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage your connected clients" })).toHaveAttribute(
      "href",
      /\/settings\?category=workspace#connected-clients$/,
    );

    await write(
      admin.rpc("grant_factory_membership", {
        p_workspace_id: workspace.id,
        p_factory_id: visibleFactory.id,
        p_actor_user_id: ownerId,
        p_member_id: current.id,
        p_role: "manager",
      }),
    );
    const externalId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 10), 16);
    const installation = await read(
      admin
        .from("github_installations")
        .insert({
          workspace_id: workspace.id,
          installation_id: externalId,
          installation_url: `https://github.test/installations/${externalId}`,
          app_id: 1,
          target_type: "Organization",
          target_name: "factory-demo",
          permissions: { contents: "write", pull_requests: "write" },
        })
        .select("id")
        .single(),
    );
    const repository = await read(
      admin
        .from("github_repositories")
        .insert({
          workspace_id: workspace.id,
          factory_id: visibleFactory.id,
          github_installation_id: installation.id,
          repo_id: externalId,
          name: "agent-control",
          full_name: "factory-demo/agent-control",
          private: true,
          html_url: "https://github.test/factory-demo/agent-control",
          default_branch: "main",
        })
        .select("id, full_name")
        .single(),
    );
    const budget = await read(
      admin.rpc("save_execution_policy", {
        p_workspace_id: workspace.id,
        p_actor_user_id: ownerId,
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

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(governancePath);
    await expect(page.getByRole("heading", { name: "Governance", level: 1 })).toBeVisible();
    await expect(factory).toHaveText(visibleFactory.name);
    await expect(factory).toHaveAttribute("data-value", visibleFactory.id);
    await expectFactoryOptions(page, [visibleFactory.name]);
    await expect(page.getByRole("link", { name: "Governance", exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "Principal name", exact: true }).fill("Release runner");
    await expect(page.getByRole("textbox", { name: "Identifier", exact: true })).toHaveValue(
      "release-runner",
    );
    const principalCreated = page.waitForResponse(
      (response) =>
        response.url().endsWith("/service-principals") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create service principal" }).click();
    expect((await principalCreated).status()).toBe(201);
    const principal = await read(
      admin.from("service_principals").select("id").eq("factory_id", visibleFactory.id).single(),
    );
    await selectDropdownOption(
      page.getByRole("combobox", { name: "Service principal", exact: true }),
      principal.id,
    );
    await selectDropdownOption(
      page.getByRole("combobox", { name: "Writable repository", exact: true }),
      repository.id,
    );
    await selectDropdownOption(
      page.getByRole("combobox", { name: "Execution policy", exact: true }),
      budget.id,
    );
    await selectDropdownOption(
      page.getByRole("combobox", { name: "Budget payer", exact: true }),
      current.id,
    );
    await page.getByLabel("Expires at", { exact: true }).fill(
      await page.evaluate(() => {
        const expiry = new Date(Date.now() + 2 * 60 * 60 * 1000);
        const local = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60_000);
        return local.toISOString().slice(0, 16);
      }),
    );
    const grantApproved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/execution-grants") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Approve grant", exact: true }).click();
    expect((await grantApproved).status()).toBe(201);
    await expect(main.getByText("Machine command scopes", { exact: true })).toBeVisible();
    const grant = await read(
      admin
        .from("factory_execution_grants")
        .select("id,version,approved_by_member_id")
        .eq("factory_id", visibleFactory.id)
        .single(),
    );
    expect(grant).toMatchObject({ version: 1, approved_by_member_id: current.id });

    const fixtureSecretKey = "FACTORY_GOVERNANCE_FIXTURE_CREDENTIAL";
    const fixtureCiphertext = "unreadable-fixture-ciphertext";
    const sourceSecret = await read(
      admin
        .from("workspace_secrets")
        .insert({
          workspace_id: workspace.id,
          key: fixtureSecretKey,
          encrypted_value: fixtureCiphertext,
        })
        .select("id")
        .single(),
    );
    const assignedAgent = await read(
      admin
        .from("factory_agents")
        .select("id")
        .eq("factory_id", visibleFactory.id)
        .eq("is_default", true)
        .single(),
    );
    const credential = await read(
      admin.rpc("create_factory_secret_binding", {
        p_workspace_id: workspace.id,
        p_factory_id: visibleFactory.id,
        p_actor_user_id: ownerId,
        p_execution_grant_id: grant.id,
        p_execution_grant_version: grant.version,
        p_factory_agent_id: assignedAgent.id,
        p_agent_provider: "codex",
        p_workspace_secret_id: sourceSecret.id,
      }),
    );
    const credentialHref = `${governancePath}?factory=${visibleFactory.id}&binding=${credential.id}`;
    await page.goto(credentialHref);
    const ownership = main.locator("#credential-ownership");
    await expect(ownership.getByText(credential.id, { exact: true })).toBeVisible();
    await expect(
      ownership.getByRole("link", { name: "Release runner", exact: true }),
    ).toBeVisible();
    await expect(main).not.toContainText(fixtureSecretKey);
    await expect(main).not.toContainText(fixtureCiphertext);
    await expect(main).not.toContainText(sourceSecret.id);

    const grantHref = `${governancePath}?factory=${visibleFactory.id}&grant=${grant.id}`;
    await page.goto(grantHref);
    await expect(page.getByRole("button", { name: "Revoke grant", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await capture(page, info, "08-governance-desktop-light");
    await page.getByRole("button", { name: "Revoke grant", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Revoke this execution grant?" });
    await expect(confirm).toContainText(
      `v${grant.version} for Release runner · ${repository.full_name}`,
    );
    await confirm
      .getByRole("textbox", { name: "Reason (optional)" })
      .fill("Rotate the release policy");
    const grantRevoked = page.waitForResponse(
      (response) =>
        response.url().endsWith("/execution-grants") && response.request().method() === "POST",
    );
    await confirm.getByRole("button", { name: "Revoke grant", exact: true }).click();
    expect((await grantRevoked).status()).toBe(200);
    await expect(main.getByText("Revoked", { exact: true }).first()).toBeVisible();
    const event = await read(
      admin
        .from("factory_audit_events")
        .select("id,actor_member_id")
        .eq("factory_id", visibleFactory.id)
        .eq("action", "execution_grant.revoked")
        .eq("detail->>id", grant.id)
        .single(),
    );
    expect(event.actor_member_id).toBe(current.id);
    const eventHref = `${governancePath}?factory=${visibleFactory.id}&event=${event.id}`;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(eventHref);
    await expect(
      main.getByText("Rotate the release policy", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: "Jamie Sample", exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "09-governance-mobile-dark-audit");

    await page.goto(`${governancePath}?factory=${defaultFactory.id}&event=${event.id}`);
    await expect(page.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
  } finally {
    if (workspaceId) await write(admin.from("workspaces").delete().eq("id", workspaceId));
    if (memberId) await write(admin.auth.admin.deleteUser(memberId));
    await write(admin.auth.admin.deleteUser(ownerId));
  }
});
