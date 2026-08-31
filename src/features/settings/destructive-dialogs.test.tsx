// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { DangerZoneSection } from "@/features/settings/danger-zone-section";
import { LinearKeyControls } from "@/features/settings/linear-key-controls";
import { WorkspaceSecretsPanel } from "@/features/settings/secrets-section";
import { WorkspaceMembersSection } from "@/features/settings/workspace-members-section";
import { maxProfileAvatarBytes } from "@/lib/storage/profile-avatar-contracts";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-07-17T12:00:00.000Z";
const axeOptions = { rules: { "color-contrast": { enabled: false } } };

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: query.includes("reduce"),
      media: query,
      removeEventListener: vi.fn(),
    })),
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:profile-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

function renderSettingsDestructiveFlows() {
  return render(
    <OverlayProvider>
      <DangerZoneSection canDelete workspaceId={workspaceId} workspaceName="Acme" />
      <DangerZoneSection canDelete={false} workspaceId={workspaceId} workspaceName="Acme" />
      <WorkspaceMembersSection
        canManage
        currentMemberId="owner-1"
        initialInvitations={[
          {
            acceptedAt: null,
            acceptedByMemberId: null,
            createdAt: timestamp,
            email: "invitee@example.com",
            expiresAt: timestamp,
            fullName: "Invitee Person",
            id: "invitation-1",
            invitedByMemberId: "owner-1",
            lastSentAt: timestamp,
            revokedAt: null,
            role: "member",
            status: "pending",
            updatedAt: timestamp,
            workspaceId,
          },
        ]}
        setFlashMessage={vi.fn()}
        workspaceId={workspaceId}
        workspaceMembers={[
          {
            avatarUrl: "https://provider.example/owner.png",
            email: "owner@example.com",
            fullName: "Owner",
            id: "owner-1",
            role: "owner",
          },
          {
            avatarUrl: null,
            email: "ada@example.com",
            fullName: "Ada",
            id: "member-1",
            role: "member",
          },
        ]}
      />
      <LinearKeyControls
        canManage
        linearSecret={{
          createdAt: timestamp,
          createdByMemberId: "owner-1",
          id: "linear-secret",
          key: "LINEAR_API_KEY",
          updatedAt: timestamp,
          valuePreview: "••••1234",
          workspaceId,
        }}
        workspaceId={workspaceId}
      />
      <WorkspaceSecretsPanel
        canManage
        isLoadingSecrets={false}
        secrets={[
          {
            createdAt: timestamp,
            createdByMemberId: "owner-1",
            id: "deploy-secret",
            key: "DEPLOY_TOKEN",
            updatedAt: timestamp,
            valuePreview: "••••5678",
            workspaceId,
          },
        ]}
        setFlashMessage={vi.fn()}
        setSecrets={vi.fn()}
        workspaceId={workspaceId}
      />
    </OverlayProvider>,
  );
}

describe("destructive settings dialogs", () => {
  it("uses a generic placeholder for workspace secret keys", () => {
    renderSettingsDestructiveFlows();

    expect(screen.getByPlaceholderText("SERVICE_API_KEY…")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("LINEAR_API_KEY…")).not.toBeInTheDocument();
  });
  it("uses labelled Dialogs with focused fields for member invitations and role changes", async () => {
    const user = userEvent.setup();
    renderSettingsDestructiveFlows();

    const inviteTrigger = screen.getByRole("button", { name: "Invite member" });
    await user.click(inviteTrigger);
    const inviteDialog = await screen.findByRole("dialog", {
      name: "Invite a workspace member",
    });
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
    expect((await axe.run(document.body, axeOptions)).violations).toEqual([]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(inviteDialog).not.toBeInTheDocument());
    expect(inviteTrigger).toHaveFocus();

    const roleTrigger = screen.getByRole("button", { name: "Change role (Member)" });
    await user.click(roleTrigger);
    expect(
      await screen.findByRole("dialog", { name: "Change role for Ada" }),
    ).toHaveAccessibleDescription(
      "Choose Ada's access. Changing an admin to member removes workspace management access.",
    );
    expect((await axe.run(document.body, axeOptions)).violations).toEqual([]);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Change role for Ada" })).toBeNull(),
    );
    expect(roleTrigger).toHaveFocus();
  });

  it("lets the current member update their account-wide profile", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        profile: { avatarUrl: "https://provider.example/owner.png", fullName: "Anant Jain" },
      }),
    );
    renderSettingsDestructiveFlows();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit profile" });
    expect(dialog).toHaveAccessibleDescription(
      "Your name and photo are shown on member lists in every workspace you belong to.",
    );
    const input = within(dialog).getByLabelText("Name");
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, "Anant Jain");
    await user.click(within(dialog).getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.getByText("Anant Jain")).toBeInTheDocument();
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request).toEqual(
      expect.objectContaining({ body: expect.any(FormData), method: "PATCH" }),
    );
    const body = request?.body as FormData;
    expect(body.get("avatarAction")).toBe("keep");
    expect(body.get("fullName")).toBe("Anant Jain");
  });

  it("previews a replacement locally and cancels without saving", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderSettingsDestructiveFlows();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit profile" });
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(["image"], "new-avatar.png", { type: "image/png" }));

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Change photo" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears a pending replacement when the next selected image is invalid", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        profile: { avatarUrl: "https://provider.example/owner.png", fullName: "Owner" },
      }),
    );
    renderSettingsDestructiveFlows();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit profile" });
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(["image"], "valid.png", { type: "image/png" }));
    expect(dialog.querySelector('img[src="blob:profile-preview"]')).not.toBeNull();

    await user.upload(
      fileInput,
      new File([new Uint8Array(maxProfileAvatarBytes + 1)], "oversized.png", {
        type: "image/png",
      }),
    );

    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Profile photos must stay under 2 MB.",
    );
    expect(dialog.querySelector('img[src="blob:profile-preview"]')).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get("avatarAction")).toBe("keep");
    expect(body.get("file")).toBeNull();
  });

  it("removes the current photo and renders the initials fallback", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ profile: { avatarUrl: null, fullName: "Owner" } }));
    renderSettingsDestructiveFlows();

    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit profile" });
    await user.click(within(dialog).getByRole("button", { name: "Remove photo" }));
    expect(within(dialog).getByText("O")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    const request = fetchMock.mock.calls[0]?.[1];
    const body = request?.body as FormData;
    expect(body.get("avatarAction")).toBe("remove");
  });

  it("submits and renders the required invitation name", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        invitation: {
          acceptedAt: null,
          acceptedByMemberId: null,
          createdAt: timestamp,
          email: "new@example.com",
          expiresAt: timestamp,
          fullName: "New Person",
          id: "invitation-2",
          invitedByMemberId: "owner-1",
          lastSentAt: timestamp,
          revokedAt: null,
          role: "member",
          status: "pending",
          updatedAt: timestamp,
          workspaceId,
        },
      }),
    );
    renderSettingsDestructiveFlows();

    await user.click(screen.getByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a workspace member" });
    await user.type(within(dialog).getByLabelText("Name"), "New Person");
    await user.type(within(dialog).getByLabelText("Email"), "new@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.getByText("New Person")).toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/${workspaceId}/invitations`,
      expect.objectContaining({
        body: JSON.stringify({
          email: "new@example.com",
          fullName: "New Person",
          role: "member",
        }),
        method: "POST",
      }),
    );
  });

  it.each([
    ["Delete workspace", "Delete Acme?"],
    ["Leave workspace", "Leave Acme?"],
    ["Remove Ada", "Remove Ada?"],
    ["Revoke invitation for invitee@example.com", "Revoke invitee@example.com's invitation?"],
    ["Remove Linear API key", "Remove Linear API key?"],
    ["Delete DEPLOY_TOKEN", "Delete DEPLOY_TOKEN?"],
  ])(
    "supports keyboard dismissal, focus restoration, and axe for %s",
    async (triggerName, title) => {
      const user = userEvent.setup();
      renderSettingsDestructiveFlows();

      const trigger = screen.getByRole("button", { name: triggerName });
      await user.click(trigger);
      expect(await screen.findByRole("alertdialog", { name: title })).toBeVisible();
      expect((await axe.run(document.body, axeOptions)).violations).toEqual([]);

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("alertdialog", { name: title })).toBeNull());
      expect(trigger).toHaveFocus();
    },
  );

  it("keeps a failed Linear-key removal open for retry and blocks dismissal while pending", async () => {
    const user = userEvent.setup();
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRequest = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deletedKey: "LINEAR_API_KEY" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    const onSecretDeleted = vi.fn();

    render(
      <OverlayProvider>
        <LinearKeyControls
          canManage
          linearSecret={{
            createdAt: timestamp,
            createdByMemberId: "owner-1",
            id: "linear-secret",
            key: "LINEAR_API_KEY",
            updatedAt: timestamp,
            valuePreview: "••••1234",
            workspaceId,
          }}
          onSecretDeleted={onSecretDeleted}
          workspaceId={workspaceId}
        />
      </OverlayProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Remove Linear API key" }));
    await user.click(screen.getByRole("button", { name: "Remove Linear API key" }));
    expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeVisible();

    resolveRequest?.(
      new Response(JSON.stringify({ error: "Temporary Linear outage." }), {
        headers: { "content-type": "application/json" },
        status: 503,
      }),
    );
    const alertDialog = screen.getByRole("alertdialog");
    expect(await within(alertDialog).findByText("Temporary Linear outage.")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(alertDialog).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Remove Linear API key" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSecretDeleted).toHaveBeenCalledWith("LINEAR_API_KEY");
  });
});
