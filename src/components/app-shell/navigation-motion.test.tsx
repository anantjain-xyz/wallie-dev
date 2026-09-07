// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RouteEntrance } from "./navigation-motion";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.reducedMotion;
});

it("waits for streamed content and does not replay for same-route updates", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  const view = (pathname: string, loading: boolean, title: string) => (
    <main id="main-content">
      <RouteEntrance pathname={pathname} />
      <section data-route-loading={loading ? true : undefined}>
        <h1>{title}</h1>
      </section>
    </main>
  );
  const result = render(view("/first", false, "First page"));
  expect(animate).not.toHaveBeenCalled();
  result.rerender(view("/second", true, "Loading"));
  expect(animate).not.toHaveBeenCalled();
  result.rerender(view("/second", false, "Second page"));
  await waitFor(() => expect(animate).toHaveBeenCalledOnce());
  result.rerender(view("/second", false, "Background update"));
  expect(animate).toHaveBeenCalledOnce();
  result.unmount();
  expect(cancel).toHaveBeenCalledOnce();
});
