// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { DangerZoneSection } from "@/features/settings/danger-zone-section";
import type { WorkspaceInvitationsSnapshot } from "@/features/settings/data";
import { LinearKeyControls } from "@/features/settings/linear-key-controls";
import { WorkspaceSecretsPanel } from "@/features/settings/secrets-section";
import { WorkspaceMembersSection } from "@/features/settings/workspace-members-section";
import { WorkspaceInvitationsSection } from "@/features/settings/workspace-invitations-section";
import { WorkspaceProfileSection } from "@/features/settings/workspace-profile-section";
import { WorkspaceSettingsLoadError } from "@/features/settings/workspace-settings-load-error";
import { maxProfileAvatarBytes } from "@/lib/storage/profile-avatar-contracts";
import type { WorkspaceInvitation } from "@/lib/workspace-invitations/contracts";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-07-17T12:00:00.000Z";
const asOf = Date.parse(timestamp);
const pendingInvitation: WorkspaceInvitation = {
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
};
const resentInvitation: WorkspaceInvitation = {
  ...pendingInvitation,
  expiresAt: "2026-07-18T12:00:00.000Z",
  updatedAt: "2026-07-17T12:00:00.000002Z",
};
const axeOptions = { rules: { "color-contrast": { enabled: false } } };
const axeTestTimeout = 15_000;

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  refresh.mockClear();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

function renderSettingsDestructiveFlows() {
  return render(
    <OverlayProvider>
      <DangerZoneSection canDelete workspaceId={workspaceId} workspaceName="Acme" />
      <DangerZoneSection canDelete={false} workspaceId={workspaceId} workspaceName="Acme" />
      <WorkspaceProfileSection
        initialProfile={{ avatarUrl: "https://provider.example/owner.png", fullName: "Owner" }}
      />
      <WorkspaceInvitationsSection
        snapshot={{ asOf, invitations: [pendingInvitation] }}
        workspaceId={workspaceId}
      />
      <WorkspaceMembersSection
        canManage
        currentMemberId="owner-1"
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
          {
            avatarUrl: null,
            email: "ada.second@example.com",
            fullName: "Ada",
            id: "member-2",
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

function invitationsView(snapshot: WorkspaceInvitationsSnapshot) {
  return (
    <OverlayProvider>
      <WorkspaceInvitationsSection snapshot={snapshot} workspaceId={workspaceId} />
    </OverlayProvider>
  );
}

describe("destructive settings dialogs", () => {
  it("uses a generic placeholder for workspace secret keys", () => {
    renderSettingsDestructiveFlows();

    expect(screen.getByPlaceholderText("SERVICE_API_KEY…")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("LINEAR_API_KEY…")).not.toBeInTheDocument();
  });
  it(
    "uses labelled Dialogs with focused fields for member invitations and role changes",
    async () => {
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

      const roleTrigger = screen.getByRole("button", {
        name: "Change role (Member) for Ada (ada@example.com)",
      });
      await user.click(roleTrigger);
      expect(
        await screen.findByRole("dialog", { name: "Change role for Ada" }),
      ).toHaveAccessibleDescription(
        "ada@example.com Choose Ada's access. Changing an admin to member removes workspace management access.",
      );
      expect((await axe.run(document.body, axeOptions)).violations).toEqual([]);
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Change role for Ada" })).toBeNull(),
      );
      expect(roleTrigger).toHaveFocus();
    },
    axeTestTimeout,
  );

  it("identifies the second of two same-name members in the roster and confirmations", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ member: { id: "member-2", fullName: "Ada", role: "member" } }),
      );
    renderSettingsDestructiveFlows();

    expect(screen.getByText("ada.second@example.com")).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Change role (Member) for Ada (ada.second@example.com)",
      }),
    );
    const roleDialog = await screen.findByRole("dialog", { name: "Change role for Ada" });
    expect(roleDialog).toHaveAccessibleDescription(
      expect.stringContaining("ada.second@example.com"),
    );
    expect(within(roleDialog).queryByText("ada@example.com")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Remove Ada (ada.second@example.com)" }));
    const removeDialog = await screen.findByRole("alertdialog", { name: "Remove Ada?" });
    expect(removeDialog).toHaveAccessibleDescription(
      "ada.second@example.com Removing this member revokes their workspace access immediately. You can re-invite them later.",
    );
    await user.click(within(removeDialog).getByRole("button", { name: "Remove member" }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/workspaces/${workspaceId}/members/member-2`, {
      method: "DELETE",
    });
    await waitFor(() =>
      expect(screen.queryByText("ada.second@example.com")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("ada@example.com")).toBeVisible();
  });

  it("marks the invitation expired at its deadline and sends a new link to that recipient", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ invitation: resentInvitation }));
    renderSettingsDestructiveFlows();

    expect(screen.getByText("Expired")).toBeVisible();
    expect(screen.getByText(/Expired on/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send new link for invitee@example.com" }));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/${workspaceId}/invitations/invitation-1/resend`,
      { method: "POST" },
    );
    expect(
      await screen.findByRole("button", { name: "Resend for invitee@example.com" }),
    ).toBeVisible();
    expect(screen.queryByText("Expired")).not.toBeInTheDocument();
  });

  it("updates the list from refresh without overwriting a newer resend", async () => {
    const user = userEvent.setup();
    const initial = { asOf, invitations: [pendingInvitation] };
    const extraInvitation = {
      ...pendingInvitation,
      id: "invitation-2",
      email: "another@example.com",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ invitation: resentInvitation }),
    );
    const { rerender } = render(invitationsView(initial));
    await user.click(screen.getByRole("button", { name: "Send new link for invitee@example.com" }));
    await screen.findByRole("button", { name: "Resend for invitee@example.com" });

    rerender(
      invitationsView({
        asOf: asOf + 1,
        invitations: [
          { ...pendingInvitation, updatedAt: "2026-07-17T12:00:00.000001Z" },
          extraInvitation,
        ],
      }),
    );
    expect(screen.getByRole("button", { name: "Resend for invitee@example.com" })).toBeVisible();
    expect(screen.getByText("another@example.com")).toBeVisible();

    rerender(invitationsView({ asOf: asOf + 2, invitations: [extraInvitation] }));
    expect(screen.queryByText("invitee@example.com")).not.toBeInTheDocument();
    rerender(invitationsView(initial));
    expect(screen.queryByText("invitee@example.com")).not.toBeInTheDocument();
    expect(screen.getByText("another@example.com")).toBeVisible();
  });

  it("does not restore an invitation when an older resend response arrives after a refresh", async () => {
    const user = userEvent.setup();
    const request = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(request.promise);
    const { rerender } = render(invitationsView({ asOf, invitations: [pendingInvitation] }));

    await user.click(screen.getByRole("button", { name: "Send new link for invitee@example.com" }));
    rerender(invitationsView({ asOf: asOf + 1, invitations: [] }));
    expect(screen.getByText("No pending invitations.")).toBeVisible();
    request.resolve(Response.json({ invitation: resentInvitation }));

    expect(await screen.findByText("Invitation resent to invitee@example.com.")).toBeVisible();
    expect(screen.getByText("No pending invitations.")).toBeVisible();
  });

  it("does not restore a revoked invitation from a refresh already in flight", async () => {
    const user = userEvent.setup();
    const revokedAt = new Date(asOf + 2).toISOString();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        invitation: { ...pendingInvitation, status: "revoked", revokedAt, updatedAt: revokedAt },
      }),
    );
    const { rerender } = render(invitationsView({ asOf, invitations: [pendingInvitation] }));
    await user.click(
      screen.getByRole("button", { name: "Revoke invitation for invitee@example.com" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Revoke invitee@example.com's invitation?",
    });
    expect(dialog).toHaveAccessibleDescription(
      "Revoking the invitation for invitee@example.com prevents that invitation link from granting workspace access.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Revoke invitation" }));
    await screen.findByText("No pending invitations.");

    rerender(invitationsView({ asOf: asOf + 1, invitations: [pendingInvitation] }));
    expect(screen.getByText("No pending invitations.")).toBeVisible();
  });

  it("uses elapsed server-relative time for expiry even if the browser clock changes", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(asOf + 86_400_000);
    const deadline = asOf + 1_000;
    const invitation = { ...pendingInvitation, expiresAt: new Date(deadline).toISOString() };
    const { rerender } = render(invitationsView({ asOf, invitations: [invitation] }));

    expect(screen.getByRole("button", { name: "Resend for invitee@example.com" })).toBeVisible();
    act(() => vi.advanceTimersByTime(999));
    vi.setSystemTime(asOf - 86_400_000);
    expect(screen.getByRole("button", { name: "Resend for invitee@example.com" })).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByRole("button", { name: "Send new link for invitee@example.com" }),
    ).toBeVisible();

    rerender(
      invitationsView({
        asOf: deadline + 10_000,
        invitations: [{ ...invitation, expiresAt: new Date(deadline + 11_000).toISOString() }],
      }),
    );
    expect(screen.getByRole("button", { name: "Resend for invitee@example.com" })).toBeVisible();
    act(() => vi.advanceTimersByTime(1_000));
    expect(
      screen.getByRole("button", { name: "Send new link for invitee@example.com" }),
    ).toBeVisible();
  });

  it("preserves an invitation draft across refresh but disables submit during a resend", async () => {
    const user = userEvent.setup();
    const request = Promise.withResolvers<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(request.promise);
    const { rerender } = render(invitationsView({ asOf, invitations: [pendingInvitation] }));

    await user.click(screen.getByRole("button", { name: "Send new link for invitee@example.com" }));
    await user.click(screen.getByRole("button", { name: "Invite member" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Another Person");
    await user.type(screen.getByRole("textbox", { name: "Email" }), "another@example.com");
    rerender(invitationsView({ asOf: asOf + 1, invitations: [pendingInvitation] }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Another Person");
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("another@example.com");

    const send = screen.getByRole("button", { name: "Send invitation" });
    expect(send).toBeDisabled();
    await user.click(send);
    expect(fetchMock).toHaveBeenCalledOnce();
    request.resolve(Response.json({ invitation: resentInvitation }));
    await waitFor(() => expect(send).toBeEnabled());
  });

  it("offers a retry named for the unavailable workspace subsection", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSettingsLoadError label="pending invitations" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load pending invitations.");
    await user.click(screen.getByRole("button", { name: "Retry loading pending invitations" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps accepted deletion distinct from failed requests and retries cleanup after close", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ error: "Please try again." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ deleted: false }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ error: "Cleanup service unavailable." }, { status: 503 }),
      );
    renderSettingsDestructiveFlows();

    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete Acme?" });
    expect(within(confirm).getByRole("button", { name: "Delete workspace" })).toBeDisabled();
    await user.type(within(confirm).getByRole("textbox", { name: "Type Acme to confirm" }), "Acme");
    await user.click(within(confirm).getByRole("button", { name: "Delete workspace" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("Please try again.");
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toBeVisible();
    await user.click(within(confirm).getByRole("button", { name: "Delete workspace" }));

    const progress = await screen.findByRole("alertdialog", { name: "Deletion in progress" });
    expect(within(progress).getByRole("status")).toHaveTextContent(
      "Deletion started. Closing this dialog won’t stop it.",
    );
    expect(within(progress).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(progress).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(progress).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await user.click(within(progress).getByRole("button", { name: "Close" }));
    const reopen = screen.getByRole("button", { name: "View deletion progress" });
    expect(reopen).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Delete workspace" })).not.toBeInTheDocument();
    await user.click(reopen);
    const reopened = await screen.findByRole("alertdialog", { name: "Deletion in progress" });
    await user.click(within(reopened).getByRole("button", { name: "Retry cleanup" }));
    expect(await within(reopened).findByRole("alert")).toHaveTextContent(
      "Could not retry cleanup. Cleanup service unavailable.",
    );
    expect(within(reopened).getByRole("status")).toHaveTextContent("Deletion started.");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/workspaces/${workspaceId}`,
      expect.objectContaining({ body: JSON.stringify({ confirmation: "Acme" }), method: "DELETE" }),
    );
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
    expect(refresh).toHaveBeenCalledOnce();
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
    ["Remove Ada (ada@example.com)", "Remove Ada?"],
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
    axeTestTimeout,
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
