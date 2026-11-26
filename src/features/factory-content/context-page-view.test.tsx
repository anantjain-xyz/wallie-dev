// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workspaceContextPath } from "@/lib/routes";

import { ContextPageView } from "./context-page-view";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const id = (n: number) => `57800000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [workspaceId, factoryId, sourceId, currentRevisionId, historicalId, grantId, repositoryId] = [
  1, 2, 3, 4, 5, 6, 7,
].map(id);
const instant = "2032-01-02T12:00:00.000Z";
const scope = {
  workspaceId,
  workspaceSlug: "atlas",
  isOperator: true,
  factory: { id: factoryId, name: "Design", isDefault: true, status: "active" as const },
};
const source = {
  id: sourceId,
  file_path: "docs/design.md",
  repository_id: repositoryId,
  github_installation_id: id(8),
  upstream_repository_id: 21,
  grant_id: grantId,
  grant_version: 3,
  current_revision_id: currentRevisionId,
  status: "synced",
  last_successful_sync_at: instant,
  last_sync_attempt_at: instant,
};
const revision = {
  id: historicalId,
  source_id: sourceId,
  upstream_revision: "a".repeat(40),
  upstream_updated_at: instant,
  media_type: "text/markdown",
  content_bytes: 128,
  content_sha256: "b".repeat(64),
  created_at: instant,
  content_purged_at: null as string | null,
};
const grant = { principalName: "Docs reader", expiresAt: instant, published: true };
const detail = {
  source,
  revision,
  sourceGrant: grant,
  repositoryNames: { [sourceId]: "atlas/design" },
  history: [revision],
  access: { [sourceId]: "available" },
  publishedDocuments: [{ sourceId, revisionId: currentRevisionId }],
  items: [],
  options: [],
  optionsUnavailable: false,
  nextSource: undefined,
  nextRevision: undefined,
  nextOption: undefined,
};
const query = { source: sourceId, revision: historicalId };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Context source workflow", () => {
  it("proposes the selected historical revision with the exact editor contract, without requesting a write", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<ContextPageView scope={scope} data={detail} query={query} />);
    expect(screen.getByText(/open a run’s Frozen inputs/i)).toBeInTheDocument();
    expect(screen.getByText(/published definition pins a different revision/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Docs reader · Grant v3/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View pinned revision" })).toHaveAttribute(
      "href",
      workspaceContextPath("atlas", {
        factory: factoryId,
        source: sourceId,
        revision: currentRevisionId,
      }),
    );
    expect(
      screen.getByRole("link", { name: "Propose revision in Factory Definition" }),
    ).toHaveAttribute(
      "href",
      `/w/atlas/settings/factory-definition?factory=${factoryId}&contextSource=${sourceId}&contextRevision=${historicalId}#definition-context-documents`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives a factory-only manager an exact share link without exposing the editor", () => {
    render(<ContextPageView scope={{ ...scope, isOperator: false }} data={detail} query={query} />);
    expect(screen.queryByRole("link", { name: /Factory Definition/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Ask a workspace owner or admin to pin this revision/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "exact revision link" })).toHaveAttribute(
      "href",
      workspaceContextPath("atlas", { factory: factoryId, ...query }),
    );
    expect(screen.getByRole("button", { name: "Sync source" })).toBeEnabled();
  });

  it.each([
    ["revoked", { ...detail, access: { [sourceId]: "access_revoked" } }],
    ["unverified", { ...detail, access: {} }],
    ["purged", { ...detail, revision: { ...revision, content_purged_at: instant } }],
    ["missing exact revision", { ...detail, revision: null }],
  ])("offers no proposal for %s inputs", (_label, data) => {
    render(<ContextPageView scope={scope} data={data} query={query} />);
    expect(screen.queryByRole("link", { name: /Factory Definition/i })).not.toBeInTheDocument();
  });

  it("shows archived sources without offering a proposal, sync, or removal", () => {
    render(
      <ContextPageView
        scope={{ ...scope, factory: { ...scope.factory, status: "archived" } }}
        data={detail}
        query={query}
      />,
    );
    expect(screen.getByText(/This factory is archived/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Factory Definition/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove source" })).not.toBeInTheDocument();
  });

  it.each([true, false])(
    "distinguishes identical paths and gates setup guidance (operator: %s)",
    (isOperator) => {
      render(
        <ContextPageView
          scope={{ ...scope, isOperator }}
          data={{
            ...detail,
            source: null,
            items: [source, { ...source, id: id(9) }],
            publishedDocuments: undefined,
            repositoryNames: { [sourceId]: "atlas/design", [id(9)]: "atlas/engineering" },
          }}
          query={{}}
        />,
      );
      expect(screen.getByRole("link", { name: "docs/design.md atlas/design" })).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "docs/design.md atlas/engineering" }),
      ).toBeInTheDocument();
      expect(screen.getAllByText("Pin status unavailable")).toHaveLength(2);
      expect(screen.getByRole("link", { name: "View Governance" })).toBeInTheDocument();
      if (isOperator)
        expect(screen.getByRole("link", { name: "GitHub settings" })).toBeInTheDocument();
      else expect(screen.queryByRole("link", { name: "GitHub settings" })).not.toBeInTheDocument();
    },
  );

  it("distinguishes grants by name and keeps the entered path after a registration conflict", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: "That path already has a source under a different connection or grant.",
          code: "registration_conflict",
          existingSourceId: sourceId,
        },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const option = {
      grant_id: grantId,
      grant_version: 3,
      repository_id: repositoryId,
      repository_full_name: "atlas/design",
      grant,
    };
    render(
      <ContextPageView
        scope={scope}
        data={{
          ...detail,
          source: null,
          options: [
            option,
            {
              ...option,
              grant_id: id(10),
              grant: { ...grant, principalName: "Review reader", published: false },
            },
          ],
        }}
        query={{}}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Repository and grant" }));
    expect(screen.getByRole("option", { name: /Review reader.*Grant v3/ })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("option", { name: /Docs reader.*Used by published definition/ }),
    );
    const input = screen.getByRole("textbox", { name: "Document path" });
    fireEvent.change(input, { target: { value: source.file_path } });
    fireEvent.click(screen.getByRole("button", { name: "Register source" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has a source");
    expect(input).toHaveValue(source.file_path);
    expect(fetch).toHaveBeenCalledWith(
      `/api/workspaces/${workspaceId}/factories/${factoryId}/context-sources`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "register",
          repositoryId,
          grantId,
          grantVersion: 3,
          filePath: source.file_path,
        }),
      }),
    );
    expect(screen.getByRole("link", { name: "Open existing source and grant" })).toHaveAttribute(
      "href",
      workspaceContextPath("atlas", { factory: factoryId, source: sourceId }),
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("announces a busy sync, offers refresh, and reports a later success without claiming a new pin", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { code: "sync_in_progress", error: "A sync is already running." },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ source: { status: "synced" } }));
    vi.stubGlobal("fetch", fetch);
    render(<ContextPageView scope={scope} data={detail} query={query} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync source" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A sync is already running");
    fireEvent.click(screen.getByRole("button", { name: "Refresh source" }));
    expect(router.refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Sync source" }));
    expect(
      await screen.findByText("Source synced. Published pins have not changed."),
    ).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });
});
