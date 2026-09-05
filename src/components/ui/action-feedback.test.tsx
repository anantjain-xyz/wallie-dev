// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import {
  hasUsableRouteContent,
  RouteProgressProvider,
  useRouteProgress,
} from "@/components/ui/route-progress";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared action feedback", () => {
  it("offers recovery after a slow navigation without implying completion", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    window.history.replaceState({}, "", "/current");
    function Trigger() {
      const { startNavigation } = useRouteProgress();
      return <button onClick={() => startNavigation("/slow")}>Navigate</button>;
    }
    render(
      <RouteProgressProvider>
        <Trigger />
      </RouteProgressProvider>,
    );
    fireEvent.click(screen.getByText("Navigate"));
    act(() => vi.advanceTimersByTime(15_000));
    expect(screen.getByText("This page is taking longer than usual.")).toBeTruthy();
    expect(document.querySelector("[data-route-progress]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open page again" })).toHaveAttribute("href", "/slow");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(document.querySelector("[data-route-progress]")).toBeNull();
  });

  it("recognizes onboarding content with its heading outside main", () => {
    const view = render(
      <>
        <header>
          <h1>Set up your workspace</h1>
        </header>
        <main id="main-content">
          <button>Continue</button>
        </main>
      </>,
    );
    expect(hasUsableRouteContent()).toBe(true);
    view.rerender(
      <>
        <header>
          <h1>Set up your workspace</h1>
        </header>
        <main id="main-content">
          <section role="status" aria-busy="true">
            Loading
          </section>
        </main>
      </>,
    );
    expect(hasUsableRouteContent()).toBe(false);
  });

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
    expect(reserved.querySelector(".animate-none")).toBeTruthy();
    expect(reserved.querySelector(".animate-spin")).toBeNull();

    view.rerender(
      <button type="button">
        <ActionButtonLabel idle="Save" pending pendingLabel="Saving changes…" />
      </button>,
    );
    expect(screen.getByRole("button", { name: "Saving changes…" })).toBeTruthy();
    expect(screen.getByRole("button").querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("waits before showing progress and keeps it until destination content is ready", () => {
    vi.useFakeTimers();
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
        <main id="main-content">
          <h1>Page</h1>
        </main>
      </RouteProgressProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.queryByRole("status", { name: "Loading page…" })).toBeNull();

    act(() => frames.shift()?.(16));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole("status")).toHaveTextContent("Loading page…");

    window.history.pushState({}, "", "/next");
    const skeleton = document.createElement("section");
    skeleton.setAttribute("role", "status");
    skeleton.setAttribute("aria-busy", "true");
    document.getElementById("main-content")!.append(skeleton);
    act(() => frames.shift()?.(32));
    expect(document.querySelector("[data-route-progress]")).not.toBeNull();
    skeleton.remove();
    act(() => frames.shift()?.(48));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears an active navigation when a same-route request supersedes it", () => {
    vi.useFakeTimers();
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
        <>
          <button onClick={() => startNavigation("/next")} type="button">
            Next
          </button>
          <button onClick={() => startNavigation("/current")} type="button">
            Current
          </button>
        </>
      );
    }

    render(
      <RouteProgressProvider>
        <NavigationTrigger />
        <main id="main-content">
          <h1>Page</h1>
        </main>
      </RouteProgressProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    act(() => frames.shift()?.(16));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole("status")).toHaveTextContent("Loading page…");

    fireEvent.click(screen.getByRole("button", { name: "Current" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
