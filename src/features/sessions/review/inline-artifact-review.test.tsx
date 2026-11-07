// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InlineArtifactReview } from "./inline-artifact-review";
import { OPEN_REVIEW_COMMENTS_EVENT } from "./open-comments";

vi.mock("next/dynamic", () => ({
  default:
    () => (props: { anchor: { quote: string } | null; onClose: () => void; readOnly: boolean }) => (
      <aside id="artifact-review-panel">
        <p>{props.anchor?.quote ?? "Saved comments"}</p>
        {props.readOnly ? <p>Read only</p> : null}
        <textarea aria-label="Comment draft" />
        <button onClick={props.onClose}>Collapse comments</button>
      </aside>
    ),
}));

const props = {
  sessionId: "session",
  artifactId: "artifact",
  artifactVersion: 1,
  source: "# Goal\n\nRetain changes.",
  historical: false,
  readOnly: false,
};
function subject(overrides = {}) {
  return render(
    <InlineArtifactReview {...props} {...overrides}>
      <p>
        <span data-review-text-start="8" data-review-text-end="23">
          Retain changes.
        </span>
      </p>
    </InlineArtifactReview>,
  );
}
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.getSelection()?.removeAllRanges();
});

describe("inline artifact review entry", () => {
  it("offers keyboard block commenting and restores focus on close", async () => {
    const user = userEvent.setup();
    subject();
    const opener = screen.getByRole("button", { name: "Show comments" });
    expect(opener).toHaveAttribute("id", "artifact-review-open");
    expect(opener).toHaveAttribute("aria-expanded", "false");
    expect(opener).toHaveAttribute("aria-controls", "artifact-review-panel");
    expect(opener.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(opener);
    expect(screen.queryByRole("button", { name: "Show comments" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Comment on a block"), "1");
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(screen.getByText("Retain changes.", { selector: "aside p" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse comments" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show comments" }));
  });
  it("keeps comments mounted and retains drafts when collapsed and reopened", async () => {
    const user = userEvent.setup();
    subject();
    await user.click(screen.getByRole("button", { name: "Show comments" }));
    const draft = screen.getByRole("textbox", { name: "Comment draft" });
    await user.type(draft, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Collapse comments" }));
    expect(draft).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show comments" }));
    expect(screen.getByRole("textbox", { name: "Comment draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep this draft");
  });
  it("captures selected text before focus moves to the action", async () => {
    const user = userEvent.setup();
    subject();
    const span = screen.getByText("Retain changes.", { selector: "span" });
    const range = document.createRange();
    range.setStart(span.firstChild!, 0);
    range.setEnd(span.firstChild!, 6);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(span);
    await user.click(screen.getByRole("button", { name: "Comment on selection" }));
    expect(screen.getByText("Retain", { selector: "aside p" })).toBeTruthy();
  });
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
  it("removes all authoring entry points when the session archives", async () => {
    const user = userEvent.setup();
    const view = subject();
    await user.click(screen.getByRole("button", { name: "Show comments" }));
    view.rerender(
      <InlineArtifactReview {...props} readOnly>
        <p>Source</p>
      </InlineArtifactReview>,
    );
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    expect(screen.queryByLabelText("Comment on a block")).toBeNull();
    expect(screen.getByText("Read only")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse comments" }));
    expect(screen.getByText("Archived session · Comments are read-only")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show comments" }));
    expect(screen.getByText("Read only")).toBeVisible();
  });
});
