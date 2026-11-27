// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";

afterEach(cleanup);

describe("the fictional factory tour", () => {
  it("lets the keyboard move between stations with visible selection and an announcement", async () => {
    const user = userEvent.setup();
    render(<LandingPage />);

    const stations = within(screen.getByRole("group", { name: "Work order stations" }));
    const intake = stations.getByRole("button", { name: "Intake" });
    const plan = stations.getByRole("button", { name: "Plan" });
    const dispatch = stations.getByRole("button", { name: "Dispatch" });
    const line = within(
      screen.getByRole("region", { name: "Add a dry-run mode to the deploy CLI." }),
    );

    intake.focus();
    await user.keyboard("{ArrowRight}");
    expect(plan).toHaveFocus();
    expect(plan).toHaveAttribute("aria-pressed", "true");
    expect(intake).toHaveAttribute("aria-pressed", "false");
    expect(line.getByRole("heading", { name: "A plan for the flag." })).toBeVisible();
    expect(line.getByRole("status")).toHaveTextContent("Work order 024 at Plan.");

    await user.keyboard("{End}");
    expect(dispatch).toHaveFocus();
    expect(dispatch).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Home}{ArrowLeft}");
    expect(dispatch).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(intake).toHaveFocus();
    expect(line.getByRole("heading", { name: "A task becomes a session." })).toBeVisible();
  });

  it("revises one artifact without changing the factory and approves only the new version", async () => {
    const user = userEvent.setup();
    render(<LandingPage />);
    const line = within(
      screen.getByRole("region", { name: "Add a dry-run mode to the deploy CLI." }),
    );

    const sendToPlan = line.getByRole("button", { name: "Send to Plan" });
    sendToPlan.focus();
    await user.keyboard("{Enter}");
    expect(line.getByRole("heading", { name: "A plan for the flag." })).toHaveFocus();
    await user.click(line.getByRole("button", { name: "Approve plan & continue" }));
    expect(line.getByRole("heading", { name: "It prints a preview. But when?" })).toHaveFocus();
    expect(line.getByRole("status")).toHaveTextContent("Plan v1 approved.");
    expect(line.queryByRole("button", { name: "Approve Build v2" })).not.toBeInTheDocument();

    await user.click(line.getByText("Read the check evidence"));
    expect(line.getByText(/There was no assertion about deploy API calls/)).toBeVisible();
    await user.click(line.getByRole("button", { name: "Request changes" }));
    expect(line.getByRole("heading", { name: "A dry run skips the deploy call." })).toHaveFocus();
    expect(line.getByText(/This session still uses factory revision R07/)).toBeVisible();
    expect(line.getByText(/the observed count was 0/)).not.toBeVisible();

    await user.click(line.getByRole("button", { name: "Build v1" }));
    expect(line.getByText("Session review / Changes requested")).toBeVisible();
    expect(line.queryByRole("button", { name: "Approve Build v2" })).not.toBeInTheDocument();

    await user.click(line.getByRole("button", { name: "Build v2" }));
    await user.click(line.getByText("Read the check evidence"));
    expect(line.getByText(/the observed count was 0/)).toBeVisible();

    const receipt = within(screen.getByRole("group", { name: "Admission receipt" }));
    const before = receipt.getByRole("button", { name: "Before adoption" });
    await user.click(before);
    await user.click(line.getByRole("button", { name: "Approve Build v2" }));
    expect(line.getByText(/This did not merge code or edit the factory/)).toBeVisible();
    expect(line.getByText(/the observed count was 0/)).toBeVisible();
    const delivery = line.getByRole("button", { name: "See delivery" });
    expect(delivery).toHaveFocus();
    expect(before).toHaveAttribute("aria-pressed", "true");
    expect(receipt.getByText("Next start", { exact: false }).parentElement).toHaveTextContent(
      /WO–025\s*R07/,
    );

    await user.click(delivery);
    expect(line.getByRole("heading", { name: "Code can leave in a GitHub PR." })).toHaveFocus();
    expect(line.getByText(/Delivery runs separately from stage review/)).toBeVisible();
    await user.click(line.getByRole("button", { name: "Replay the work order" }));
    expect(line.getByRole("heading", { name: "A task becomes a session." })).toHaveFocus();
    await user.click(line.getByRole("button", { name: "Build" }));
    expect(line.getByRole("heading", { name: "Build takes an approved plan." })).toBeVisible();
    expect(line.queryByRole("button", { name: "Request changes" })).not.toBeInTheDocument();
    await user.click(line.getByRole("button", { name: "Go to Plan" }));
    expect(line.getByRole("heading", { name: "A plan for the flag." })).toHaveFocus();
    await user.click(line.getByRole("button", { name: "Approve plan & continue" }));
    expect(line.getByRole("button", { name: "Request changes" })).toBeVisible();
    expect(line.queryByRole("group", { name: "Build artifact versions" })).not.toBeInTheDocument();
  });

  it("lets the reader compare fictional admissions without changing the current run", async () => {
    const user = userEvent.setup();
    render(<LandingPage />);

    const receipt = within(screen.getByRole("group", { name: "Admission receipt" }));
    const before = receipt.getByRole("button", { name: "Before adoption" });
    const after = receipt.getByRole("button", { name: "After adoption" });
    const status = receipt.getByRole("status");
    const current = receipt.getByText("Already started", { exact: false }).parentElement;
    const next = receipt.getByText("Next start", { exact: false }).parentElement;
    expect(after).toHaveAttribute("aria-pressed", "true");
    expect(current).toHaveTextContent(/WO–024\s*R07/);
    expect(next).toHaveTextContent(/WO–025\s*R08/);

    before.focus();
    await user.keyboard(" ");
    expect(before).toHaveAttribute("aria-pressed", "true");
    expect(status).toHaveTextContent("Before adoption / R07 still active");
    expect(current).toHaveTextContent(/WO–024\s*R07/);
    expect(next).toHaveTextContent(/WO–025\s*R07/);

    await user.keyboard("{ArrowRight}");
    expect(after).toHaveFocus();
    expect(after).toHaveAttribute("aria-pressed", "true");
    expect(status).toHaveTextContent(/After a workspace owner or admin adopts.*025 uses R08/);
    expect(current).toHaveTextContent(/WO–024\s*R07/);
    expect(next).toHaveTextContent(/WO–025\s*R08/);
    expect(screen.getByText("Intake ticket / Factory R07")).toBeVisible();
    const recipe = within(screen.getByRole("figure", { name: "Release CLI" }));
    expect(recipe.getByText("R07", { exact: true })).toBeVisible();
    expect(recipe.getByText("Published", { exact: true })).toBeVisible();
  });
});
