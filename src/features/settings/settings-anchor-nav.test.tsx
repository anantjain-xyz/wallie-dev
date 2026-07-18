// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type SettingsAnchorGroup,
  SettingsAnchorNav,
} from "@/features/settings/settings-anchor-nav";

const groups: SettingsAnchorGroup[] = [
  {
    anchors: [
      { id: "github", label: "GitHub" },
      { id: "repository", label: "Repositories" },
      { id: "runtime", label: "Agent" },
    ],
    label: "Integrations",
  },
];

const observe = vi.fn();
const disconnect = vi.fn();
const scrollIntoView = vi.fn();

class IntersectionObserverMock implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [0, 1];

  disconnect = disconnect;
  observe = observe;
  takeRecords = vi.fn(() => []);
  unobserve = vi.fn();
}

beforeEach(() => {
  observe.mockClear();
  disconnect.mockClear();
  scrollIntoView.mockClear();
  window.history.replaceState(null, "", "/settings");
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsAnchorNav", () => {
  it("observes Settings sections inserted after the navigation mounts", async () => {
    render(
      <>
        <SettingsAnchorNav groups={groups} />
        <section id="github" />
      </>,
    );

    expect(observe).toHaveBeenCalledWith(document.getElementById("github"));

    const repository = document.createElement("section");
    repository.id = "repository";
    document.body.append(repository);

    await waitFor(() => expect(observe).toHaveBeenCalledWith(repository));
  });

  it.each([
    ["#repository", "repository"],
    ["#coding-agent", "runtime"],
  ])("scrolls %s after its streamed target mounts", async (hash, targetId) => {
    window.history.replaceState(null, "", `/settings${hash}`);
    render(<SettingsAnchorNav groups={groups} legacyRedirects={{ "coding-agent": "runtime" }} />);

    expect(scrollIntoView).not.toHaveBeenCalled();

    const target = document.createElement("section");
    target.id = targetId;
    document.body.append(target);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(window.location.hash).toBe(`#${targetId}`);
  });
});
