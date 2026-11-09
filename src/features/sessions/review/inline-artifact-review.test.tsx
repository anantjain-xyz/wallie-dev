// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewReadOnlyReason } from "./comment-access";
import { InlineArtifactReview } from "./inline-artifact-review";
import { OPEN_REVIEW_COMMENTS_EVENT } from "./open-comments";
import type { ArtifactReviewPanelProps } from "./review-panel";

const permission = vi.hoisted(() => ({ reason: null as ReviewReadOnlyReason | null }));
vi.mock("next/dynamic", () => ({
  default: () =>
    function MockReviewPanel(props: ArtifactReviewPanelProps) {
      const onReadOnlyReasonChange = props.inline?.onReadOnlyReasonChange;
      const reason = props.readOnlyReason ?? permission.reason;
      useLayoutEffect(() => onReadOnlyReasonChange?.(reason), [onReadOnlyReasonChange, reason]);
      return (
        <aside id="artifact-review-panel">
          <p>{props.anchor?.quote ?? "Saved comments"}</p>
          {reason ? <p>Read only</p> : null}
          <button onClick={props.onClose}>Close comments</button>
        </aside>
      );
    },
}));

const props = {
  sessionId: "session",
  artifactId: "artifact",
  artifactVersion: 1,
  source: "# Goal\n\nRetain changes.",
  historical: false,
  readOnlyReason: null,
};
function content() {
  return (
    <p>
      <span data-review-text-start="8" data-review-text-end="23">
        Retain changes.
      </span>
    </p>
  );
}
function subject(overrides = {}) {
  return render(
    <InlineArtifactReview {...props} {...overrides}>
      {content()}
    </InlineArtifactReview>,
  );
}
function selectText(entryPoint: "pointerUp" | "keyUp" = "pointerUp") {
  const span = screen.getByText("Retain changes.", { selector: "span" });
  const range = document.createRange();
  range.setStart(span.firstChild!, 0);
  range.setEnd(span.firstChild!, 6);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  if (entryPoint === "pointerUp") fireEvent.pointerUp(span);
  else fireEvent.keyUp(span, { key: "ArrowRight", shiftKey: true });
}
beforeEach(() => {
  permission.reason = null;
  window.history.replaceState(null, "", "/");
  window.getSelection()?.removeAllRanges();
});

describe("inline artifact review entry", () => {
  it("removes the block picker and restores focus on close", async () => {
    const user = userEvent.setup();
    subject();
    const opener = screen.getByRole("button", { name: "Comments" });
    opener.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByLabelText("Comment on a block")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add comment$/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close comments" }));
    expect(opener).toHaveFocus();
  });
  it("keeps the captured anchor when keyboard focus clears the native selection", async () => {
    const user = userEvent.setup();
    subject();
    selectText("keyUp");
    const action = screen.getByRole("button", { name: "Comment on selection" });
    action.focus();
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyUp(action, { key: "Tab" });
    expect(action).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Retain", { selector: "aside p" })).toBeVisible();
  });
  it("does not recapture a cleared native selection from the action's pointerup", async () => {
    subject();
    selectText();
    const action = screen.getByRole("button", { name: "Comment on selection" });
    fireEvent.pointerDown(action);
    window.getSelection()?.removeAllRanges();
    fireEvent.pointerUp(action);
    fireEvent.click(action);
    expect(screen.getByText("Retain", { selector: "aside p" })).toBeVisible();
  });
  it.each(["pointerUp", "keyUp"] as const)(
    "captures %s selected text before focus moves to the action",
    async (entryPoint) => {
      const user = userEvent.setup();
      subject();
      await user.click(screen.getByRole("button", { name: "Comments" }));
      selectText(entryPoint);
      await user.click(screen.getByRole("button", { name: "Comment on selection" }));
      expect(screen.getByText("Retain", { selector: "aside p" })).toBeTruthy();
    },
  );
  it("opens a shared thread directly without selecting a new anchor", async () => {
    window.history.replaceState(null, "", "/?reviewThread=thread");
    subject();
    await waitFor(() => expect(screen.getByText("Saved comments")).toBeTruthy());
  });
  it("opens comments from the review evidence panel", async () => {
    subject();
    act(() => window.dispatchEvent(new Event(OPEN_REVIEW_COMMENTS_EVENT)));
    expect(await screen.findByText("Saved comments")).toBeTruthy();
  });
  it.each([
    ["approved", "This session is approved. Comments are read-only."],
    ["archived", "This session is archived. Comments are read-only."],
    ["unauthorized", "You do not have permission to comment on this artifact."],
    ["loading", "Checking comment permissions…"],
    [
      "unavailable",
      "Comments are unavailable until permissions can be verified. Retry loading comments.",
    ],
  ] satisfies [ReviewReadOnlyReason, string][])(
    "disables keyboard and selection authoring for %s permissions",
    async (reason, message) => {
      const user = userEvent.setup();
      permission.reason = reason;
      subject();
      await user.click(screen.getByRole("button", { name: "Comments" }));
      expect(screen.getByText(message)).toBeVisible();
      selectText();
      selectText("keyUp");
      if (reason === "loading") {
        expect(screen.getByRole("button", { name: "Comment on selection" })).toBeDisabled();
      } else {
        expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
      }
      expect(screen.getByText("Saved comments")).toBeVisible();
      if (reason !== "archived") expect(screen.queryByText(/This session is archived/)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Close comments" }));
      expect(screen.getByRole("button", { name: "Comments" })).toHaveFocus();
    },
  );
  it("immediately disables authoring when the live session archives", async () => {
    const user = userEvent.setup();
    const view = subject();
    await user.click(screen.getByRole("button", { name: "Comments" }));
    selectText();
    expect(screen.getByRole("button", { name: "Comment on selection" })).toBeEnabled();
    view.rerender(
      <InlineArtifactReview {...props} readOnlyReason="archived">
        {content()}
      </InlineArtifactReview>,
    );
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    expect(screen.getByText("Read only")).toBeTruthy();
  });
  it("verifies selection permissions before enabling the lazily loaded comment action", async () => {
    const user = userEvent.setup();
    permission.reason = "loading";
    const view = subject();
    selectText("keyUp");
    const action = screen.getByRole("button", { name: "Comment on selection" });
    expect(action).toBeDisabled();
    expect(action).toHaveAccessibleDescription("Checking comment permissions…");
    await user.click(action);
    expect(screen.queryByRole("button", { name: "Close comments" })).toBeNull();
    permission.reason = null;
    view.rerender(<InlineArtifactReview {...props}>{content()}</InlineArtifactReview>);
    expect(screen.getByRole("button", { name: "Comment on selection" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Comment on selection" }));
    expect(screen.getByText("Retain", { selector: "aside p" })).toBeVisible();
    // The real panel focuses its composer; this double has only a close control.
    screen.getByRole("button", { name: "Close comments" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Comments" })).toHaveFocus();
  });
});
