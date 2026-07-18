// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { PrecisionConsoleFixture } from "@/components/ui/precision-console-fixture";

afterEach(() => {
  cleanup();
  document.documentElement.dataset.theme = "light";
});

describe("Precision Console fixture", () => {
  it("demonstrates each required product surface and metadata hierarchy", () => {
    const { container } = render(<PrecisionConsoleFixture />);

    expect(screen.getByRole("heading", { name: "Review queue" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent work" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Repository runtime" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Build artifact" })).toBeVisible();
    expect(screen.getByText("Default branch").closest("div")).toHaveTextContent("main");
    expect(container.querySelectorAll(".ui-sheet")).toHaveLength(4);
    expect(container.innerHTML).not.toMatch(/ui-(panel|subpanel|pill)/u);
  });

  it("switches the fixture between light and dark themes", async () => {
    const user = userEvent.setup();
    render(<PrecisionConsoleFixture />);

    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
