// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusShowcase } from "@/components/ui/status-showcase";
import {
  AGENT_RUN_STATUS_VALUES,
  CONFIGURATION_STATUS_BY_TONE,
  SESSION_PHASE_STATUS_VALUES,
  Status,
  STATUS_DEFINITIONS,
  STATUS_VALUES,
  resolveStatusDefinition,
  type StatusValue,
} from "@/components/ui/status";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  document.documentElement.dataset.theme = "light";
});

describe("product status grammar", () => {
  it("defines exact sentence-case copy and semantic tones for every status", () => {
    expect(Object.keys(STATUS_DEFINITIONS)).toEqual([...STATUS_VALUES]);
    expect(STATUS_DEFINITIONS).toMatchObject({
      agent_generating: { label: "Agent generating", tone: "progress" },
      approved: { label: "Approved", tone: "success" },
      archived: { label: "Archived", tone: "subdued" },
      awaiting_review: { label: "Awaiting review", tone: "attention" },
      blocked: { label: "Blocked", tone: "danger" },
      canceled: { label: "Canceled", tone: "subdued" },
      complete: { label: "Complete", tone: "success" },
      failed: { label: "Failed", tone: "danger" },
      healthy: { label: "Healthy", tone: "success" },
      needs_attention: { label: "Needs attention", tone: "warning" },
      not_started: { label: "Not started", tone: "neutral" },
      queued: { label: "Queued", tone: "neutral" },
      rejected: { label: "Changes requested", tone: "warning" },
      running: { label: "Running", tone: "progress" },
      skipped: { label: "Skipped", tone: "subdued" },
      upcoming: { label: "Upcoming", tone: "neutral" },
    });
  });

  it("keeps source enums exhaustive through typed adapters", () => {
    expect(SESSION_PHASE_STATUS_VALUES).toEqual({
      agent_generating: "agent_generating",
      approved: "approved",
      awaiting_review: "awaiting_review",
      rejected: "rejected",
    });
    expect(AGENT_RUN_STATUS_VALUES).toEqual({
      canceled: "canceled",
      error: "failed",
      queued: "queued",
      running: "running",
      started: "running",
      success: "complete",
    });
    expect(CONFIGURATION_STATUS_BY_TONE).toEqual({
      accent: "not_started",
      danger: "blocked",
      neutral: "not_started",
      success: "healthy",
      warning: "needs_attention",
    });
  });

  it("pairs every tone with visible text, a non-color icon, and an accessible description", () => {
    const { container } = render(
      <div>
        {STATUS_VALUES.map((value) => (
          <Status key={value} value={value} />
        ))}
      </div>,
    );

    const statuses = container.querySelectorAll(".ui-status");
    expect(statuses).toHaveLength(STATUS_VALUES.length);
    statuses.forEach((status, index) => {
      const value = STATUS_VALUES[index]!;
      const definition = STATUS_DEFINITIONS[value];
      expect(status).toHaveTextContent(definition.label);
      expect(status).toHaveAttribute(
        "aria-label",
        `${definition.label}. ${definition.description}`,
      );
      expect(status.querySelector("svg")).not.toBeNull();
      expect(status).toHaveAttribute("data-tone", definition.tone);
    });

    expect(screen.getByText("Awaiting review").closest(".ui-status")).toHaveAttribute(
      "data-tone",
      "attention",
    );
    expect(screen.getByText("Approved").closest(".ui-status")).toHaveAttribute(
      "data-tone",
      "success",
    );
  });

  it("keeps compact labels visible and exposes clamped determinate progress", () => {
    render(<Status compact progress={140} value="running" />);

    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Running progress" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });

  it("fails safely and logs unknown runtime values in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const definition = resolveStatusDefinition("future_state");
    render(<Status value={"future_state" as StatusValue} />);

    expect(definition.label).toBe("Unknown status");
    expect(screen.getByText("Unknown status").closest(".ui-status")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(warn).toHaveBeenCalledWith("Unknown product status", { value: "future_state" });
  });
});

describe("status story fixtures", () => {
  it("renders every value at default and compact density with progress fixtures", () => {
    const { container } = render(<StatusShowcase />);

    expect(container.querySelectorAll(".ui-status")).toHaveLength(STATUS_VALUES.length * 2 + 3);
    expect(screen.getByRole("heading", { name: "Default" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Compact" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Determinate progress" })).toBeVisible();
  });

  it("provides both themes and every color-vision simulation", async () => {
    const user = userEvent.setup();
    render(<StatusShowcase />);

    await user.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    for (const name of [
      "Forced colors preview",
      "Protanopia",
      "Deuteranopia",
      "Tritanopia",
      "Achromatopsia",
    ]) {
      await user.click(screen.getByRole("button", { name }));
      expect(screen.getByTestId("status-fixtures")).toHaveAttribute(
        "data-status-simulation",
        name === "Forced colors preview" ? "forced-colors" : name.toLowerCase(),
      );
    }

    await user.click(screen.getByRole("button", { name: "200% zoom preview" }));
    expect(screen.getByTestId("status-fixtures")).toHaveAttribute("data-status-zoom", "200");
  });
});
