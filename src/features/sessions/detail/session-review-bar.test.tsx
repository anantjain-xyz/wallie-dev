// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { SessionReviewBar } from "@/features/sessions/detail/session-review-bar";

function renderBar(overrides: Partial<Parameters<typeof SessionReviewBar>[0]> = {}) {
  const onApprove = vi.fn();
  const onReject = vi.fn().mockResolvedValue(true);
  const onStopRun = vi.fn();

  const view = render(
    createElement(
      OverlayProvider,
      null,
      createElement(SessionReviewBar, {
        approveLabel: "Approve & advance",
        mode: { canApprove: true, kind: "reviewable" },
        onApprove,
        onReject,
        onStopRun,
        phaseActionPending: null,
        stopPending: false,
        ...overrides,
      }),
    ),
  );

  return { ...view, onApprove, onReject, onStopRun };
}

describe("SessionReviewBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("approves with a single confirmation click", () => {
    const { onApprove } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Approve & advance" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("rejects whitespace-only feedback and keeps the dialog open", async () => {
    const { onReject } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Feedback for Wallie"), {
      target: { value: "   \n\t  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue rerun" }));
    expect(onReject).not.toHaveBeenCalled();
    expect(await screen.findByText(/Feedback is required/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("preserves feedback when reject submission fails", async () => {
    const onReject = vi.fn().mockResolvedValue(false);
    renderBar({ onReject });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("Feedback for Wallie"), {
      target: { value: "Please fix the tone." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue rerun" }));
    await waitFor(() => expect(onReject).toHaveBeenCalledWith("Please fix the tone."));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Feedback for Wallie")).toHaveValue("Please fix the tone.");
  });

  it("prevents duplicate submit while a phase action is pending", () => {
    const { onApprove } = renderBar({ phaseActionPending: "approve" });
    fireEvent.click(screen.getByRole("button", { name: /Approving/ }));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("shows an explicit read-only reason for unauthorized sessions", () => {
    renderBar({
      mode: {
        kind: "unauthorized",
        reason: "You are not authorized to approve or request changes on this stage.",
      },
    });
    expect(screen.getByText(/not authorized/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve & advance" })).toBeNull();
  });

  it("keeps Request changes when approve is unauthorized", () => {
    renderBar({ mode: { canApprove: false, kind: "reviewable" } });
    expect(screen.getByRole("button", { name: "Request changes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve & advance" })).toBeNull();
    expect(screen.getByText(/not authorized to approve this stage/i)).toBeTruthy();
  });

  it("shows an explicit read-only reason for archived sessions", () => {
    renderBar({
      mode: {
        kind: "archived",
        reason: "This session is archived. Unarchive it to resume review.",
      },
    });
    expect(screen.getByText(/archived/i)).toBeTruthy();
  });

  it("shows an explicit read-only reason for failed runs", () => {
    renderBar({
      mode: {
        kind: "failed",
        reason: "The latest run failed. Review is paused until Wallie produces a new artifact.",
      },
    });
    expect(screen.getByText(/latest run failed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve & advance" })).toBeNull();
  });

  it("shows an explicit read-only reason when viewing a historical artifact", () => {
    renderBar({
      mode: {
        kind: "historical_version",
        reason: "You’re viewing an older version. Return to Latest to approve or request changes.",
      },
    });
    expect(screen.getByText(/older version/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve & advance" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
  });

  it("shows stop controls while running", () => {
    const { onStopRun } = renderBar({ mode: { kind: "running" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(onStopRun).toHaveBeenCalledTimes(1);
  });

  it("uses safe-area-aware sticky padding", () => {
    const { container } = renderBar();
    expect(container.innerHTML).toContain("pb-[max(0.75rem,env(safe-area-inset-bottom))]");
    expect(container.innerHTML).toContain("env(safe-area-inset-left)");
    expect(container.innerHTML).toContain("env(safe-area-inset-right)");
    expect(container.innerHTML).toContain("sticky bottom-0");
  });

  it("restores focus to Request changes when the dialog closes", async () => {
    renderBar();
    const trigger = screen.getByRole("button", { name: "Request changes" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});
