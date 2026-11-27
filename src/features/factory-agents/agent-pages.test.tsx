// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AgentPage from "@/app/w/[workspaceSlug]/(app)/agents/[agentId]/page";
import AgentNotFound from "@/app/w/[workspaceSlug]/(app)/agents/[agentId]/not-found";
import AgentsPage from "@/app/w/[workspaceSlug]/(app)/agents/page";
import { OverlayProvider } from "@/components/ui/overlay-provider";

const loaders = vi.hoisted(() => ({
  loadAgentPageScope: vi.fn(),
  loadAgentsList: vi.fn(),
  loadAgentDetail: vi.fn(),
  push: vi.fn(),
  search: new URLSearchParams(),
}));
vi.mock("./agent-pages-data", () => loaders);
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  useParams: () => ({ workspaceSlug: "release" }),
  usePathname: () => "/w/release/agents",
  useRouter: () => ({ push: loaders.push }),
  useSearchParams: () => loaders.search,
}));
vi.mock("@/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/toast")>()),
  useToast: () => ({ pushToast: vi.fn() }),
}));

const factory = {
  id: "55200000-0000-4000-8000-000000000001",
  name: "Release factory",
  status: "active",
};
const agent = {
  id: "55200000-0000-4000-8000-000000000002",
  name: "Release agent",
  slug: "release-agent",
  is_default: true,
};
const publishedPrompt = {
  id: "55200000-0000-4000-8000-000000000003",
  revision_number: 1,
  prompt_md: "Published text",
  created_at: "2026-11-14T00:00:00Z",
};
const latest = {
  id: "55200000-0000-4000-8000-000000000004",
  revision_number: 2,
  prompt_md: "Draft candidate",
  created_at: "2026-11-15T00:00:00Z",
};
const after = "55200000-0000-4000-8000-000000000005";
const grantId = "55200000-0000-4000-8000-000000000006";
const definitionId = "55200000-0000-4000-8000-000000000007";
const profile = {
  provider: "codex",
  model: "gpt-5.6-sol",
  sandboxProvider: "vercel",
  effort: null,
  maxTurns: null,
  unavailableReason: "The configured model is not supported.",
  credentialAuthority: { kind: "service", grantId, grantVersion: 3 },
};
const bindings = {
  revisionId: definitionId,
  profile,
  grant: null,
  repositories: { writable: [{ id: "repo", name: "fixtures/release" }], context: [] },
  skills: [],
  tools: [
    {
      serverId: "example-tool",
      serverSlug: "release-tool",
      revisionNumber: 1,
      operations: ["review"],
    },
  ],
};
const detail = {
  agent,
  bindings,
  hasPublishedDefinition: true,
  publishedPrompt,
  latest,
  selected: latest,
  revisions: [latest, publishedPrompt],
  nextBeforeRevisionNumber: null,
};
const query = { factory: factory.id, q: "Release", after };
const scope = { factory, workspaceId: "workspace", canEditPrompt: false, canEditDefinition: false };

beforeEach(() => {
  vi.resetAllMocks();
  loaders.search = new URLSearchParams(query);
  loaders.loadAgentPageScope.mockResolvedValue({ scope, factories: [factory] });
  loaders.loadAgentDetail.mockResolvedValue(detail);
  loaders.loadAgentsList.mockResolvedValue({
    agents: [agent],
    implementationAgentId: agent.id,
    nextAfterId: agent.id,
  });
});
afterEach(cleanup);

function readDirectory(
  searchParams: { factory: string; q?: string; after?: string; new?: string } = query,
) {
  return AgentsPage({
    params: Promise.resolve({ workspaceSlug: "release" }),
    searchParams: Promise.resolve(searchParams),
  });
}

function readDetail() {
  return AgentPage({
    params: Promise.resolve({ workspaceSlug: "release", agentId: agent.id }),
    searchParams: Promise.resolve({ ...query, revision: latest.id }),
  });
}

it("names both directory roles and preserves the scoped search through pagination and details", async () => {
  render(await readDirectory());
  const directory = within(screen.getByRole("region", { name: "Factory agents" }));
  expect(directory.getByRole("searchbox", { name: "Search agents by name or slug" })).toHaveValue(
    "Release",
  );
  expect(directory.getByText("Factory default")).toBeVisible();
  expect(directory.getByText("Used by published definition")).toBeVisible();
  expect(directory.getByRole("link", { name: agent.name })).toHaveAttribute(
    "href",
    `/w/release/agents/${agent.id}?factory=${factory.id}&q=Release&after=${after}`,
  );
  expect(directory.getByRole("link", { name: "More agents" })).toHaveAttribute(
    "href",
    `/w/release/agents?factory=${factory.id}&q=Release&after=${agent.id}`,
  );
  expect(loaders.loadAgentsList).toHaveBeenCalledWith(scope, { search: "Release", afterId: after });
  expect(screen.queryByRole("link", { name: "New agent" })).not.toBeInTheDocument();
});

it.each([false, true])(
  "offers one creation link and no inline form (populated: %s)",
  async (populated) => {
    loaders.loadAgentPageScope.mockResolvedValueOnce({
      scope: { ...scope, canEditPrompt: true },
      factories: [factory],
    });
    loaders.loadAgentsList.mockResolvedValueOnce({ agents: populated ? [agent] : [] });
    render(await readDirectory({ factory: factory.id }));
    const newAgent = screen.getByRole("link", { name: "New agent" });
    expect(newAgent).toHaveAttribute(
      "href",
      `/w/release/agents?factory=${factory.id}&new=1#new-agent`,
    );
    expect(screen.queryByRole("textbox", { name: "Agent name" })).not.toBeInTheDocument();
    if (populated) {
      expect(screen.getByRole("link", { name: agent.name })).toBeVisible();
      expect(newAgent.closest("header")).not.toBeNull();
    } else {
      expect(screen.getByText("No agents in this factory yet.")).toBeVisible();
      expect(within(screen.getByRole("region", { name: "Factory agents" })).getByRole("link")).toBe(
        newAgent,
      );
    }
  },
);

it("does not render the creation form on a direct request from a reader", async () => {
  render(await readDirectory({ factory: factory.id, new: "1" }));
  expect(screen.queryByRole("link", { name: "New agent" })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Agent name" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: agent.name })).toBeVisible();
});

it("keeps an exact draft and factory on Cancel, then switches once on Discard", async () => {
  const user = userEvent.setup();
  const selected = { ...factory, isDefault: true };
  const other = {
    ...factory,
    id: "55200000-0000-4000-8000-000000000008",
    name: "Research factory",
    isDefault: false,
  };
  loaders.loadAgentPageScope.mockResolvedValueOnce({
    scope: { ...scope, factory: selected, canEditPrompt: true },
    factories: [selected, other],
  });
  const authoring = { ...query, new: "1" };
  loaders.search = new URLSearchParams(authoring);
  render(<OverlayProvider>{await readDirectory(authoring)}</OverlayProvider>);
  expect(loaders.loadAgentsList).not.toHaveBeenCalled();
  const name = screen.getByRole("textbox", { name: "Agent name" });
  const prompt = screen.getByRole("textbox", { name: "Implementation prompt" });
  await user.type(name, "Release review draft");
  const text = "Keep these instructions exactly.\n  Preserve indentation.";
  await user.type(prompt, text);
  const trigger = screen.getByRole("combobox", { name: "Factory" });
  const chooseOtherFactory = async () => {
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: other.name }));
    return screen.findByRole("alertdialog", { name: "Switch factories without saving?" });
  };

  const confirmation = await chooseOtherFactory();
  expect(confirmation).toHaveTextContent(other.name);
  await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(name).toHaveValue("Release review draft");
  expect(prompt).toHaveValue(text);
  expect(trigger).toHaveAttribute("data-value", factory.id);
  expect(loaders.push).not.toHaveBeenCalled();

  const discard = await chooseOtherFactory();
  await user.click(within(discard).getByRole("button", { name: "Discard and switch" }));
  expect(loaders.push).toHaveBeenCalledExactlyOnceWith(`/w/release/agents?factory=${other.id}`, {
    scroll: false,
  });
});

it("recovers locally from an inaccessible factory and from a stale or wrong-scope detail", async () => {
  loaders.loadAgentPageScope.mockResolvedValueOnce({
    scope: null,
    selection: "unavailable",
    factories: [factory],
  });
  const directory = render(await readDirectory());
  expect(screen.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
  expect(screen.getByRole("link", { name: factory.name })).toHaveAttribute(
    "href",
    `/w/release/agents?factory=${factory.id}`,
  );
  expect(loaders.loadAgentsList).not.toHaveBeenCalled();
  directory.unmount();

  loaders.loadAgentDetail.mockResolvedValueOnce(null);
  await expect(readDetail()).rejects.toThrow("Not found");
  render(<AgentNotFound />);
  expect(screen.getByRole("link", { name: "Back to agents" })).toHaveAttribute(
    "href",
    "/w/release/agents",
  );
});

it("shows readers the published and viewed revisions without implying readiness or exposing the grant ID", async () => {
  const { container } = render(await readDetail());
  expect(
    screen.getByText("Published: Revision 1 · Viewing: Revision 2 (saved only)"),
  ).toBeVisible();
  expect(screen.getByText("Published for new sessions · Revision 1")).toBeVisible();
  expect(screen.getByText(/Readiness not checked on this page.*workspace operator/)).toBeVisible();
  expect(screen.getByText(/Known configuration issue: The configured model/)).toBeVisible();
  expect(screen.getByText("Grant details unavailable · v3")).toBeVisible();
  expect(container).not.toHaveTextContent(grantId);
  expect(screen.queryByRole("link", { name: "Configure bindings" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Review readiness" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save prompt revision" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "← Agents" })).toHaveAttribute(
    "href",
    `/w/release/agents?factory=${factory.id}&q=Release&after=${after}`,
  );
  expect(screen.getByRole("link", { name: "Revision 1" }).getAttribute("href")).toContain(
    `revision=${publishedPrompt.id}#prompt-revision`,
  );
  expect(screen.getByText("Latest saved")).toBeVisible();
  expect(screen.getByText("Nov 15, 2026")).toBeVisible();
  const runs = new URL(
    screen.getByRole("link", { name: "View runs for this revision" }).getAttribute("href")!,
    "http://local.test",
  );
  expect(runs.pathname).toBe("/w/release/runs");
  expect(Object.fromEntries(runs.searchParams)).toEqual({
    factory: factory.id,
    agentId: agent.id,
    agentPromptRevisionId: latest.id,
  });
});

it("links operators to the exact definition and prompt and shows permitted reference names", async () => {
  loaders.loadAgentPageScope.mockResolvedValue({
    scope: {
      ...scope,
      factory: { ...factory, canManage: true },
      canEditPrompt: true,
      canEditDefinition: true,
    },
  });
  loaders.loadAgentDetail.mockResolvedValue({
    ...detail,
    bindings: {
      ...bindings,
      grant: {
        principal: "Release automation",
        repository: "fixtures/release",
        version: 3,
        status: "Expired",
      },
      tools: [{ ...bindings.tools[0], name: "Release tools" }],
    },
    selected: publishedPrompt,
  });
  render(await readDetail());
  expect(screen.getByText("Release automation · fixtures/release · Grant v3")).toBeVisible();
  expect(
    screen.getByText("Known configuration issue: The execution grant is expired."),
  ).toBeVisible();
  expect(screen.getByText("Release tools · v1")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "View grant in Governance" }).getAttribute("href"),
  ).toContain(`grant=${grantId}`);
  expect(screen.getByRole("link", { name: "Review readiness" }).getAttribute("href")).toContain(
    `revision=${definitionId}#execution-profile`,
  );
  expect(screen.getByRole("link", { name: "Configure bindings" }).getAttribute("href")).toContain(
    `implementationAgent=${publishedPrompt.id}`,
  );
  expect(screen.getByRole("textbox", { name: "Implementation prompt" })).toHaveValue(
    latest.prompt_md,
  );
});

it("distinguishes the legacy default from an agent outside an existing published definition", async () => {
  loaders.loadAgentDetail.mockResolvedValueOnce({
    ...detail,
    bindings: null,
    publishedPrompt: null,
    hasPublishedDefinition: false,
  });
  const legacy = render(await readDetail());
  expect(screen.getByText("No definition published")).toBeVisible();
  expect(screen.getByText(/Legacy execution.*initial prompt/)).toBeVisible();
  legacy.unmount();

  loaders.loadAgentDetail.mockResolvedValueOnce({
    ...detail,
    bindings: null,
    publishedPrompt: null,
  });
  render(await readDetail());
  expect(screen.getByText("This agent is not selected in the published definition")).toBeVisible();
  expect(screen.queryByText(/Legacy execution/)).not.toBeInTheDocument();
});
