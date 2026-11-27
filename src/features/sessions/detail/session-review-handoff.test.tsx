// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SESSION_REVIEW_DECISION_ID, SessionReviewHandoff } from "./session-review-handoff";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("jumps to the one decision without changing an exact link or its evidence hash", () => {
  const url = "/w/demo/sessions/1?artifactVersion=2&reviewRevision=7#browser-screenshot-fixture";
  window.history.replaceState(null, "", url);
  render(
    <>
      <SessionReviewHandoff title="Review Design v2" jumpLabel="Jump to decision" />
      <h3 id={SESSION_REVIEW_DECISION_ID} tabIndex={-1}>
        Stage decision
      </h3>
    </>,
  );
  const heading = screen.getByRole("heading", { name: "Stage decision" });
  const scrollIntoView = vi.fn();
  Object.assign(heading, { scrollIntoView });
  const jump = screen.getByRole("link", { name: "Jump to decision" });
  jump.focus();
  fireEvent.click(jump);
  expect(heading).toHaveFocus();
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
  expect(window.location.href.endsWith(url)).toBe(true);
});

it.each([false, true])("plays the mark only once per confirmation (reduced: %s)", (reduced) => {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const { container, rerender } = render(
    <SessionReviewHandoff title="Review Design v2" status="Approving…" />,
  );
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  Object.assign(container.querySelector("[data-wallie-mark]")!.parentElement!, { animate });
  expect(animate).not.toHaveBeenCalled();

  const approved = (
    <SessionReviewHandoff title="Design approved" status="Build queued." confirmation="receipt" />
  );
  rerender(approved);
  expect(screen.getByRole("heading", { name: "Design approved" })).toBeVisible();
  expect(screen.getByText("Build queued.")).toBeVisible();
  expect(animate).toHaveBeenCalledTimes(reduced ? 0 : 1);
  if (!reduced) {
    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 0.55, transform: "translateY(2px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      expect.objectContaining({ duration: 120 }),
    );
  }
  rerender(<SessionReviewHandoff title="Read-only design" />);
  rerender(approved);
  expect(animate).toHaveBeenCalledTimes(reduced ? 0 : 1);
});
