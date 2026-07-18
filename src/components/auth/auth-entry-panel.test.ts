import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const originalVercelEnv = process.env.VERCEL_ENV;

describe("AuthEntryPanel", () => {
  beforeEach(() => {
    process.env.VERCEL_ENV = "production";
  });

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
      return;
    }

    process.env.VERCEL_ENV = originalVercelEnv;
  });

  it("hides the email code form until code has been requested", () => {
    const html = renderPanel();

    expect(html).not.toContain("Enter 6-digit code emailed to you");
    expect(html).not.toContain("Continue with code");
    expect(html).not.toContain("Request another code");
    expect(html).not.toContain('name="tokenDigit"');
  });

  it("does not render social auth options", () => {
    const html = renderPanel();

    expect(html).not.toContain("Continue with Google");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("/auth/oauth");
  });

  it("shows six code inputs without exposing the email form after sending email auth", () => {
    const html = renderPanel({
      canUseEmailCode: true,
      statusCode: "check_email",
    });

    expect(html).toContain("Enter 6-digit code emailed to you");
    expect(html).toContain("Continue with code");
    expect(html).toContain("Request another code");
    expect(html).toContain('href="/login?next=%2Fw%2Facme"');
    expect(countMatches(html, 'name="tokenDigit"')).toBe(6);
    expect(countMatches(html, 'aria-label="Digit ')).toBe(6);
    expect(countMatches(html, 'inputMode="numeric"')).toBe(6);
    expect(countMatches(html, 'pattern="[0-9]*"')).toBe(6);
    expect(countMatches(html, 'maxLength="1"')).toBe(6);
    expect(html).toContain("email-code-form space-y-2");
    expect(html).toContain("email-code-grid grid gap-1");
    expect(countMatches(html, "h-11 min-w-11")).toBe(6);
    expect(html).toContain('autoComplete="one-time-code"');
    expect(countMatches(html, 'autoComplete="off"')).toBe(5);
    expect(html).not.toContain("Send magic link");
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("you@company.com");
    expect(html).not.toContain("owner@example.com");
  });

  it("keeps the email code form visible for failed code retries", () => {
    const html = renderPanel({
      canUseEmailCode: true,
      errorCode: "email_code_failed",
    });

    expect(html).toContain("Enter 6-digit code emailed to you");
    expect(html).toContain("Wallie could not verify that code.");
    expect(html).toContain("Request another code");
    expect(countMatches(html, 'name="tokenDigit"')).toBe(6);
    expect(html).not.toContain("Send magic link");
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('type="email"');
  });

  it("keeps the email code form visible after link failures when email is stored", () => {
    const html = renderPanel({
      canUseEmailCode: true,
      errorCode: "auth_confirmation_failed",
    });

    expect(countMatches(html, 'name="tokenDigit"')).toBe(6);
    expect(html).toContain("Request another code");
    expect(html).not.toContain("Send magic link");
    expect(html).not.toContain('name="email"');
  });

  it("returns send failures to the original email form", () => {
    const html = renderPanel({
      canUseEmailCode: true,
      errorCode: "email_sign_in_failed",
    });

    expect(html).toContain("Wallie could not send that magic link.");
    expect(html).toContain("Send magic link");
    expect(html).toContain('name="email"');
    expect(html).not.toContain('name="tokenDigit"');
    expect(html).not.toContain("Request another code");
  });

  it("does not show the email code form on fallback errors without stored email", () => {
    const html = renderPanel({
      errorCode: "auth_confirmation_failed",
    });

    expect(html).not.toContain('name="tokenDigit"');
    expect(html).not.toContain("Continue with code");
  });
});
