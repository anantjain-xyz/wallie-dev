// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "@/components/app-shell/account-menu";
import { OverlayProvider } from "@/components/ui/overlay-provider";

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

describe("AccountMenu", () => {
  it("uses the shared menu, focuses its first action, and restores trigger focus", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <OverlayProvider>
        <AccountMenu email="owner@example.com" />
      </OverlayProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Account: owner@example.com" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("title");
    expect(trigger).toHaveTextContent("O");

    await user.click(trigger);
    expect(await screen.findByRole("menu", { name: "Account" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();
    expect(screen.getByText("owner@example.com")).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Account" })).toBeNull());
    expect(trigger).toHaveFocus();

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("falls back to a generic accessible name when no email is known", () => {
    render(
      <OverlayProvider>
        <AccountMenu email={null} />
      </OverlayProvider>,
    );

    expect(screen.getByRole("button", { name: "Account" })).toHaveTextContent("?");
  });

  it("shows the profile photo in the trigger when an avatar URL is provided", () => {
    render(
      <OverlayProvider>
        <AccountMenu avatarUrl="https://cdn.example.com/owner.png" email="owner@example.com" />
      </OverlayProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Account: owner@example.com" });
    const image = trigger.querySelector("img");
    expect(image).toHaveAttribute("src", "https://cdn.example.com/owner.png");
    expect(image).toHaveAttribute("alt", "");
    expect(trigger).not.toHaveTextContent("O");
  });

  it("falls back to the email initial when the photo fails to load", () => {
    render(
      <OverlayProvider>
        <AccountMenu avatarUrl="https://cdn.example.com/broken.png" email="owner@example.com" />
      </OverlayProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Account: owner@example.com" });
    const image = trigger.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image!);

    expect(trigger.querySelector("img")).toBeNull();
    expect(trigger).toHaveTextContent("O");
  });

  it("starts sign-out before the menu can unmount its form", async () => {
    const requestSubmit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => undefined);
    const user = userEvent.setup();

    render(
      <OverlayProvider>
        <AccountMenu email="owner@example.com" />
      </OverlayProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Account: owner@example.com" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(requestSubmit).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();
  });
});
