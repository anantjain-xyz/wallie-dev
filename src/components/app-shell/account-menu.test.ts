// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { AccountMenu } from "@/components/app-shell/account-menu";
import { OverlayProvider } from "@/components/ui/overlay-provider";

afterEach(cleanup);

describe("AccountMenu", () => {
  it("exposes the signed-in email on a collapsed menu trigger", () => {
    const html = renderToStaticMarkup(createElement(AccountMenu, { email: "owner@example.com" }));

    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Account: owner@example.com"');
    // The trigger badge uses the first letter of the email.
    expect(html).toContain(">O<");
    // The menu panel (and sign-out form) only mounts once opened.
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('action="/auth/signout"');
  });

  it("falls back to a generic label when no email is known", () => {
    const html = renderToStaticMarkup(createElement(AccountMenu, { email: null }));

    expect(html).toContain('aria-label="Account"');
    expect(html).toContain(">?<");
  });

  it("opens its menu in the shared overlay root and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(
      createElement(
        OverlayProvider,
        null,
        createElement(AccountMenu, { email: "owner@example.com" }),
      ),
    );

    const trigger = screen.getByRole("button", { name: "Account: owner@example.com" });
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Account" });
    expect(document.querySelector("[data-wallie-overlay-root]")).toContainElement(menu);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
