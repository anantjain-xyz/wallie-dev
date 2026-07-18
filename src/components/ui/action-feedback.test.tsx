// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { RouteProgressProvider, useRouteProgress } from "@/components/ui/route-progress";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared action feedback", () => {
  it("keeps pending copy in layout and exposes text without relying on animation", () => {
    const view = render(
      <button type="button">
        <ActionButtonLabel idle="Save" pending={false} pendingLabel="Saving changes…" />
      </button>,
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    const reserved = screen.getByText("Saving changes…");
    expect(reserved).toHaveAttribute("aria-hidden", "true");
    expect(reserved).toHaveClass("invisible");

    view.rerender(
      <button type="button">
        <ActionButtonLabel idle="Save" pending pendingLabel="Saving changes…" />
      </button>,
    );
    expect(screen.getByRole("button", { name: "Saving changes…" })).toBeTruthy();
  });

  it("waits a frame before showing route progress and clears after the URL changes", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    window.history.replaceState({}, "", "/current");

    function NavigationTrigger() {
      const { startNavigation } = useRouteProgress();
      return (
        <button onClick={() => startNavigation("/next")} type="button">
          Navigate
        </button>
      );
    }

    render(
      <RouteProgressProvider>
        <NavigationTrigger />
      </RouteProgressProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.queryByRole("status", { name: "Loading page…" })).toBeNull();

    act(() => frames.shift()?.(16));
    expect(screen.getByRole("status")).toHaveTextContent("Loading page…");

    window.history.pushState({}, "", "/next");
    act(() => frames.shift()?.(32));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
