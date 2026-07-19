// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveSettingsHashRoute,
  SettingsCategoryNav,
} from "@/features/settings/settings-category-nav";
import { SETTINGS_CATEGORY_LINKS } from "@/features/settings/settings-categories";
import { OverlayProvider } from "@/components/ui/overlay-provider";
import {
  SettingsDirtyRegistryProvider,
  useRegisterSettingsDirtySource,
} from "@/features/settings/settings-dirty-registry";

const push = vi.fn();
const replace = vi.fn();
let pathname = "/w/acme/settings/advanced";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push, replace }),
}));

function DirtySource() {
  useRegisterSettingsDirtySource("nav-probe", true, true);
  return null;
}

function renderNav(activeCategory: "advanced" | "general" | "integrations" = "advanced") {
  return render(
    <OverlayProvider>
      <SettingsDirtyRegistryProvider>
        <SettingsCategoryNav activeCategory={activeCategory} workspaceSlug="acme" />
      </SettingsDirtyRegistryProvider>
    </OverlayProvider>,
  );
}

function renderDirtyNav(activeCategory: "advanced" | "general" | "integrations" = "general") {
  return render(
    <OverlayProvider>
      <SettingsDirtyRegistryProvider>
        <DirtySource />
        <SettingsCategoryNav activeCategory={activeCategory} workspaceSlug="acme" />
      </SettingsDirtyRegistryProvider>
    </OverlayProvider>,
  );
}

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/features/settings/islands/integration-islands", () => ({}));
vi.mock("@/features/settings/islands/pipeline-island", () => ({
  preloadPipelineEditor: vi.fn(),
}));
vi.mock("@/features/settings/islands/advanced-islands", () => ({}));
vi.mock("@/features/settings/islands/workspace-islands", () => ({}));

beforeEach(() => {
  push.mockClear();
  replace.mockClear();
  pathname = "/w/acme/settings/advanced";
  window.history.replaceState(null, "", "/w/acme/settings/advanced");

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
});

afterEach(() => {
  cleanup();
  push.mockClear();
  replace.mockClear();
  pathname = "/w/acme/settings/advanced";
  window.history.replaceState(null, "", "/w/acme/settings/advanced");
  vi.unstubAllGlobals();
});

describe("resolveSettingsHashRoute", () => {
  it("maps legacy aliases to their owning category and anchor", () => {
    expect(resolveSettingsHashRoute("#coding-agent")).toEqual({
      anchor: "runtime",
      category: "agent-execution",
    });
    expect(resolveSettingsHashRoute("cloud-execution")).toEqual({
      anchor: "verify",
      category: "advanced",
    });
    expect(resolveSettingsHashRoute("#linear-routing")).toEqual({
      anchor: "linear",
      category: "integrations",
    });
    expect(resolveSettingsHashRoute("#secrets")).toEqual({
      anchor: "runtime",
      category: "agent-execution",
    });
    expect(resolveSettingsHashRoute("#danger-zone")).toEqual({
      anchor: "danger-zone",
      category: "advanced",
    });
    expect(resolveSettingsHashRoute("#members")).toEqual({
      anchor: "members",
      category: "members",
    });
    expect(resolveSettingsHashRoute("#workspace")).toEqual({
      anchor: "workspace",
      category: "general",
    });
    expect(resolveSettingsHashRoute("#unknown")).toBeNull();
  });
});

describe("SettingsCategoryNav", () => {
  it("sticks below the safe-area-aware shell header on desktop", () => {
    const { getByRole } = renderNav("advanced");

    expect(getByRole("navigation", { name: "Settings categories" })).toHaveClass(
      "top-[var(--shell-scroll-padding)]",
    );
  });

  it("links every category to a path-backed route", () => {
    renderNav("general");

    for (const category of SETTINGS_CATEGORY_LINKS) {
      expect(screen.getByRole("link", { name: new RegExp(category.label, "i") })).toHaveAttribute(
        "href",
        `/w/acme/settings/${category.id}`,
      );
    }
  });

  it("exposes a labelled mobile category select", async () => {
    const user = userEvent.setup();
    renderNav("general");

    const trigger = screen.getByRole("combobox", { name: "Settings category" });
    expect(trigger).toBeInTheDocument();

    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Pipeline" }));

    expect(push).toHaveBeenCalledWith("/w/acme/settings/pipeline");
  });

  it("prompts before mobile category changes when drafts are dirty", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    pathname = "/w/acme/settings/general";
    renderDirtyNav("general");

    const trigger = screen.getByRole("combobox", { name: "Settings category" });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Pipeline" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("routes hash-only Open actions to the matching category path", async () => {
    renderNav("advanced");

    window.history.replaceState(null, "", "/w/acme/settings/advanced#github");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/w/acme/settings/integrations#github");
    });
  });

  it("rewrites legacy hashes to their current anchors on the owning route", async () => {
    pathname = "/w/acme/settings/integrations";
    renderNav("integrations");

    window.history.replaceState(null, "", "/w/acme/settings/integrations#coding-agent");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/w/acme/settings/agent-execution#runtime");
    });
  });

  it("does not navigate when the hash already matches the active category and anchor", async () => {
    window.history.replaceState(null, "", "/w/acme/settings/advanced#verify");
    renderNav("advanced");

    await waitFor(() => {
      expect(replace).not.toHaveBeenCalled();
    });
  });

  it("blocks cross-category hash routing when drafts are dirty and the user cancels", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    pathname = "/w/acme/settings/general";
    window.history.replaceState(null, "", "/w/acme/settings/general");
    renderDirtyNav("general");

    window.history.replaceState(null, "", "/w/acme/settings/general#vercel");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
    });
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });
});
