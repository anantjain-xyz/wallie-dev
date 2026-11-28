// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FactoryManagementNavigation,
  useFactoryManagementGuard,
} from "@/features/settings/islands/factory-management-navigation";
import {
  resolveSettingsHashRoute,
  SettingsCategoryNav,
} from "@/features/settings/settings-category-nav";
import type { SettingsCategory } from "@/features/settings/settings-categories";
import {
  PersonalSettingsNavigation,
  useBlockPersonalSettings,
} from "@/features/settings/personal-settings-navigation";

const replace = vi.fn();
const navigate = vi.fn();
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
    onNavigate,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    onNavigate?: (event: { preventDefault: () => void }) => void;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        onNavigate?.({ preventDefault: () => event.preventDefault() });
        if (!event.defaultPrevented) navigate(href);
        event.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  replace.mockClear();
  navigate.mockClear();
  searchParams = new URLSearchParams("category=advanced");
  window.history.replaceState(null, "", "/w/acme/settings?category=advanced");
});

beforeEach(() => {
  replace.mockClear();
  searchParams = new URLSearchParams("category=advanced");
  window.history.replaceState(null, "", "/w/acme/settings?category=advanced");
});

describe("resolveSettingsHashRoute", () => {
  it("resolves a closed factory row in Workspace Settings", () => {
    const anchor = "factory-row-00000000-0000-4000-8000-000000000001";
    expect(resolveSettingsHashRoute(`#${anchor}`)).toEqual({ anchor, category: "workspace" });
    expect(resolveSettingsHashRoute("#factory-row-invalid")).toBeNull();
  });

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

function FactoryEditorGuard({ busy, dirty }: { busy: boolean; dirty: boolean }) {
  useFactoryManagementGuard(dirty, busy);
  return null;
}

function NavWithSections({
  category,
  canManage = true,
  sections,
  hidden = false,
}: {
  category: SettingsCategory;
  canManage?: boolean;
  sections: readonly string[];
  hidden?: boolean;
}) {
  return (
    <>
      <SettingsCategoryNav activeCategory={category} canManage={canManage} workspaceSlug="acme" />
      <div hidden={hidden} id="settings-sections">
        {sections.map((id) => (
          <section id={id} key={id} />
        ))}
      </div>
    </>
  );
}

describe("SettingsCategoryNav hash routing", () => {
  it("keeps the labeled navigation and four peer categories without a visible caption", () => {
    const { getByRole, queryByText } = render(
      <SettingsCategoryNav activeCategory="advanced" canManage workspaceSlug="acme" />,
    );
    const nav = within(getByRole("navigation", { name: "Settings categories" }));
    expect(queryByText("Workspace settings", { exact: true })).not.toBeInTheDocument();
    expect(nav.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Integrations",
      "Workspace",
      "Usage & retention",
      "Personal",
    ]);
    expect(nav.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(
      ["integrations", "workspace", "advanced", "personal"].map(
        (category) => `/w/acme/settings?category=${category}`,
      ),
    );
  });

  it("keeps Personal blocked until every independent draft blocker clears", () => {
    function Editor({ dirty }: { dirty: boolean }) {
      useBlockPersonalSettings(dirty);
      return null;
    }

    function Example({ agent, policy }: { agent: boolean; policy: boolean }) {
      return (
        <PersonalSettingsNavigation>
          <Editor dirty={agent} />
          <Editor dirty={policy} />
          <SettingsCategoryNav activeCategory="integrations" canManage workspaceSlug="acme" />
        </PersonalSettingsNavigation>
      );
    }

    const { getByRole, queryByRole, rerender } = render(<Example agent policy />);
    const personal = getByRole("link", { name: "Personal" });
    fireEvent.click(personal);
    expect(getByRole("status")).toHaveTextContent("Save or discard your changes");
    expect(navigate).not.toHaveBeenCalled();

    rerender(<Example agent={false} policy />);
    fireEvent.click(personal);
    expect(navigate).not.toHaveBeenCalled();

    rerender(<Example agent={false} policy={false} />);
    expect(queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(personal);
    expect(navigate).toHaveBeenCalledWith("/w/acme/settings?category=personal");
  });

  it("guards category links that would remove the factory editor", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    searchParams = new URLSearchParams(`category=workspace&manageFactory=${id}`);
    window.history.replaceState(null, "", `/w/acme/settings?${searchParams}#factory-management`);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    function example(busy: boolean) {
      return (
        <FactoryManagementNavigation>
          <FactoryEditorGuard busy={busy} dirty />
          <SettingsCategoryNav activeCategory="workspace" canManage workspaceSlug="acme" />
        </FactoryManagementNavigation>
      );
    }
    const { getByRole, rerender } = render(example(false));
    const usage = getByRole("link", { name: "Usage & retention" });
    fireEvent.click(usage);
    fireEvent.click(getByRole("link", { name: /^Workspace$/ }));
    fireEvent.click(getByRole("link", { name: "Personal" }));
    expect(navigate).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenLastCalledWith("Discard unsaved changes to this factory?");
    expect(confirm).toHaveBeenCalledTimes(3);

    rerender(example(true));
    expect(usage).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(usage);
    expect(navigate).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(3);

    rerender(example(false));
    confirm.mockReturnValue(true);
    fireEvent.click(usage);
    expect(navigate).toHaveBeenCalledWith("/w/acme/settings?category=advanced");
  });

  it("keeps the editor URL when a cross-category hash change is declined", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    searchParams = new URLSearchParams(`category=workspace&manageFactory=${id}`);
    const editorPath = `/w/acme/settings?${searchParams}`;
    window.history.replaceState(null, "", `${editorPath}#factory-management`);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <FactoryManagementNavigation>
        <FactoryEditorGuard busy={false} dirty />
        <SettingsCategoryNav activeCategory="workspace" canManage workspaceSlug="acme" />
      </FactoryManagementNavigation>,
    );

    window.history.replaceState(null, "", `${editorPath}#github`);
    act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe(
      `${editorPath}#factory-management`,
    );
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
    const { getByRole } = render(<NavWithSections category="integrations" sections={["github"]} />);

    const submenu = getByRole("link", { name: "GitHub" }).closest("ul");
    const jump = getByRole("button", { name: "Jump to a section" });
    expect(submenu).toHaveClass("hidden", "lg:block", "border-l");
    expect(jump).toHaveAttribute("aria-controls", submenu?.id);
    expect(jump).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(jump);
    expect(jump).toHaveAttribute("aria-expanded", "true");
    expect(submenu).not.toHaveClass("hidden");
  });

  it("distinguishes the current location from its parent category", async () => {
    searchParams = new URLSearchParams("category=workspace");
    window.history.replaceState(null, "", "/w/acme/settings?category=workspace#workspace");
    const { container } = render(<NavWithSections category="workspace" sections={["workspace"]} />);

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
      category: "integrations" as const,
      parent: "Integrations",
      links: [
        ["GitHub", "github"],
        ["Repositories", "repository"],
        ["Linear", "linear"],
        ["Sandbox connections", "sandbox"],
        ["Workspace secrets", "workspace-secrets"],
        ["Factory connectors", "connector-resources"],
        ["Default factory", "factory-configuration"],
        ["Pipeline", "pipeline"],
        ["Agent runtime", "runtime"],
        ["Verify setup", "verify"],
      ],
    },
    {
      category: "workspace" as const,
      parent: "Workspace",
      links: [
        ["General", "workspace"],
        ["Factories", "factories"],
        ["Members", "members"],
        ["OAuth clients", "oauth-clients"],
        ["OAuth connections", "workspace-oauth-connections"],
        ["Danger zone", "danger-zone"],
      ],
    },
    {
      category: "advanced" as const,
      parent: "Usage & retention",
      links: [
        ["Usage", "usage"],
        ["Retention and exports", "run-history"],
        ["Maintenance", "maintenance"],
        ["Rate limits", "rate-limits"],
      ],
    },
    {
      category: "personal" as const,
      parent: "Personal",
      links: [
        ["Profile", "profile"],
        ["Provider access", "provider-access"],
        ["Connected clients", "connected-clients"],
      ],
    },
  ])("nests only the $category outline inside its active parent", ({ category, parent, links }) => {
    searchParams = new URLSearchParams(`category=${category}`);
    const { getByRole } = render(
      <NavWithSections category={category} sections={links.map(([, id]) => id)} />,
    );
    const nav = within(getByRole("navigation", { name: "Settings categories" }));
    const activeLink = nav.getByRole("link", { name: parent });
    expect(activeLink).toHaveAttribute("aria-current", "page");
    const item = activeLink.closest("li")!;
    const submenu = within(item).getByRole("list");
    expect(submenu.parentElement?.closest("li")).toBe(item);
    expect(nav.getAllByRole("list")).toHaveLength(2);
    expect(within(item).getByRole("button", { name: "Jump to a section" })).toHaveAttribute(
      "aria-controls",
      submenu.id,
    );

    const children = within(submenu).getAllByRole("link");
    expect(children.map((link) => link.textContent)).toEqual(links.map(([name]) => name));
    expect(children.map((link) => link.getAttribute("href"))).toEqual(
      links.map(([, id]) => `#${id}`),
    );
    for (const sibling of item.parentElement!.children) {
      if (sibling !== item) expect(sibling.querySelector("ul")).toBeNull();
    }
  });

  it("omits an empty outline and tracks sections as they mount, hide, and disappear", async () => {
    searchParams = new URLSearchParams("category=personal");
    const { getByRole, rerender } = render(<NavWithSections category="personal" sections={[]} />);
    const nav = within(getByRole("navigation", { name: "Settings categories" }));
    const jump = () => nav.queryByRole("button", { name: "Jump to a section" });

    expect(jump()).not.toBeInTheDocument();
    expect(nav.getAllByRole("list")).toHaveLength(1);

    rerender(<NavWithSections category="personal" sections={["profile", "unexpected"]} />);
    const profile = await nav.findByRole("link", { name: "Profile" });
    expect(profile).toHaveAttribute("href", "#profile");
    expect(nav.queryByRole("link", { name: "Provider access" })).not.toBeInTheDocument();
    expect(jump()).toBeInTheDocument();

    rerender(<NavWithSections category="personal" hidden sections={["profile"]} />);
    await waitFor(() => expect(jump()).not.toBeInTheDocument());

    rerender(<NavWithSections category="personal" sections={["connected-clients"]} />);
    await expect(nav.findByRole("link", { name: "Connected clients" })).resolves.toHaveAttribute(
      "href",
      "#connected-clients",
    );
    expect(profile).not.toBeInTheDocument();

    rerender(<NavWithSections category="personal" sections={[]} />);
    await waitFor(() => expect(nav.getAllByRole("list")).toHaveLength(1));
  });

  it("retargets legacy personal links and hides workspace OAuth actions from members", () => {
    searchParams = new URLSearchParams("category=workspace");
    const { getByRole, queryByRole } = render(
      <NavWithSections
        canManage={false}
        category="workspace"
        sections={["factories", "oauth-clients", "workspace-oauth-connections"]}
      />,
    );
    expect(getByRole("link", { name: "Factories" })).toHaveAttribute("href", "#factories");
    expect(queryByRole("link", { name: "OAuth clients" })).toBeNull();
    expect(queryByRole("link", { name: "OAuth connections" })).toBeNull();
    expect(queryByRole("link", { name: "Connected clients" })).toBeNull();
    expect(resolveSettingsHashRoute("#connected-clients")).toEqual({
      anchor: "connected-clients",
      category: "personal",
    });
    expect(resolveSettingsHashRoute("#provider-access")).toEqual({
      anchor: "provider-access",
      category: "personal",
    });
    expect(resolveSettingsHashRoute("#profile")).toEqual({
      anchor: "profile",
      category: "personal",
    });
  });

  it("hides retention and maintenance links for ordinary members", () => {
    searchParams = new URLSearchParams("category=advanced");
    const { getByRole, queryByRole } = render(
      <NavWithSections
        canManage={false}
        category="advanced"
        sections={["usage", "run-history", "maintenance"]}
      />,
    );

    expect(getByRole("link", { name: "Usage" })).toHaveAttribute("href", "#usage");
    expect(queryByRole("link", { name: "Maintenance" })).toBeNull();
    expect(queryByRole("link", { name: "Retention and exports" })).toBeNull();
  });

  it.each(["maintenance", "run-history", "oauth-clients", "workspace-oauth-connections"])(
    "does not route non-managers to %s",
    async (anchor) => {
      searchParams = new URLSearchParams("category=integrations");
      render(
        <SettingsCategoryNav
          activeCategory="integrations"
          canManage={false}
          workspaceSlug="acme"
        />,
      );

      window.history.replaceState(null, "", `/w/acme/settings?category=integrations#${anchor}`);
      act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));

      await waitFor(() => {
        expect(replace).not.toHaveBeenCalled();
      });
    },
  );

  it("scrolls to the shared Maintenance section heading for managers", async () => {
    searchParams = new URLSearchParams("category=advanced");
    window.history.replaceState(null, "", "/w/acme/settings?category=advanced#maintenance");
    render(<SettingsCategoryNav activeCategory="advanced" canManage workspaceSlug="acme" />);

    const target = document.createElement("section");
    target.id = "maintenance";
    target.scrollIntoView = vi.fn();
    await act(async () => {
      document.body.appendChild(target);
    });

    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(document.querySelector('a[href="#maintenance"]')).toHaveAttribute(
      "aria-current",
      "location",
    );
    await act(async () => {
      target.remove();
    });
  });

  it("focuses and scrolls to the real heading when a suspended section mounts", async () => {
    searchParams = new URLSearchParams("category=integrations");
    window.history.replaceState(null, "", "/w/acme/settings?category=integrations#pipeline");
    render(<SettingsCategoryNav activeCategory="integrations" canManage workspaceSlug="acme" />);

    const target = document.createElement("section");
    target.id = "pipeline";
    target.scrollIntoView = vi.fn();
    target.innerHTML = '<h3 data-settings-heading tabindex="-1">Pipeline</h3>';
    await act(async () => {
      document.body.appendChild(target);
    });

    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(target.querySelector("h3")).toHaveFocus();
    await act(async () => {
      target.remove();
    });
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
