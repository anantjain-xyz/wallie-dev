// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveSettingsHashRoute,
  SettingsCategoryNav,
} from "@/features/settings/settings-category-nav";

const replace = vi.fn();
let searchParams = new URLSearchParams("category=advanced");

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/acme/settings",
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}));

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

afterEach(() => {
  cleanup();
  replace.mockClear();
  searchParams = new URLSearchParams("category=advanced");
  window.history.replaceState(null, "", "/w/acme/settings?category=advanced");
});

beforeEach(() => {
  replace.mockClear();
  searchParams = new URLSearchParams("category=advanced");
  window.history.replaceState(null, "", "/w/acme/settings?category=advanced");
});

describe("resolveSettingsHashRoute", () => {
  it("maps legacy aliases to their current category and anchor", () => {
    expect(resolveSettingsHashRoute("#coding-agent")).toEqual({
      anchor: "runtime",
      category: "integrations",
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
      category: "integrations",
    });
    expect(resolveSettingsHashRoute("#github")).toEqual({
      anchor: "github",
      category: "integrations",
    });
    expect(resolveSettingsHashRoute("#unknown")).toBeNull();
  });
});

describe("SettingsCategoryNav hash routing", () => {
  it("sticks below the safe-area-aware shell header", () => {
    const { container, getByRole } = render(
      <SettingsCategoryNav activeCategory="advanced" workspaceSlug="acme" />,
    );

    const nav = getByRole("navigation", { name: "Settings categories" });
    expect(nav.className).toContain("sticky");
    expect(nav.className).toContain("top-[calc(var(--shell-scroll-padding)+16px)]");
    expect(nav).toHaveClass("self-start");
    expect(container.querySelector("ul")).toHaveClass("grid", "grid-cols-2");
    expect(container.querySelector("ul")).not.toHaveClass("overflow-x-auto");
  });

  it("routes hash-only Open actions to the matching category", async () => {
    render(<SettingsCategoryNav activeCategory="advanced" workspaceSlug="acme" />);

    window.history.replaceState(null, "", "/w/acme/settings?category=advanced#github");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/w/acme/settings?category=integrations#github");
    });
  });

  it("rewrites legacy hashes to their current anchors", async () => {
    searchParams = new URLSearchParams("category=integrations");
    render(<SettingsCategoryNav activeCategory="integrations" workspaceSlug="acme" />);

    window.history.replaceState(null, "", "/w/acme/settings?category=integrations#coding-agent");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/w/acme/settings?category=integrations#runtime");
    });
  });

  it("does not navigate when the hash already matches the active category and anchor", async () => {
    window.history.replaceState(null, "", "/w/acme/settings?category=advanced#verify");
    render(<SettingsCategoryNav activeCategory="advanced" workspaceSlug="acme" />);

    await waitFor(() => {
      expect(replace).not.toHaveBeenCalled();
    });
  });
});
