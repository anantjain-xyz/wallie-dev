// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { CreateSessionDialogLoading } from "@/components/app-shell/shell-header";
import {
  invalidateSessionRepositoryCache,
  loadSessionRepositories,
  resetSessionRepositoryCacheForTests,
} from "@/features/sessions/session-repository-cache";

const clientMocks = vi.hoisted(() => ({
  createSessionFromClient: vi.fn(),
  loadSessionRepositoryOptionsFromClient: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/sessions/client", () => clientMocks);

import { CreateSessionDialog } from "@/features/sessions/create-session-dialog";

beforeAll(() => {
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
  vi.clearAllMocks();
  resetSessionRepositoryCacheForTests();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("CreateSessionDialog accessibility", () => {
  it("announces the lazy loading state inside the shared modal", async () => {
    render(
      <OverlayProvider>
        <CreateSessionDialogLoading />
      </OverlayProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "Start a new session" })).toBeVisible();
    const loadingStatus = screen.getByText("Loading session form…").closest('[role="status"]');
    expect(loadingStatus).toHaveAttribute("aria-busy", "true");
    expect(loadingStatus).toHaveTextContent("Loading session form…");
  });

  it("dismisses the lazy loading state with Escape and closes the parent flow", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <OverlayProvider>
        <CreateSessionDialogLoading onClose={onClose} />
      </OverlayProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "Start a new session" })).toBeVisible();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("labels, focuses, traps, locks, and keyboard-dismisses the shared Dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    clientMocks.loadSessionRepositoryOptionsFromClient.mockResolvedValue({
      defaultGithubRepositoryId: null,
      pipelineId: "00000000-0000-4000-8000-000000000010",
      repositoryOptions: [],
      stageOptions: [
        {
          description: "Plan the work",
          id: "00000000-0000-4000-8000-000000000011",
          name: "Plan",
          position: 1,
        },
      ],
    });

    render(
      <OverlayProvider>
        <button type="button">Outside</button>
        <CreateSessionDialog
          onClose={onClose}
          open
          userId="00000000-0000-4000-8000-000000000002"
          workspaceId="00000000-0000-4000-8000-000000000001"
          workspaceSlug="acme"
        />
      </OverlayProvider>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Start a new session" });
    expect(dialog).toHaveAccessibleDescription(
      "Link a Linear issue or describe the work, then choose where Wallie should run.",
    );
    expect(screen.queryByText("Work to start")).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Linear issue URL")).toHaveFocus());
    await waitFor(() => expect(document.body.dataset.scrollLocked).toBe("1"));
    expect(screen.getByText("Outside").closest("button")).toHaveAttribute("aria-hidden", "true");

    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("starts a session from a Linear issue without requiring a prompt", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const userId = "00000000-0000-4000-8000-000000000002";
    clientMocks.loadSessionRepositoryOptionsFromClient.mockResolvedValue({
      defaultGithubRepositoryId: null,
      pipelineId: "00000000-0000-4000-8000-000000000010",
      repositoryOptions: [],
      stageOptions: [
        {
          description: "Plan the work",
          id: "00000000-0000-4000-8000-000000000011",
          name: "Plan",
          position: 1,
        },
      ],
    });
    clientMocks.createSessionFromClient.mockResolvedValue({
      canonicalUrl: "/w/acme/sessions/42",
      number: 42,
    });

    render(
      <OverlayProvider>
        <CreateSessionDialog
          onClose={onClose}
          open
          userId={userId}
          workspaceId={workspaceId}
          workspaceSlug="acme"
        />
      </OverlayProvider>,
    );

    await user.type(
      await screen.findByLabelText("Linear issue URL"),
      "https://linear.app/acme/issue/TEAM-42/title",
    );
    expect(screen.getByLabelText("Title (optional)")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(clientMocks.createSessionFromClient).toHaveBeenCalledWith({
        githubRepositoryId: null,
        linearIssueUrl: "https://linear.app/acme/issue/TEAM-42/title",
        promptMd: "",
        selectedStageIds: ["00000000-0000-4000-8000-000000000011"],
        title: null,
        workspaceId,
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith("/w/acme/sessions/42");
  });

  it("clears a Linear URL error when the URL is corrected", async () => {
    const user = userEvent.setup();
    clientMocks.loadSessionRepositoryOptionsFromClient.mockResolvedValue({
      defaultGithubRepositoryId: null,
      pipelineId: "00000000-0000-4000-8000-000000000010",
      repositoryOptions: [],
      stageOptions: [
        {
          description: "Plan the work",
          id: "00000000-0000-4000-8000-000000000011",
          name: "Plan",
          position: 1,
        },
      ],
    });

    render(
      <OverlayProvider>
        <CreateSessionDialog
          onClose={vi.fn()}
          open
          userId="00000000-0000-4000-8000-000000000002"
          workspaceId="00000000-0000-4000-8000-000000000001"
          workspaceSlug="acme"
        />
      </OverlayProvider>,
    );

    const linearInput = await screen.findByLabelText("Linear issue URL");
    await user.type(linearInput, "https://linear.app/acme/settings");
    await user.tab();
    expect(screen.getByText("Must be a Linear issue URL.")).toBeVisible();

    await user.clear(linearInput);
    await user.type(linearInput, "https://linear.app/acme/issue/TEAM-42/title");

    expect(screen.queryByText("Must be a Linear issue URL.")).toBeNull();
    expect(screen.getByLabelText("Title (optional)")).toBeDisabled();
  });

  it("defaults every stage on, validates an empty selection, and submits a partial selection", async () => {
    const user = userEvent.setup();
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const planStageId = "00000000-0000-4000-8000-000000000011";
    const buildStageId = "00000000-0000-4000-8000-000000000012";
    clientMocks.loadSessionRepositoryOptionsFromClient.mockResolvedValue({
      defaultGithubRepositoryId: null,
      pipelineId: "00000000-0000-4000-8000-000000000010",
      repositoryOptions: [],
      stageOptions: [
        { description: "Plan the work", id: planStageId, name: "Plan", position: 1 },
        { description: "Build the work", id: buildStageId, name: "Build", position: 2 },
      ],
    });
    clientMocks.createSessionFromClient.mockResolvedValue({
      canonicalUrl: "/w/acme/sessions/42",
      number: 42,
    });

    render(
      <OverlayProvider>
        <CreateSessionDialog
          onClose={vi.fn()}
          open
          userId="00000000-0000-4000-8000-000000000002"
          workspaceId={workspaceId}
          workspaceSlug="acme"
        />
      </OverlayProvider>,
    );

    const stagesButton = await screen.findByRole("button", { name: "Stages All 2 stages." });
    stagesButton.focus();
    await user.keyboard(" ");
    expect(stagesButton).toHaveAttribute("aria-expanded", "true");
    const planCheckbox = screen.getByRole("checkbox", { name: "Plan (Plan the work)" });
    const buildCheckbox = screen.getByRole("checkbox", { name: "Build (Build the work)" });
    expect(planCheckbox).toBeChecked();
    expect(buildCheckbox).toBeChecked();

    await user.click(buildCheckbox);
    expect(screen.getByRole("button", { name: "Stages 1 of 2 stages." })).toBeVisible();
    await user.click(planCheckbox);
    expect(screen.getByText("Select at least one stage.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();

    await user.click(planCheckbox);
    await user.type(screen.getByLabelText("Prompt"), "Build the dashboard");
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(clientMocks.createSessionFromClient).toHaveBeenCalledWith(
        expect.objectContaining({ selectedStageIds: [planStageId], workspaceId }),
      ),
    );
  });

  it("refreshes session options after a selected-stage conflict", async () => {
    const user = userEvent.setup();
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const pipelineId = "00000000-0000-4000-8000-000000000010";
    const planStageId = "00000000-0000-4000-8000-000000000011";
    const buildStageId = "00000000-0000-4000-8000-000000000012";
    clientMocks.loadSessionRepositoryOptionsFromClient
      .mockResolvedValueOnce({
        defaultGithubRepositoryId: null,
        pipelineId,
        repositoryOptions: [],
        stageOptions: [
          { description: "Plan the work", id: planStageId, name: "Plan", position: 1 },
        ],
      })
      .mockResolvedValueOnce({
        defaultGithubRepositoryId: null,
        pipelineId,
        repositoryOptions: [],
        stageOptions: [
          { description: "Plan the work", id: planStageId, name: "Plan", position: 1 },
          { description: "Build the work", id: buildStageId, name: "Build", position: 2 },
        ],
      });
    clientMocks.createSessionFromClient.mockRejectedValueOnce(
      Object.assign(
        new Error("The workspace pipeline changed. Refresh the stage options and try again."),
        { code: "session_options_changed" },
      ),
    );

    render(
      <OverlayProvider>
        <CreateSessionDialog
          onClose={vi.fn()}
          open
          userId="00000000-0000-4000-8000-000000000002"
          workspaceId={workspaceId}
          workspaceSlug="acme"
        />
      </OverlayProvider>,
    );

    expect(await screen.findByRole("button", { name: "Stages All 1 stages." })).toBeVisible();
    await user.type(screen.getByLabelText("Prompt"), "Build the dashboard");
    await user.click(screen.getByRole("button", { name: "Start session" }));

    expect(
      await screen.findByText(
        "The workspace pipeline changed. Refresh the stage options and try again.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(clientMocks.loadSessionRepositoryOptionsFromClient).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByRole("button", { name: "Stages All 2 stages." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  });

  it("blocks keyboard submission while cached repository options are stale", async () => {
    const user = userEvent.setup();
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const userId = "00000000-0000-4000-8000-000000000002";
    const repositoryResult = {
      defaultGithubRepositoryId: "repo-1",
      pipelineId: "00000000-0000-4000-8000-000000000010",
      repositoryOptions: [{ fullName: "acme/app", id: "repo-1" }],
      stageOptions: [
        {
          description: "Plan the work",
          id: "00000000-0000-4000-8000-000000000011",
          name: "Plan",
          position: 1,
        },
      ],
    };

    await loadSessionRepositories(
      { userId, workspaceId },
      { load: async () => repositoryResult, now: Date.now() },
    );
    invalidateSessionRepositoryCache(workspaceId);
    clientMocks.loadSessionRepositoryOptionsFromClient.mockImplementation(
      () => new Promise(() => undefined),
    );

    render(
      <OverlayProvider>
        <CreateSessionDialog
          onClose={vi.fn()}
          open
          userId={userId}
          workspaceId={workspaceId}
          workspaceSlug="acme"
        />
      </OverlayProvider>,
    );

    await user.type(screen.getByLabelText("Prompt"), "Build the dashboard");
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(clientMocks.createSessionFromClient).not.toHaveBeenCalled();
    expect(
      screen
        .getByText("Refresh session options before starting a session.")
        .closest('[role="status"]'),
    ).toBeVisible();
  });
});
