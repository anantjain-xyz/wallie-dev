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

    expect(html).not.toContain("Check your email");
    expect(html).not.toContain("Continue with code");
    expect(html).not.toContain("Request a new email");
    expect(html).not.toContain('name="tokenDigit"');
  });

  it("presents a single page heading, context, visible email label, and method", () => {
    const html = renderPanel();

    expect(countMatches(html, "<h1")).toBe(1);
    expect(html).toContain("Sign in to Wallie");
    expect(html).toContain("Continue to your workspace and review active sessions.");
    expect(html).toContain("Sign in with email");
    expect(html).toContain("Work email");
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('inputMode="email"');
    expect(html).toContain('class="grid gap-3"');
    expect(html).toContain("ui-button-primary min-h-11 w-full");
    expect(html).toContain("Visit the home page");
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

    expect(html).toContain("Check your email");
    expect(html).toContain("Verification code");
    expect(html).toContain("Continue with code");
    expect(html).toContain("ui-button-primary min-h-11 w-full");
    expect(html).toContain("Request a new email");
    expect(html).toContain('href="/login?next=%2Fw%2Facme"');
    expect(countMatches(html, 'name="tokenDigit"')).toBe(6);
    expect(countMatches(html, 'aria-label="Digit ')).toBe(6);
    expect(countMatches(html, 'inputMode="numeric"')).toBe(6);
    expect(countMatches(html, 'pattern="[0-9]*"')).toBe(6);
    expect(countMatches(html, 'maxLength="1"')).toBe(6);
    expect(html).toContain("email-code-form mt-4 grid gap-3");
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

  it("keeps check-email guidance visible when the continuation cookie is absent", () => {
    const html = renderPanel({ statusCode: "check_email" });

    expect(html).toContain("Check your inbox for a secure sign-in link or six-digit code.");
    expect(html).toContain('role="status"');
    expect(html).toContain('name="email"');
    expect(html).not.toContain('name="tokenDigit"');
  });

  it("keeps the email code form visible for failed code retries", () => {
    const html = renderPanel({
      canUseEmailCode: true,
      errorCode: "email_code_failed",
    });

    expect(html).toContain("Check your email");
    expect(html).toContain("That code could not be verified.");
    expect(html).toContain("Request a new email");
    expect(html).toContain("Try code again");
    expect(html).toContain('role="alert" tabindex="-1"');
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
    expect(html).toContain("Request a new email");
    expect(html).not.toContain("Send magic link");
    expect(html).not.toContain('name="email"');
  });

  it("returns send failures to the original email form", () => {
    const html = renderPanel({
      canUseEmailCode: true,
      errorCode: "email_sign_in_failed",
    });

    expect(html).toContain("We could not send a sign-in email.");
    expect(html).toContain("Try sending again");
    expect(html).toContain('role="alert" tabindex="-1"');
    expect(html).toContain('name="email"');
    expect(html).not.toContain('name="tokenDigit"');
    expect(html).not.toContain("Request a new email");
  });

  it("does not show the email code form on fallback errors without stored email", () => {
    const html = renderPanel({
      errorCode: "auth_confirmation_failed",
    });

    expect(html).not.toContain('name="tokenDigit"');
    expect(html).not.toContain("Continue with code");
  });
});
