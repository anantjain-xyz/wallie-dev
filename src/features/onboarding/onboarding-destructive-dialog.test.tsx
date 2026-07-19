// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { OnboardingVercelSandboxPanel } from "@/features/onboarding/steps/runtime-step";

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
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("onboarding destructive dialog", () => {
  it("uses an accessible keyboard-dismissible confirmation and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(
      <OverlayProvider>
        <OnboardingVercelSandboxPanel
          canManage
          connection={{
            lastValidatedAt: "2026-07-17T12:00:00.000Z",
            lastValidationError: null,
            projectId: "prj_123",
            projectName: "onboarding-sandboxes",
            status: "connected",
            teamId: "team_123",
            tokenPreview: "vca_...123",
            updatedAt: "2026-07-17T12:00:00.000Z",
            workspaceId: "00000000-0000-4000-8000-000000000001",
          }}
          disabled={false}
          onConnectionChange={vi.fn()}
          workspaceId="00000000-0000-4000-8000-000000000001"
        />
      </OverlayProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Disconnect Vercel Sandbox" });
    await user.click(trigger);
    expect(
      await screen.findByRole("alertdialog", { name: "Disconnect onboarding-sandboxes?" }),
    ).toBeVisible();
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });
});
