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
  it("has no detectable axe violations and names the artwork and work-order controls", async () => {
    const { container } = render(<LandingPage />);
    const results = await act(() =>
      axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
    );

    expect(results.violations).toEqual([]);
    const cutaway = screen.getByRole("img", {
      name: "Cutaway drawing of the Wallie software factory",
    });
    expect(cutaway).toHaveAccessibleDescription(
      /A terminal and drafting bench feed a roller conveyor/,
    );
    const stations = within(screen.getByRole("group", { name: "Work order stations" }));
    expect(stations.getAllByRole("button")).toHaveLength(4);
    expect(stations.getByRole("button", { name: "Intake", pressed: true })).toHaveAttribute(
      "aria-controls",
      "station-intake",
    );
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^Self-improving software factory$/,
    );
  });

  it("keeps the header and footer outside the landing skip target", () => {
    render(<LandingPage />);

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(main).not.toContainElement(screen.getByRole("banner"));
    expect(main).not.toContainElement(screen.getByRole("contentinfo"));
    expect(main).toContainElement(screen.getByRole("link", { name: "Try hosted Wallie" }));
  });

  it("keeps CTA links keyboard-focusable and names their destinations", () => {
    render(<LandingPage />);

    const hosted = screen.getByRole("link", { name: "Try hosted Wallie" });
    hosted.focus();
    expect(hosted).toHaveFocus();
    expect(hosted).toHaveAttribute("href", "/login");
    expect(hosted).toHaveAccessibleDescription(
      "For a hosted workspace, connect your GitHub repository, a sandbox, and your coding agent credentials. Linear is optional. You can also run Wallie yourself.",
    );
    expect(screen.getByRole("link", { name: "Self-host Wallie" })).toHaveAttribute(
      "href",
      "https://github.com/anantjain-xyz/wallie-dev/blob/main/docs/deployment/self-hosting.md",
    );

    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: "Docs & source" })).toHaveAttribute(
      "href",
      "https://github.com/anantjain-xyz/wallie-dev#readme",
    );
    expect(footer.getByRole("link", { name: "MIT License" })).toHaveAttribute(
      "href",
      "https://github.com/anantjain-xyz/wallie-dev/blob/main/LICENSE",
    );
  });

  it("links to each chapter and the gate with focusable fragment targets", () => {
    render(<LandingPage />);

    for (const [name, target] of [
      ["Start the tour", "studio"],
      ["Studio", "studio"],
      ["The line", "line"],
      ["Improvements", "improve"],
      ["Try Wallie", "start"],
      ["Back to the gate", "top"],
    ]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", `#${target}`);
      expect(document.getElementById(target)).toHaveAttribute("tabindex", "-1");
    }
  });
});
