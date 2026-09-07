// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";

afterEach(() => {
  cleanup();
});

describe("LandingPage accessibility", () => {
  it("has no detectable axe violations and exposes two distinct illustrations", async () => {
    const { container } = render(<LandingPage />);
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations).toEqual([]);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("figure")).toHaveLength(2);
    expect(screen.getByRole("figure", { name: "Choose your coding agent" })).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "Design your workflow" })).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Turn a task into a pull request you can trust",
    );
  });

  it("keeps CTA links keyboard-focusable and names their destinations", () => {
    render(<LandingPage />);

    const signIn = screen.getByRole("link", { name: "Get started" });
    signIn.focus();
    expect(signIn).toHaveFocus();
    expect(signIn).toHaveAttribute("href", "/login");

    const github = screen.getByRole("link", { name: /GitHub/ });
    expect(github).toHaveAttribute("href", "https://github.com/anantjain-xyz/wallie-dev");
  });
});
