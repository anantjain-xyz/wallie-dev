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

    await user.click(line.getByRole("button", { name: "v1" }));
    expect(line.getByText("Session review / Changes requested")).toBeVisible();
    expect(line.queryByRole("button", { name: "Approve Build v2" })).not.toBeInTheDocument();

    await user.click(line.getByRole("button", { name: "v2" }));
    await user.click(line.getByText("Read the check evidence"));
    expect(line.getByText(/the observed count was 0/)).toBeVisible();
    await user.click(line.getByRole("button", { name: "Approve Build v2" }));
    expect(line.getByText(/This did not merge code or edit the factory/)).toBeVisible();
    expect(line.getByText(/the observed count was 0/)).toBeVisible();
    const delivery = line.getByRole("button", { name: "See delivery" });
    expect(delivery).toHaveFocus();
    expect(screen.getByText("R08 draft / Test needed")).toBeVisible();

    await user.click(delivery);
    expect(line.getByRole("heading", { name: "Code can leave in a GitHub PR." })).toHaveFocus();
    expect(line.getByText(/Delivery runs separately from stage review/)).toBeVisible();
    await user.click(line.getByRole("button", { name: "Replay the work order" }));
    expect(line.getByRole("heading", { name: "A task becomes a session." })).toHaveFocus();
    await user.click(line.getByRole("button", { name: "Build" }));
    expect(line.getByRole("button", { name: "Request changes" })).toBeVisible();
    expect(line.queryByRole("group", { name: "Build artifact versions" })).not.toBeInTheDocument();
  });

  it("publishes a tested revision only for the next work order and can replay it", async () => {
    const user = userEvent.setup();
    render(<LandingPage />);

    const bench = within(
      screen.getByRole("region", { name: "Manual factory revision demonstration" }),
    );
    const status = bench.getByRole("status");
    const receipt = status.parentElement;
    expect(
      bench.queryByRole("button", { name: "Publish R08 in the tour" }),
    ).not.toBeInTheDocument();
    expect(receipt).toHaveTextContent(/Next work order 025\s*R07/);

    const test = bench.getByRole("button", { name: "Run configuration test" });
    test.focus();
    await user.keyboard(" ");
    expect(status).toHaveTextContent("R08 draft / Configuration test passed");
    expect(receipt).toHaveTextContent(/Next work order 025\s*R07/);
    expect(bench.getByRole("button", { name: "Publish R08 in the tour" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(status).toHaveTextContent("Published / New sessions use R08");
    expect(receipt).toHaveTextContent(/Old work order 024\s*R07/);
    expect(receipt).toHaveTextContent(/Next work order 025\s*R08/);
    expect(screen.getByText("Intake ticket / Factory R07")).toBeVisible();

    await user.click(bench.getByRole("button", { name: "Replay the revision" }));
    expect(status).toHaveTextContent("R08 draft / Test needed");
    expect(receipt).toHaveTextContent(/Next work order 025\s*R07/);
  });
});
