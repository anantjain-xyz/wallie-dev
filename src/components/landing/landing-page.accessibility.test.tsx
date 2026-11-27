// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";

afterEach(() => {
  cleanup();
});

describe("LandingPage accessibility", () => {
  it("has no detectable axe violations and exposes a readable, noninteractive example", async () => {
    const { container } = render(<LandingPage />);
    const results = await act(() =>
      axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
    );

    expect(results.violations).toEqual([]);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const figure = screen.getByRole("figure", { name: "Example workflow" });
    expect(figure).toHaveAccessibleDescription(
      "Wallie starts the build after you approve the plan.",
    );
    const steps = within(figure).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent(/Plan\s*Wallie/);
    expect(steps[1]).toHaveTextContent(/Approve plan\s*You/);
    expect(steps[2]).toHaveTextContent(/Build\s*Wallie/);
    const providers = within(screen.getByRole("region", { name: "Works with" }));
    expect(providers.getByRole("list", { name: "Coding agents" })).toHaveTextContent("Cursor");
    expect(providers.getByRole("list", { name: "Sandboxes" })).toHaveTextContent("Daytona");
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Turn a task into a pull request you can trust",
    );
  });

  it("keeps the header and footer outside the landing skip target", () => {
    render(<LandingPage />);

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(main).not.toContainElement(screen.getByRole("banner"));
    expect(main).not.toContainElement(screen.getByRole("contentinfo"));
    expect(main).toContainElement(screen.getByRole("link", { name: "Start with email" }));
  });

  it("keeps CTA links keyboard-focusable and names their destinations", () => {
    render(<LandingPage />);

    const hosted = screen.getByRole("link", { name: "Start with email" });
    hosted.focus();
    expect(hosted).toHaveFocus();
    expect(hosted).toHaveAttribute("href", "/login");
    expect(hosted).toHaveAccessibleDescription(
      "For a new hosted workspace, connect a GitHub repository, a sandbox, and your agent credentials. Linear is optional.",
    );
    expect(screen.getByRole("link", { name: /^Sign in$/ })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Self-host Wallie" })).toHaveAttribute(
      "href",
      "https://github.com/anantjain-xyz/wallie-dev/blob/main/docs/deployment/self-hosting.md",
    );

    const docs = within(screen.getByRole("contentinfo")).getByRole("link", {
      name: "Docs & source",
    });
    expect(docs).toHaveAttribute("href", "https://github.com/anantjain-xyz/wallie-dev#readme");
  });
});
