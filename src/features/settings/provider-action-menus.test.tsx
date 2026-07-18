// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { ClaudeCodeConnectionPanel } from "@/features/settings/claude-code-connection-panel";
import { CodexConnectionPanel } from "@/features/settings/codex-connection-panel";

beforeEach(() => {
  class ResizeObserverStub {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("provider action menus", () => {
  it.each([
    {
      label: "Codex credential actions",
      response: {
        connected: true,
        credentialType: "platform_api_key",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      view: <CodexConnectionPanel />,
    },
    {
      label: "Claude Code credential actions",
      response: { connected: true, updatedAt: "2026-07-18T12:00:00.000Z" },
      view: <ClaudeCodeConnectionPanel />,
    },
  ])(
    "opens $label on its first enabled item and restores focus",
    async ({ label, response, view }) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
      const user = userEvent.setup();
      render(<OverlayProvider>{view}</OverlayProvider>);

      const trigger = await screen.findByRole("button", { name: label });
      await user.click(trigger);
      expect(await screen.findByRole("menu", { name: label })).toBeVisible();
      expect(screen.getByRole("menuitem", { name: "Disconnect" })).toHaveFocus();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu", { name: label })).toBeNull());
      expect(trigger).toHaveFocus();
    },
  );
});
