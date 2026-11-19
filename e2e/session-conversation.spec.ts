import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { workspaceSessionDetailPath } from "@/lib/routes";
import type { SessionConversationPage } from "@/lib/sessions/conversation-contracts";
import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";

test.use({ screenshot: "off", trace: "off" });

function localOrigin(value: string | undefined) {
  if (!value) throw new Error("Set the disposable app and Supabase URLs.");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Conversation qualification requires loopback services.");
  }
  return url.origin;
}

async function checked<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  return data;
}

async function row<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const data = await checked(operation);
  if (data === null) throw new Error("Conversation fixture row is missing.");
  return data;
}

test("shares a scoped conversation, catches up in order and hides revoked history", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(process.env.WALLIE_CONVERSATION_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(60_000);

  const app = localOrigin(baseURL);
  const supabase = localOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!serviceKey) throw new Error("Set the disposable Supabase service key.");
  const admin = createClient<Database>(supabase, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const slug = `conversation-proof-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `${slug}@example.test`;
  const readerEmail = `${slug}-reader@example.test`;
  const original = "The initial conversation request.";
  const sourced = "Shared follow-up from the source thread.";
  const reconnect = "Added after the browser closed the conversation.";
  const sourceLabel = "Project discussion";
  const sourceUrl = "https://example.test/discussion/42";
  let workspaceId: string | undefined;
  const userIds: string[] = [];

  async function createUser(email: string) {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    userIds.push(data.user.id);
    return data.user;
  }

  try {
    const owner = await createUser(ownerEmail);
    const reader = await createUser(readerEmail);
    const workspace = await row(
      admin.rpc("create_workspace", {
        actor_user_id: owner.id,
        actor_email: ownerEmail,
        requested_slug: slug,
        workspace_name: "Conversation proof",
      }),
    );
    workspaceId = workspace.id;
    const [member, factory, stage, readerMember] = await Promise.all([
      row(
        admin
          .from("workspace_members")
          .select("id")
          .eq("workspace_id", workspace.id)
          .eq("user_id", owner.id)
          .single(),
      ),
      row(
        admin
          .from("factories")
          .select("id")
          .eq("workspace_id", workspace.id)
          .eq("is_default", true)
          .single(),
      ),
      row(
        admin
          .from("pipeline_stages")
          .select("id, pipeline_id")
          .eq("workspace_id", workspace.id)
          .order("position")
          .limit(1)
          .single(),
      ),
      row(
        admin
          .from("workspace_members")
          .insert({
            workspace_id: workspace.id,
            user_id: reader.id,
            email: readerEmail,
            full_name: "Project collaborator",
            kind: "human",
            role: "member",
          })
          .select("id")
          .single(),
      ),
    ]);
    await checked(
      admin.from("workspace_members").update({ full_name: "Project owner" }).eq("id", member.id),
    );
    const memberScope = {
      p_workspace_id: workspace.id,
      p_factory_id: factory.id,
      p_actor_user_id: owner.id,
      p_member_id: readerMember.id,
    };
    await checked(admin.rpc("grant_factory_membership", { ...memberScope, p_role: "member" }));

    const session = await row(
      admin
        .from("sessions")
        .insert({
          workspace_id: workspace.id,
          factory_id: factory.id,
          creator_member_id: member.id,
          current_stage_id: stage.id,
          pipeline_id: stage.pipeline_id,
          number: 1,
          phase_status: "approved",
          title: "Shared conversation proof",
          prompt_md: original,
        })
        .select("id, number")
        .single(),
    );
    const scope = {
      p_workspace_id: workspace.id,
      p_session_id: session.id,
      p_factory_id: factory.id,
      p_actor_member_id: member.id,
    };
    const source = await row(
      admin
        .rpc("bind_session_conversation_source_once", {
          ...scope,
          p_provider: "fixture",
          p_source_namespace: "project",
          p_external_thread_id: "discussion-42",
          p_label: sourceLabel,
          p_source_url: sourceUrl,
        })
        .single(),
    );
    const append = (body: string, request = randomUUID()) =>
      row(
        admin
          .rpc("append_session_conversation_message_once", {
            ...scope,
            p_request_id: request,
            p_body_md: body,
          })
          .single(),
      );
    for (let index = 1; index <= 22; index++) {
      await append(`Conversation entry ${index}.`);
    }
    const sourceRequest = {
      ...scope,
      p_actor_member_id: readerMember.id,
      p_request_id: randomUUID(),
      p_body_md: `${sourced}\n\n![Hidden external image](https://assets.invalid/example.png)`,
      p_source_id: source.id,
      p_external_message_id: "message-23",
      p_external_actor_id: "source-author",
    };
    const publishSource = () =>
      row(admin.rpc("append_session_conversation_message_once", sourceRequest).single());
    const sent = await publishSource();
    expect(await publishSource()).toEqual({ sequence: sent.sequence, replayed: true });

    const sessionPath = workspaceSessionDetailPath(slug, session.number);
    const endpoint = `/api/sessions/${session.id}/conversation`;
    await signInViaMagicLink(page, sessionPath, { baseURL: app, email: ownerEmail });
    const disclosure = page.getByRole("button", { name: "Conversation", exact: true });
    const region = page.getByRole("region", { name: "Conversation" });
    await expect(region).toHaveCount(0);
    await disclosure.click();
    await expect(region.getByText(sourced)).toBeVisible();
    await expect(region.getByText(sourced)).toHaveCount(1);
    await expect(
      region.getByRole("listitem").filter({ hasText: sourced }).getByText("Project collaborator"),
    ).toBeVisible();
    await expect(region.locator("img")).toHaveCount(0);
    await expect(region.getByRole("link", { name: new RegExp(sourceLabel) })).toHaveAttribute(
      "href",
      sourceUrl,
    );
    await expect(region.getByText(original)).toHaveCount(0);
    await region.getByRole("button", { name: "Load older messages" }).click();
    await expect(region.getByText(original)).toBeVisible();
    await expect(region.getByRole("button", { name: "Load older messages" })).toHaveCount(0);

    await disclosure.click();
    await append(reconnect);
    await disclosure.click();
    await expect(region.getByText(reconnect)).toBeVisible();
    await expect(region.getByText(original)).toHaveCount(1);
    const desktopResponse = await page.request.get(endpoint);
    expect(desktopResponse.status()).toBe(200);
    expect(desktopResponse.headers()["cache-control"]).toBe("private, no-store");
    const desktop: SessionConversationPage = await desktopResponse.json();
    expect(desktop.messages.at(-1)?.sequence).toBeGreaterThan(sent.sequence);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("01-conversation-desktop.png"),
      fullPage: true,
    });

    const mobile = await browser.newContext({
      baseURL: app,
      colorScheme: "dark",
      viewport: { width: 390, height: 844 },
    });
    try {
      const collaborator = await mobile.newPage();
      await signInViaMagicLink(collaborator, sessionPath, { baseURL: app, email: readerEmail });
      await collaborator.getByRole("button", { name: "Conversation", exact: true }).click();
      const shared = collaborator.getByRole("region", { name: "Conversation" });
      await expect(shared.getByText(reconnect)).toBeVisible();
      const readerResponse = await collaborator.request.get(endpoint);
      expect(readerResponse.status()).toBe(200);
      const readerView: SessionConversationPage = await readerResponse.json();
      expect(readerView.sources.map(({ id }) => id)).toEqual([source.id]);
      expect(readerView.messages.map(({ sequence }) => sequence)).toEqual(
        desktop.messages.map(({ sequence }) => sequence),
      );
      await collaborator.screenshot({
        path: testInfo.outputPath("02-conversation-mobile-dark.png"),
        fullPage: true,
      });

      await checked(admin.rpc("revoke_factory_membership", memberScope));
      const forbidden = await collaborator.request.get(endpoint);
      expect(forbidden.status()).toBe(404);
      expect(await forbidden.json()).toEqual({ error: "Session not found." });
      await collaborator.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(
        collaborator.getByRole("heading", { name: "Factory unavailable" }),
      ).toBeVisible();
      await expect(shared.getByText(reconnect)).toHaveCount(0);
      await expect(shared.getByText(sourceLabel)).toHaveCount(0);
      await collaborator.screenshot({
        path: testInfo.outputPath("03-conversation-access-revoked.png"),
        fullPage: true,
      });
    } finally {
      await mobile.close();
    }
  } finally {
    if (workspaceId) await checked(admin.from("workspaces").delete().eq("id", workspaceId));
    await Promise.all(
      userIds.map(async (id) => {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) throw error;
      }),
    );
  }
});
