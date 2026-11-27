// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShellHeader } from "@/components/app-shell/shell-header";
import {
  matchWorkspaceLocation,
  readFactoryRequest,
  resolveWorkspaceScope,
  workspaceScopeLocationKey,
  workspaceScopePreferenceKey,
} from "@/components/app-shell/workspace-location";
import {
  WorkspaceScopeHandoff,
  type WorkspaceScopeSnapshot,
} from "@/components/app-shell/workspace-scope-context";
import { OverlayProvider } from "@/components/ui/overlay-provider";
import {
  AgentDirectoryDraftScope,
  AgentDirectoryFactorySelector,
  useDirectoryDraftStatus,
} from "@/features/factory-agents/agent-directory-draft";
import { FactoryDefinitionSwitch } from "@/features/factory-definition/factory-definition-switch";
import { ScorerDraftGuard } from "@/features/factory-scorers/scorer-draft-guard";
import { ScorerFactorySelector } from "@/features/factory-scorers/scorer-factory-selector";
import { ScorerForm } from "@/features/factory-scorers/scorer-form";
import { FactorySelector } from "@/features/factories/factory-selector";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import type { ReactNode } from "react";

const router = vi.hoisted(() => ({
  path: "",
  query: new URLSearchParams(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => router.path,
  useSearchParams: () => router.query,
  useRouter: () => ({ push: router.push }),
}));

const account = "person-a";
const workspace = { id: "workspace-a", slug: "tandem", name: "Tandem tools" };
const platform = {
  id: "platform",
  name: "Platform",
  isDefault: true,
  status: "active",
  canManage: true,
} satisfies FactorySelectionOption;
const mobile = {
  id: "mobile",
  name: "Mobile app",
  isDefault: false,
  status: "active",
  canManage: true,
} satisfies FactorySelectionOption;
const factories = [platform, mobile];

function receipt(
  options: FactorySelectionOption[] = factories,
  factoryId?: string,
): WorkspaceScopeSnapshot {
  const location = matchWorkspaceLocation(router.path, workspace.slug);
  const requested = readFactoryRequest(router.query);
  return {
    factories: options,
    locationKey: workspaceScopeLocationKey(router.path, location?.detail ? undefined : requested),
    picker: location?.detail ? "locked" : "header",
    resetParams: ["revision"],
    scope: resolveWorkspaceScope(location, options, requested, factoryId),
    viewerId: account,
    workspaceId: workspace.id,
  };
}

function shell({
  children,
  snapshot,
  options = factories,
  viewerId = account,
}: {
  children?: ReactNode;
  snapshot?: WorkspaceScopeSnapshot;
  options?: FactorySelectionOption[];
  viewerId?: string;
} = {}) {
  return (
    <OverlayProvider>
      <ShellHeader
        factories={options}
        onboarding={null}
        viewerAvatarUrl={null}
        viewerEmail={null}
        viewerId={viewerId}
        workspace={workspace}
        workspaceAvatarUrl={null}
      >
        {snapshot ? <WorkspaceScopeHandoff snapshot={snapshot} /> : null}
        {children ?? <FactorySelector factories={options} selectedValue={mobile.id} />}
      </ShellHeader>
    </OverlayProvider>
  );
}

const header = () => within(screen.getByRole("banner"));
const navigation = () => within(screen.getByRole("navigation", { name: "Workspace navigation" }));

function AgentDraft() {
  useDirectoryDraftStatus(true);
  return <AgentDirectoryFactorySelector factories={factories} selectedValue={mobile.id} />;
}

describe("scoped application shell", () => {
  beforeEach(() => {
    router.path = "/w/tandem/sessions";
    router.query = new URLSearchParams("factory=mobile");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    router.push.mockClear();
  });

  it("promotes one mounted, authorized selector and keeps the previous leaf control before promotion", async () => {
    const view = render(shell());
    expect(header().queryByRole("combobox", { name: "Factory" })).toBeNull();
    expect(navigation().getByRole("link", { name: "Inbox" })).toHaveAttribute(
      "href",
      "/w/tandem/inbox",
    );
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("combobox", { name: "Factory" }),
    );
    view.rerender(shell({ snapshot: receipt() }));
    expect(await header().findByRole("combobox", { name: "Factory" })).toHaveTextContent(
      "Mobile app",
    );
    expect(
      within(screen.getByRole("main")).queryByRole("combobox", { name: "Factory" }),
    ).toBeNull();
    expect(navigation().getAllByRole("link")).toHaveLength(6);
    expect(navigation().getByRole("link", { name: "Inbox" })).toHaveAttribute(
      "href",
      "/w/tandem/inbox?factory=mobile",
    );
    expect(header().getByRole("button", { name: "New session" })).toBeInTheDocument();
  });

  it("updates the addressed scope without replacing history or retaining factory-bound filters", async () => {
    router.query = new URLSearchParams("factory=mobile&q=offline&cursor=old&revision=2");
    render(shell({ snapshot: receipt() }));
    fireEvent.click(await header().findByRole("combobox", { name: "Factory" }));
    expect(screen.getByRole("option", { name: "All factories" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Platform" }));
    expect(router.push).toHaveBeenCalledWith("/w/tandem/sessions?factory=platform&q=offline", {
      scroll: false,
    });
  });

  it("ignores receipts from a previous URL or another signed-in account", async () => {
    const previous = receipt();
    const view = render(shell({ snapshot: previous }));
    await header().findByRole("combobox", { name: "Factory" });
    router.query = new URLSearchParams("factory=platform");
    view.rerender(shell({ snapshot: previous }));
    expect(header().queryByRole("combobox", { name: "Factory" })).toBeNull();
    view.rerender(shell({ snapshot: receipt(), viewerId: "person-b" }));
    expect(header().queryByRole("combobox", { name: "Factory" })).toBeNull();
    expect(header().queryByRole("button", { name: "New session" })).toBeNull();
  });

  it("shows the actual review factory without retargeting the action, even with an All inbox return", async () => {
    router.path = "/w/tandem/sessions/112";
    router.query = new URLSearchParams({
      factory: platform.id,
      returnTo: "/w/tandem/inbox?factory=all&kind=review&cursor=older",
    });
    render(shell({ snapshot: receipt(factories, mobile.id) }));
    expect(await header().findByText("Mobile app")).toBeInTheDocument();
    expect(header().queryByRole("combobox", { name: "Factory" })).toBeNull();
    expect(header().queryByRole("button", { name: "New session" })).toBeNull();
    expect(navigation().getByRole("link", { name: "Inbox" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(navigation().getByRole("link", { name: "Inbox" })).toHaveAttribute(
      "href",
      "/w/tandem/inbox?factory=all&kind=review&cursor=older",
    );
  });

  it("provides no redundant selector when only one factory is accessible", () => {
    router.query = new URLSearchParams();
    render(shell({ options: [mobile], snapshot: receipt([mobile]) }));
    expect(screen.queryByRole("combobox", { name: "Factory" })).toBeNull();
    expect(navigation().getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/w/tandem/settings",
    );
  });

  it("keeps All read-only when none of its factories can receive a session", () => {
    router.query = new URLSearchParams("factory=all&create=1");
    const archived: FactorySelectionOption[] = [{ ...mobile, status: "archived" }];
    render(shell({ options: archived, snapshot: receipt(archived) }));
    expect(header().getByRole("combobox", { name: "Factory" })).toHaveTextContent("All factories");
    expect(header().queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Start a new session" })).toBeNull();
  });

  it("offers a factory-only picker with no All option", async () => {
    router.path = "/w/tandem/analytics";
    router.query = new URLSearchParams("factory=all");
    render(shell({ snapshot: receipt() }));
    const chooser = await header().findByRole("combobox", { name: "Factory" });
    expect(chooser).toHaveTextContent("Choose factory");
    fireEvent.click(chooser);
    expect(screen.getByRole("option", { name: "Mobile app" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "All factories" })).toBeNull();
  });

  it.each([
    {
      page: "agents",
      search: "q=keep-until-discard&new=1",
      cancel: "Cancel",
      discard: "Discard and switch",
      guard: (
        <AgentDirectoryDraftScope>
          <AgentDraft />
        </AgentDirectoryDraftScope>
      ),
    },
    {
      page: "scorers",
      search: "q=keep-until-discard&preset=blank&revision=old",
      cancel: "Keep editing",
      discard: "Discard changes",
      guard: (
        <ScorerDraftGuard>
          <ScorerFactorySelector factories={factories} selectedValue={mobile.id} />
          <ScorerForm
            draft={{ kind: "create" }}
            factoryId={mobile.id}
            factoryLabel={mobile.name}
            workspaceId={workspace.id}
            workspaceSlug={workspace.slug}
          />
        </ScorerDraftGuard>
      ),
    },
    {
      page: "settings/factory-definition",
      search: "revision=old",
      cancel: "Stay",
      discard: "Discard and switch",
      guard: (
        <FactoryDefinitionSwitch
          dirty
          disabled={false}
          onDiscard={() => undefined}
          selection={{ factories, resetParams: ["revision"], selectedValue: mobile.id }}
        />
      ),
    },
  ])("reuses the $page guard and restores focus to the header picker", async (scenario) => {
    router.path = `/w/tandem/${scenario.page}`;
    router.query = new URLSearchParams(`factory=mobile&${scenario.search}`);
    render(shell({ children: scenario.guard, snapshot: { ...receipt(), picker: "guarded" } }));
    if (scenario.page === "scorers") {
      fireEvent.change(screen.getByLabelText("Rubric"), { target: { value: "Keep this edit" } });
    }
    const trigger = await header().findByRole("combobox", { name: "Factory" });
    expect(
      within(screen.getByRole("main")).queryByRole("combobox", { name: "Factory" }),
    ).toBeNull();
    function choose() {
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("option", { name: /^Platform/ }));
    }
    choose();
    const cancel = await screen.findByRole("button", { name: scenario.cancel });
    expect(router.push).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(router.push).not.toHaveBeenCalled();
    choose();
    fireEvent.click(await screen.findByRole("button", { name: scenario.discard }));
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/w/tandem/${scenario.page}?factory=platform`,
      { scroll: false },
    );
  });

  it("keeps Settings global and only forwards an account- and workspace-keyed preference", () => {
    router.path = "/w/tandem/settings";
    router.query = new URLSearchParams("section=team");
    window.localStorage.setItem(workspaceScopePreferenceKey(account, workspace.id), mobile.id);
    window.localStorage.setItem(workspaceScopePreferenceKey("other", workspace.id), platform.id);
    render(shell());
    expect(header().queryByRole("combobox", { name: "Factory" })).toBeNull();
    expect(navigation().getByRole("link", { name: "Inbox" })).toHaveAttribute(
      "href",
      "/w/tandem/inbox?lastFactory=mobile",
    );
    expect(navigation().getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/w/tandem/settings",
    );
  });
});
