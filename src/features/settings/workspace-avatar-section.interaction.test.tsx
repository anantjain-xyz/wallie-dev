// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { WorkspaceAvatarSection } from "@/features/settings/workspace-avatar-section";
import type { FlashMessage } from "@/features/settings/settings-types";

vi.mock("next/image", () => ({
  default: function NextImageMock({ alt, src }: { alt: string; src: string }) {
    // Test stub: next/image is not available in jsdom.
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt={alt} src={src} />;
  },
}));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const axeOptions = { rules: { "color-contrast": { enabled: false } } };

const workspace = {
  avatarPath: null as string | null,
  avatarUrl: null as string | null,
  id: workspaceId,
  name: "Acme",
  slug: "acme",
};

function pngFile(name = "avatar.png") {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, {
    type: "image/png",
  });
}

function renderSection({
  canManage = true,
  workspaceValue = workspace,
}: {
  canManage?: boolean;
  workspaceValue?: typeof workspace;
} = {}) {
  const setFlashMessage = vi.fn<(message: FlashMessage) => void>();
  const onWorkspaceNameChange = vi.fn<(name: string) => void>();

  render(
    <OverlayProvider>
      <main>
        <WorkspaceAvatarSection
          canManage={canManage}
          onWorkspaceNameChange={onWorkspaceNameChange}
          setFlashMessage={setFlashMessage}
          workspace={workspaceValue}
        />
      </main>
    </OverlayProvider>,
  );

  return { onWorkspaceNameChange, setFlashMessage };
}

function getAvatarFileInput() {
  return document.querySelector('input[type="file"]') as HTMLInputElement | null;
}

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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: query.includes("reduce"),
      media: query,
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceAvatarSection identity editing", () => {
  it("opens the avatar picker from pointer and keyboard activation", async () => {
    const user = userEvent.setup();
    renderSection();

    const trigger = screen.getByRole("button", { name: "Change workspace avatar" });
    const input = getAvatarFileInput();
    const overlay = trigger.querySelector("[aria-hidden='true']");
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute("accept", ".jpg,.jpeg,.png,.webp");
    expect(screen.queryByText("Upload avatar")).not.toBeInTheDocument();
    expect(overlay?.className).toMatch(/group-hover:opacity-100/);
    expect(overlay?.className).toMatch(/group-focus-visible:opacity-100/);
    expect(trigger).toHaveTextContent("Change avatar");

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    await user.click(trigger);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockClear();
    trigger.focus();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockClear();
    trigger.focus();
    await user.keyboard(" ");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts jpg, jpeg, png, and webp uploads and rejects other types", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ avatarUrl: "/avatars/acme.png" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    const input = getAvatarFileInput();
    expect(input).not.toBeNull();

    for (const file of [
      new File(["x"], "avatar.jpg", { type: "image/jpeg" }),
      new File(["x"], "avatar.jpeg", { type: "image/jpeg" }),
      pngFile(),
      new File(["x"], "avatar.webp", { type: "image/webp" }),
    ]) {
      fetchMock.mockClear();
      await user.upload(input!, file);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Change workspace avatar" })).toBeEnabled(),
      );
    }

    fetchMock.mockClear();
    await user.upload(input!, new File(["x"], "avatar.gif", { type: "image/gif" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables the avatar trigger and names the uploading state until success", async () => {
    const user = userEvent.setup();
    let release!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { setFlashMessage } = renderSection();

    const trigger = screen.getByRole("button", { name: "Change workspace avatar" });
    await user.upload(getAvatarFileInput()!, pngFile());

    await waitFor(() => expect(trigger).toBeDisabled());
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status", { name: "Uploading…" })).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Uploading…");
    expect(trigger).not.toHaveTextContent("Change avatar");

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    await user.click(trigger);
    expect(clickSpy).not.toHaveBeenCalled();

    release(Response.json({ avatarUrl: "https://cdn.example.com/acme.png" }));

    await waitFor(() =>
      expect(setFlashMessage).toHaveBeenCalledWith({
        kind: "success",
        text: "Workspace avatar updated.",
      }),
    );
    expect(screen.getByRole("button", { name: "Change workspace avatar" })).toBeEnabled();
    expect(document.querySelector('img[src="https://cdn.example.com/acme.png"]')).not.toBeNull();
  });

  it("keeps upload errors local to the avatar action", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ error: "Avatar too large." }, { status: 400 }))),
    );
    const { setFlashMessage } = renderSection();

    await user.upload(getAvatarFileInput()!, pngFile());

    await waitFor(() =>
      expect(setFlashMessage).toHaveBeenCalledWith({
        kind: "error",
        text: "Avatar too large.",
      }),
    );
    expect(screen.getByRole("button", { name: "Change workspace avatar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit workspace name" })).toBeInTheDocument();
  });

  it("edits, saves, and restores focus to Edit for pointer and keyboard flows", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: workspaceId,
          name: "Acme Labs",
          updatedAt: "2026-08-15T00:00:00.000Z",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { onWorkspaceNameChange, setFlashMessage } = renderSection();

    const edit = screen.getByRole("button", { name: "Edit workspace name" });
    expect(edit).toHaveTextContent("Edit");
    expect(edit.className).not.toMatch(/ui-icon-button/);
    expect(edit.className).not.toMatch(/\bborder\b/);

    await user.click(edit);
    const nameInput = screen.getByRole("textbox", { name: "Workspace name" });
    expect(nameInput).toHaveFocus();
    expect(nameInput).toHaveValue("Acme");
    expect((nameInput as HTMLInputElement).selectionStart).toBe(0);
    expect((nameInput as HTMLInputElement).selectionEnd).toBe(4);

    await user.clear(nameInput);
    await user.type(nameInput, "Acme Labs");
    await user.click(screen.getByRole("button", { name: "Save workspace name" }));

    await waitFor(() =>
      expect(setFlashMessage).toHaveBeenCalledWith({
        kind: "success",
        text: "Workspace name updated.",
      }),
    );
    expect(onWorkspaceNameChange).toHaveBeenCalledWith("Acme Labs");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit workspace name" })).toHaveFocus(),
    );
    expect(screen.getByText("Acme Labs")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    const reopened = screen.getByRole("textbox", { name: "Workspace name" });
    expect(reopened).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit workspace name" })).toHaveFocus(),
    );
    expect(screen.getByText("Acme Labs")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit workspace name" }));
    await user.type(screen.getByRole("textbox", { name: "Workspace name" }), " draft");
    await user.click(screen.getByRole("button", { name: "Cancel workspace name edit" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit workspace name" })).toHaveFocus(),
    );
    expect(screen.getByText("Acme Labs")).toBeInTheDocument();
  });

  it("keeps the editor open for empty-name validation errors", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await user.click(screen.getByRole("button", { name: "Edit workspace name" }));
    await user.clear(screen.getByRole("textbox", { name: "Workspace name" }));
    await user.click(screen.getByRole("button", { name: "Save workspace name" }));

    expect(screen.getByText("Workspace name is required.")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides upload and Edit controls for read-only users", async () => {
    renderSection({ canManage: false });

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("/w/acme")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(
      screen.getByText("Workspace admins can change the name and avatar."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Change workspace avatar" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit workspace name" })).not.toBeInTheDocument();
    expect(getAvatarFileInput()).toBeNull();

    const results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);
  });

  it("has no axe violations in the editable identity controls", async () => {
    renderSection();

    const results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);
  });
});
