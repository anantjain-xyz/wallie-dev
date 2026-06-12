import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountMenu } from "@/components/app-shell/account-menu";

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
});
