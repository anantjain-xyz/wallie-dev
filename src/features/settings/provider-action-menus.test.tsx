// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { SelectField } from "@/components/ui/select";
import { ClaudeCodeConnectionPanel } from "@/features/settings/claude-code-connection-panel";
import { CodexConnectionPanel } from "@/features/settings/codex-connection-panel";
import { CursorConnectionPanel } from "@/features/settings/cursor-connection-panel";

beforeEach(() => {
  class ResizeObserverStub {
    disconnect() {}
    observe() {}
    unobserve() {}
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
  vi.unstubAllGlobals();
});

function expectNotIsolated(element: HTMLElement) {
  expect(element.closest("[aria-hidden='true']")).toBeNull();
  expect(element.closest("[inert]")).toBeNull();
}

function SurroundingSettings({ children }: { children: ReactNode }) {
  return (
    <div data-testid="application">
      <h2>Agent</h2>
      <p>Provider</p>
      {children}
      <p>Concurrency</p>
    </div>
  );
}

describe("settings selects", () => {
  it("does not hide Settings when the Agent provider SelectField is open", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <OverlayProvider>
        <SurroundingSettings>
          <SelectField
            label="Agent provider"
            onValueChange={onValueChange}
            options={[
              { label: "Codex", value: "codex" },
              { label: "Claude Code", value: "claude_code" },
            ]}
            value="codex"
          />
        </SurroundingSettings>
      </OverlayProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: "Agent provider" }));
    expect(await screen.findByRole("listbox", { name: "Agent provider" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Claude Code" })).toBeVisible();

    expectNotIsolated(screen.getByTestId("application"));
    expectNotIsolated(screen.getByRole("heading", { name: "Agent" }));
    expectNotIsolated(screen.getByText("Provider"));
    expectNotIsolated(screen.getByText("Concurrency"));
    expect(screen.getByText("Provider")).toBeVisible();
    expect(screen.getByText("Concurrency")).toBeVisible();

    await user.click(screen.getByText("Concurrency"));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onValueChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("combobox", { name: "Agent provider" }));
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));
    expect(onValueChange).toHaveBeenCalledWith("claude_code");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.getByRole("combobox", { name: "Agent provider" })).toBeVisible();
    expectNotIsolated(screen.getByTestId("application"));
  });
});

describe("provider action menus", () => {
  const providers = [
    {
      disconnectReplacesTrigger: true,
      label: "Codex credential actions",
      response: {
        connected: true,
        credentialType: "platform_api_key",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      surrounding: ["Connected", "OpenAI API key"],
      view: <CodexConnectionPanel />,
    },
    {
      disconnectReplacesTrigger: true,
      label: "Claude Code credential actions",
      response: { connected: true, updatedAt: "2026-07-18T12:00:00.000Z" },
      surrounding: ["Connected", "Anthropic API key"],
      view: <ClaudeCodeConnectionPanel />,
    },
    {
      disconnectReplacesTrigger: false,
      label: "Cursor credential actions",
      response: {
        accountEmail: "person@example.com",
        checkedAt: "2026-08-29T22:00:00.000Z",
        connected: true,
      },
      surrounding: ["person@example.com", "Connected"],
      view: <CursorConnectionPanel />,
    },
  ];

  it.each(providers)(
    "opens $label on its first enabled item without hiding Settings",
    async ({ label, response, surrounding, view }) => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json(response));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(
        <OverlayProvider>
          <SurroundingSettings>{view}</SurroundingSettings>
        </OverlayProvider>,
      );

      const trigger = await screen.findByRole("button", { name: label });
      await user.click(trigger);
      expect(await screen.findByRole("menu", { name: label })).toBeVisible();
      expect(screen.getByRole("menuitem", { name: "Disconnect" })).toHaveFocus();

      expectNotIsolated(screen.getByTestId("application"));
      expectNotIsolated(screen.getByRole("heading", { name: "Agent" }));
      expectNotIsolated(screen.getByText("Provider"));
      expectNotIsolated(screen.getByText("Concurrency"));
      for (const copy of surrounding) {
        expectNotIsolated(screen.getAllByText(copy)[0]);
      }

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu", { name: label })).toBeNull());
      expect(trigger).toHaveFocus();

      await user.click(trigger);
      expect(await screen.findByRole("menu", { name: label })).toBeVisible();
      await user.click(screen.getByText("Concurrency"));
      await waitFor(() => expect(screen.queryByRole("menu", { name: label })).toBeNull());
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    },
  );

  it.each(providers)(
    "shows disconnect progress for $label without confirming on dismiss",
    async ({ disconnectReplacesTrigger, label, response, view }) => {
      let resolveDisconnect: ((response: Response) => void) | undefined;
      const disconnectResponse = new Promise<Response>((resolve) => {
        resolveDisconnect = resolve;
      });
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE" ? disconnectResponse : Promise.resolve(Response.json(response)),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(
        <OverlayProvider>
          <SurroundingSettings>{view}</SurroundingSettings>
        </OverlayProvider>,
      );

      await user.click(await screen.findByRole("button", { name: label }));
      expect(await screen.findByRole("menu", { name: label })).toBeVisible();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

      await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));

      const progress = await screen.findByText("Disconnecting…");
      expect(progress).toBeVisible();
      if (disconnectReplacesTrigger) {
        expect(progress).toHaveAttribute("aria-live", "polite");
        expect(progress).toHaveAttribute("role", "status");
        expect(screen.queryByRole("button", { name: label })).toBeNull();
      }

      resolveDisconnect?.(new Response(null, { status: 204 }));
      await waitFor(() => expect(screen.queryByText("Disconnecting…")).toBeNull());
    },
  );
});
