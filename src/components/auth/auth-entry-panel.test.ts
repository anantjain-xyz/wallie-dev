import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthEntryPanel } from "@/components/auth/auth-entry-panel";

function countMatches(value: string, pattern: string) {
  return value.split(pattern).length - 1;
}

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
    expect(html).not.toContain('name="tokenDigit"');
  });

  it("shows six code inputs without exposing the email after sending email auth", () => {
    const initialHtml = renderPanel();
    const html = renderPanel({
      canUseEmailCode: true,
      statusCode: "check_email",
    });

    expect(html).toContain("Enter 6-digit code emailed to you");
    expect(html).toContain("Continue with code");
    expect(countMatches(html, 'name="tokenDigit"')).toBe(6);
    expect(countMatches(html, 'type="email"')).toBe(countMatches(initialHtml, 'type="email"'));
    expect(html).not.toContain("owner@example.com");
    expect(html).not.toContain('name="email" value=');
  });

  it("keeps the email code form visible for failed code retries", () => {
    const initialHtml = renderPanel();
    const html = renderPanel({
      canUseEmailCode: true,
      errorCode: "email_code_failed",
    });

    expect(html).toContain("Enter 6-digit code emailed to you");
    expect(html).toContain("Wallie could not verify that code.");
    expect(countMatches(html, 'name="tokenDigit"')).toBe(6);
    expect(countMatches(html, 'type="email"')).toBe(countMatches(initialHtml, 'type="email"'));
    expect(html).not.toContain('name="email" value=');
  });

  it("keeps the email code form visible after link and resend failures when email is stored", () => {
    const authFailureHtml = renderPanel({
      canUseEmailCode: true,
      errorCode: "auth_confirmation_failed",
    });
    const resendFailureHtml = renderPanel({
      canUseEmailCode: true,
      errorCode: "email_sign_in_failed",
    });

    expect(countMatches(authFailureHtml, 'name="tokenDigit"')).toBe(6);
    expect(countMatches(resendFailureHtml, 'name="tokenDigit"')).toBe(6);
  });

  it("does not show the email code form on fallback errors without stored email", () => {
    const html = renderPanel({
      errorCode: "auth_confirmation_failed",
    });

    expect(html).not.toContain('name="tokenDigit"');
    expect(html).not.toContain("Continue with code");
  });
});
