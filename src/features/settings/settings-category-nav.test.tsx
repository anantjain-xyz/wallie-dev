// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveSettingsHashRoute,
  SettingsCategoryNav,
} from "@/features/settings/settings-category-nav";
import { SETTINGS_CATEGORY_LINKS } from "@/features/settings/settings-categories";

const replace = vi.fn();
const router = { replace };
let searchParams = new URLSearchParams("category=advanced");

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/acme/settings",
  useRouter: () => router,
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
      category: "integrations",
    });
    expect(resolveSettingsHashRoute("#linear-routing")).toEqual({
      anchor: "linear",
      category: "integrations",
    });
    expect(resolveSettingsHashRoute("#secrets")).toEqual({
      anchor: "workspace-secrets",
      category: "integrations",
    });
    expect(resolveSettingsHashRoute("#github")).toEqual({
      anchor: "github",
      category: "integrations",
    });
    expect(resolveSettingsHashRoute("#maintenance")).toEqual({
      anchor: "maintenance",
      category: "advanced",
    });
    expect(resolveSettingsHashRoute("#vercel")).toEqual({
      anchor: "sandbox",
      category: "integrations",
    });
    expect(resolveSettingsHashRoute("#unknown")).toBeNull();
    expect(resolveSettingsHashRoute("#toString")).toBeNull();
  });
});

describe("SettingsCategoryNav hash routing", () => {
  it("orders the major categories with Advanced last and uses the requested subtitle", () => {
    expect(SETTINGS_CATEGORY_LINKS.map((category) => category.id)).toEqual([
      "integrations",
      "workspace",
      "advanced",
    ]);
    expect(SETTINGS_CATEGORY_LINKS.at(-1)?.description).toContain("maintenance");
  });

  it("sticks below the shell header on desktop without covering mobile anchors", () => {
    const { container, getByRole } = render(
      <SettingsCategoryNav activeCategory="advanced" canManage workspaceSlug="acme" />,
    );

    const nav = getByRole("navigation", { name: "Settings categories" });
    expect(nav).not.toHaveClass("sticky");
    expect(nav.className).toContain("lg:sticky");
    expect(nav.className).toContain("lg:top-[calc(var(--shell-scroll-padding)+16px)]");
    expect(nav).toHaveClass("self-start");
    expect(container.querySelector("ul")).toHaveClass("grid", "grid-cols-3");
    expect(container.querySelector("ul")).not.toHaveClass("overflow-x-auto");
  });

  it("keeps links in one desktop submenu that opens on demand on mobile", () => {
    searchParams = new URLSearchParams("category=integrations");
    const { getByRole } = render(
      <SettingsCategoryNav activeCategory="integrations" canManage workspaceSlug="acme" />,
    );

    const links = [
      ["GitHub", "#github"],
      ["Repositories", "#repository"],
      ["Factory connectors", "#connector-resources"],
      ["Default factory", "#factory-configuration"],
      ["Pipeline", "#pipeline"],
      ["Linear", "#linear"],
      ["Sandbox connections", "#sandbox"],
      ["Workspace secrets", "#workspace-secrets"],
      ["Agent runtime", "#runtime"],
      ["Your provider access", "#provider-access"],
      ["Verify setup", "#verify"],
    ];
    for (const [name, href] of links) {
      expect(getByRole("link", { name })).toHaveAttribute("href", href);
    }
    const submenu = getByRole("link", { name: "GitHub" }).closest("ul");
    const jump = getByRole("button", { name: "Jump to a section" });
    expect(submenu).toHaveClass("hidden", "lg:block", "border-l");
    expect(jump).toHaveAttribute("aria-controls", submenu?.id);
    expect(jump).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(jump);
    expect(jump).toHaveAttribute("aria-expanded", "true");
    expect(submenu).not.toHaveClass("hidden");
  });

  it("highlights only the active subsection, not its parent category", async () => {
    searchParams = new URLSearchParams("category=workspace");
    window.history.replaceState(null, "", "/w/acme/settings?category=workspace#workspace");
    const { container } = render(
      <SettingsCategoryNav activeCategory="workspace" canManage workspaceSlug="acme" />,
    );

    const category = container.querySelector('a[href="/w/acme/settings?category=workspace"]');
    const subsection = container.querySelector('a[href="#workspace"]');

    expect(category).toHaveAttribute("aria-current", "page");
    expect(category).not.toHaveClass("settings-anchor-active");
    await waitFor(() => {
      expect(subsection).toHaveAttribute("aria-current", "location");
      expect(subsection).toHaveClass("settings-anchor-active");
    });
  });

  it.each([
    {
      category: "workspace" as const,
      links: [
        ["Workspace", "#workspace"],
        ["Team access", "#members"],
        ["Your profile", "#profile"],
        ["Danger zone", "#danger-zone"],
      ],
    },
    {
      category: "advanced" as const,
      links: [
        ["Usage", "#usage"],
        ["Retention and exports", "#run-history"],
        ["Maintenance", "#maintenance"],
        ["Rate limits", "#rate-limits"],
      ],
    },
  ])("renders the $category section links as a submenu", ({ category, links }) => {
    searchParams = new URLSearchParams(`category=${category}`);
    const { getByRole } = render(
      <SettingsCategoryNav activeCategory={category} canManage workspaceSlug="acme" />,
    );

    for (const [name, href] of links) {
      expect(getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("links ordinary members to personal connected clients in Workspace settings", () => {
    searchParams = new URLSearchParams("category=workspace");
    const { getByRole } = render(
      <SettingsCategoryNav activeCategory="workspace" canManage={false} workspaceSlug="acme" />,
    );
    expect(getByRole("link", { name: "Connected clients" })).toHaveAttribute(
      "href",
      "#connected-clients",
    );
    expect(resolveSettingsHashRoute("#connected-clients")).toEqual({
      anchor: "connected-clients",
      category: "workspace",
    });
  });

  it("hides retention and maintenance links for ordinary members", () => {
    searchParams = new URLSearchParams("category=advanced");
    const { queryByRole } = render(
      <SettingsCategoryNav activeCategory="advanced" canManage={false} workspaceSlug="acme" />,
    );

    expect(queryByRole("link", { name: "Maintenance" })).toBeNull();
    expect(queryByRole("link", { name: "Retention and exports" })).toBeNull();
  });

  it.each(["maintenance", "run-history"])("does not route non-managers to %s", async (anchor) => {
    searchParams = new URLSearchParams("category=integrations");
    render(
      <SettingsCategoryNav activeCategory="integrations" canManage={false} workspaceSlug="acme" />,
    );

    window.history.replaceState(null, "", `/w/acme/settings?category=integrations#${anchor}`);
    act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));

    await waitFor(() => {
      expect(replace).not.toHaveBeenCalled();
    });
  });

  it("scrolls to the shared Maintenance section heading for managers", async () => {
    searchParams = new URLSearchParams("category=advanced");
    window.history.replaceState(null, "", "/w/acme/settings?category=advanced#maintenance");
    render(<SettingsCategoryNav activeCategory="advanced" canManage workspaceSlug="acme" />);

    const target = document.createElement("section");
    target.id = "maintenance";
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(document.querySelector('a[href="#maintenance"]')).toHaveAttribute(
      "aria-current",
      "location",
    );
    target.remove();
  });

  it("focuses and scrolls to the real heading when a suspended section mounts", async () => {
    searchParams = new URLSearchParams("category=integrations");
    window.history.replaceState(null, "", "/w/acme/settings?category=integrations#pipeline");
    render(<SettingsCategoryNav activeCategory="integrations" canManage workspaceSlug="acme" />);

    const target = document.createElement("section");
    target.id = "pipeline";
    target.scrollIntoView = vi.fn();
    target.innerHTML = '<h3 data-settings-heading tabindex="-1">Pipeline</h3>';
    document.body.appendChild(target);

    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(target.querySelector("h3")).toHaveFocus();
    target.remove();
  });

  it("routes hash-only Open actions to the matching category", async () => {
    render(<SettingsCategoryNav activeCategory="advanced" canManage workspaceSlug="acme" />);

    window.history.replaceState(null, "", "/w/acme/settings?category=advanced#github");
    act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/w/acme/settings?category=integrations#github", {
        scroll: false,
      });
    });
  });

  it("rewrites legacy hashes to their current anchors", async () => {
    searchParams = new URLSearchParams(
      "category=integrations&factory=support&codex_connect=success",
    );
    render(<SettingsCategoryNav activeCategory="integrations" canManage workspaceSlug="acme" />);

    window.history.replaceState(null, "", "/w/acme/settings?category=integrations#coding-agent");
    act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/w/acme/settings?category=integrations&factory=support&codex_connect=success#runtime",
        { scroll: false },
      );
    });
  });

  it("does not navigate when the hash already matches the active category and anchor", async () => {
    window.history.replaceState(null, "", "/w/acme/settings?category=integrations#verify");
    render(<SettingsCategoryNav activeCategory="integrations" canManage workspaceSlug="acme" />);

    await waitFor(() => {
      expect(replace).not.toHaveBeenCalled();
    });
  });
});
