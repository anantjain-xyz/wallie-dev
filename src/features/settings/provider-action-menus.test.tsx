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
  const providers = [
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
  ];

  it.each(providers)(
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

  it.each(providers)(
    "shows and announces disconnect progress for $label",
    async ({ label, response, view }) => {
      let resolveDisconnect: ((response: Response) => void) | undefined;
      const disconnectResponse = new Promise<Response>((resolve) => {
        resolveDisconnect = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
          init?.method === "DELETE" ? disconnectResponse : Promise.resolve(Response.json(response)),
        ),
      );
      const user = userEvent.setup();
      render(<OverlayProvider>{view}</OverlayProvider>);

      await user.click(await screen.findByRole("button", { name: label }));
      await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));

      const progress = await screen.findByText("Disconnecting…");
      expect(progress).toBeVisible();
      expect(progress).toHaveAttribute("aria-live", "polite");
      expect(progress).toHaveAttribute("role", "status");
      expect(screen.queryByRole("button", { name: label })).toBeNull();

      resolveDisconnect?.(new Response(null, { status: 204 }));
      await waitFor(() => expect(screen.queryByText("Disconnecting…")).toBeNull());
    },
  );
});
