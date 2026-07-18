// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AuthForm } from "@/components/auth/auth-form";

describe("AuthForm", () => {
  afterEach(cleanup);

  it("announces and disables the initiating form while it submits", () => {
    const { container } = render(
      <AuthForm
        action="/auth/email"
        pendingLabel="Sending secure sign-in email…"
        submitLabel="Send secure email"
      >
        <input name="email" defaultValue="owner@example.com" />
      </AuthForm>,
    );

    fireEvent.submit(container.querySelector("form")!);

    const button = screen.getByRole("button", { name: "Sending secure sign-in email…" });
    expect((button.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Sending secure sign-in email…");
    expect(container.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
  });

  it("focuses an actionable error summary for retry", async () => {
    render(
      <AuthForm
        action="/auth/code"
        feedback={{ kind: "error", message: "Check the code and try again." }}
        pendingLabel="Verifying code…"
        submitLabel="Try code again"
      >
        <input name="token" />
      </AuthForm>,
    );

    const alert = screen.getByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(alert.getAttribute("tabindex")).toBe("-1");
    const button = screen.getByRole("button", { name: "Try code again" });
    expect((button.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false);
  });
});
