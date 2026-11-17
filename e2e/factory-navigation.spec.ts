import { randomUUID } from "node:crypto";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";

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
  }: {
    workspaceId: string;
    factoryId: string;
    title: string;
    isDefault: boolean;
    count: number;
    firstNumber: number;
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
        })),
      )
      .select("id,number,title"),
  );
  await write(
    admin.from("agent_runs").insert(
      sessions.map((session): Database["public"]["Tables"]["agent_runs"]["Insert"] => ({
        workspace_id: workspaceId,
        session_id: session.id,
        stage_id: stage.id,
        model_name: "gpt-5.5",
        model_provider: "codex",
        run_type: "research",
        status: "success",
      })),
    ),
  );
  return { stage, sessions };
}

async function selectFactory(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Factory", exact: true }).selectOption({ label: name });
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
    await expect(factory.locator("option")).toHaveText([
      "All factories",
      defaultFactory.name,
      visibleFactory.name,
    ]);
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
    await expect(page.getByText("Customer tools session 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Default session 1", { exact: true })).toHaveCount(0);
    await expect(factory.locator("option")).toHaveText([
      "All factories",
      defaultFactory.name,
      visibleFactory.name,
    ]);
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
  } finally {
    if (workspaceId) await write(admin.from("workspaces").delete().eq("id", workspaceId));
    if (memberId) await write(admin.auth.admin.deleteUser(memberId));
    await write(admin.auth.admin.deleteUser(ownerId));
  }
});
