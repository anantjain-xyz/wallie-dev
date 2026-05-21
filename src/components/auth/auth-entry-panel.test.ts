import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthEntryPanel } from "@/components/auth/auth-entry-panel";

function renderPanel(props: Partial<Parameters<typeof AuthEntryPanel>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(AuthEntryPanel, {
      next: "/w/acme",
      ...props,
    }),
  );
}

describe("AuthEntryPanel", () => {
  it("hides the email code form until code has been requested", () => {
    const html = renderPanel();

    expect(html).not.toContain("Enter 6-digit code emailed to you");
    expect(html).not.toContain("Continue with code");
    expect(html).not.toContain('name="token"');
  });

  it("shows the email code form with the requested email after sending email auth", () => {
    const html = renderPanel({
      requestedEmail: "owner@example.com",
      statusCode: "check_email",
    });

    expect(html).toContain("Enter 6-digit code emailed to you");
    expect(html).toContain("Continue with code");
    expect(html).toContain('name="token"');
    expect(html).toContain('value="owner@example.com"');
  });

  it("keeps the email code form visible for failed code retries", () => {
    const html = renderPanel({
      errorCode: "email_code_failed",
      requestedEmail: "owner@example.com",
    });

    expect(html).toContain("Enter 6-digit code emailed to you");
    expect(html).toContain("Wallie could not verify that code.");
    expect(html).toContain('value="owner@example.com"');
  });
});
