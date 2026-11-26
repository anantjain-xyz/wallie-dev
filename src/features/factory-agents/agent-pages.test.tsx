// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AgentPage from "@/app/w/[workspaceSlug]/(app)/agents/[agentId]/page";
import AgentNotFound from "@/app/w/[workspaceSlug]/(app)/agents/[agentId]/not-found";
import AgentsPage from "@/app/w/[workspaceSlug]/(app)/agents/page";

const loaders = vi.hoisted(() => ({
  loadAgentPageScope: vi.fn(),
  loadAgentsList: vi.fn(),
  loadAgentDetail: vi.fn(),
}));
vi.mock("./agent-pages-data", () => loaders);
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  useParams: () => ({ workspaceSlug: "release" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/features/factories/factory-selector", () => ({
  FactorySelector: () => null,
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

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
  loaders.loadAgentPageScope.mockResolvedValue({ scope, factories: [factory] });
  loaders.loadAgentDetail.mockResolvedValue(detail);
  loaders.loadAgentsList.mockResolvedValue({
    agents: [agent],
    implementationAgentId: agent.id,
    nextAfterId: agent.id,
  });
});
afterEach(cleanup);

function readDirectory(searchParams = query) {
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
