// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ViewportCoordinator } from "@/components/ui/viewport-coordinator";

class VisualViewportStub extends EventTarget {
  height = 700;
  offsetTop = 0;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("style");
});

describe("ViewportCoordinator", () => {
  it("tracks the visual viewport and scrolls linked validation content above the keyboard", () => {
    const viewport = new VisualViewportStub();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);

    const view = render(
      <>
        <ViewportCoordinator />
        <header data-shell-header="" />
        <input aria-describedby="field-error" aria-label="Field" />
        <p id="field-error" role="alert">
          Fix this value.
        </p>
      </>,
    );
    const header = view.container.querySelector("header")!;
    const field = view.getByLabelText("Field");
    const error = view.getByRole("alert");
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue({
      bottom: 60,
    } as DOMRect);
    vi.spyOn(field, "getBoundingClientRect").mockReturnValue({
      bottom: 294,
      top: 250,
    } as DOMRect);
    vi.spyOn(error, "getBoundingClientRect").mockReturnValue({
      bottom: 340,
      top: 300,
    } as DOMRect);

    field.focus();
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));

    expect(document.documentElement.style.getPropertyValue("--wallie-visual-viewport-center")).toBe(
      "150px",
    );
    expect(document.documentElement.style.getPropertyValue("--wallie-visual-viewport-height")).toBe(
      "300px",
    );
    expect(scrollBy).toHaveBeenLastCalledWith({ behavior: "instant", top: 56 });
  });
});
