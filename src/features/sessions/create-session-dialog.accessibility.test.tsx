// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { CreateSessionDialogLoading } from "@/components/app-shell/shell-header";

const clientMocks = vi.hoisted(() => ({
  createSessionFromClient: vi.fn(),
  loadSessionRepositoryOptionsFromClient: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/sessions/client", () => clientMocks);

import { CreateSessionDialog } from "@/features/sessions/create-session-dialog";

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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("CreateSessionDialog accessibility", () => {
  it("announces the lazy loading state inside the shared modal", async () => {
    render(
      <OverlayProvider>
        <CreateSessionDialogLoading />
      </OverlayProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "Start a new session" })).toBeVisible();
    const loadingStatus = screen.getByText("Loading session form…").closest('[role="status"]');
    expect(loadingStatus).toHaveAttribute("aria-busy", "true");
    expect(loadingStatus).toHaveTextContent("Loading session form…");
  });

  it("labels, focuses, traps, locks, and keyboard-dismisses the shared Dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    clientMocks.loadSessionRepositoryOptionsFromClient.mockResolvedValue({
      defaultGithubRepositoryId: null,
      repositoryOptions: [],
    });

    render(
      <OverlayProvider>
        <button type="button">Outside</button>
        <CreateSessionDialog
          defaultGithubRepositoryId={null}
          onClose={onClose}
          open
          workspaceId="00000000-0000-4000-8000-000000000001"
          workspaceSlug="acme"
        />
      </OverlayProvider>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Start a new session" });
    expect(dialog).toHaveAccessibleDescription(
      "Describe the work, choose its repository, and optionally link a Linear issue.",
    );
    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveFocus());
    await waitFor(() => expect(document.body.dataset.scrollLocked).toBe("1"));
    expect(screen.getByText("Outside").closest("button")).toHaveAttribute("aria-hidden", "true");

    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
