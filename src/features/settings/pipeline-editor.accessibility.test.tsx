// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { PipelineEditor } from "@/features/settings/pipeline-editor";
import type { PipelineConfiguration } from "@/features/sessions/types";

const memberId = "00000000-0000-4000-8000-000000000021";

const pipeline: PipelineConfiguration = {
  archivedStages: [],
  id: "00000000-0000-4000-8000-000000000001",
  isDefault: true,
  name: "Default",
  operatingRulesMd: "Keep changes reviewable.",
  stages: [
    {
      anyoneCanApprove: false,
      approverMemberIds: [memberId],
      description: "Define the work",
      id: "00000000-0000-4000-8000-000000000011",
      name: "Plan",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      position: 0,
      promptTemplateMd: "Write a plan for {{session.title}}.",
      slug: "plan",
    },
    {
      anyoneCanApprove: false,
      approverMemberIds: [memberId],
      description: "Implement the plan",
      id: "00000000-0000-4000-8000-000000000012",
      name: "Build",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      position: 1,
      promptTemplateMd: "Build the approved plan.",
      slug: "build",
    },
  ],
};

const workspaceMembers = [
  {
    email: "owner@example.com",
    fullName: "Avery Owner",
    id: memberId,
    role: "owner" as const,
  },
];

const axeOptions = { rules: { "color-contrast": { enabled: false } } };

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
  vi.restoreAllMocks();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

function renderEditor(
  onPipelineSaved?: (pipeline: PipelineConfiguration) => void,
  pipelineValue: PipelineConfiguration = pipeline,
) {
  return render(
    <OverlayProvider>
      <main>
        <PipelineEditor
          canManage
          onPipelineSaved={onPipelineSaved}
          pipeline={pipelineValue}
          workspaceId="00000000-0000-4000-8000-000000000002"
          workspaceMembers={workspaceMembers}
        />
      </main>
    </OverlayProvider>,
  );
}

describe("PipelineEditor accessibility", () => {
  it("labels every stage field and supports keyboard approver selection", async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByRole("textbox", { name: "Pipeline name" })).toHaveAccessibleDescription(
      "Identifies this pipeline throughout the workspace.",
    );
    expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(2);
    expect(screen.queryAllByRole("textbox", { name: "Slug" })).toHaveLength(0);
    expect(screen.getAllByRole("textbox", { name: "Description" })).toHaveLength(2);
    expect(screen.getAllByRole("textbox", { name: "Prompt template" })).toHaveLength(2);
    expect(
      screen.queryByRole("navigation", { name: "Pipeline order preview" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Who can approve?")).toHaveLength(2);
    expect(screen.getAllByRole("radio", { name: "Anyone in the workspace" })).toHaveLength(2);
    expect(screen.getAllByRole("radio", { name: "Specific members" })).toHaveLength(2);
    expect(screen.getAllByRole("radio", { name: "Specific members" })[0]).toBeChecked();

    const operatingRules = screen.getByRole("textbox", { name: "Operating rules" });
    expect(operatingRules).toHaveStyle({ minHeight: "160px", maxHeight: "640px" });
    expect(operatingRules).toHaveAttribute("maxLength", "20000");
    expect(screen.getAllByRole("textbox", { name: "Prompt template" })[0]).toHaveStyle({
      minHeight: "160px",
      maxHeight: "640px",
    });

    const templateHelp = screen.getAllByText("Template variables");
    await user.click(templateHelp[1]!);
    expect(screen.getByText("{{artifact.previousStages.plan}}")).toBeInTheDocument();
    expect(screen.queryByText("{{artifact.previousStages.<slug>}}")).not.toBeInTheDocument();

    const approver = screen.getAllByRole("button", {
      name: "Approvers 1 member",
    })[0]!;
    expect(approver).toHaveAttribute("aria-expanded", "false");
    expect(approver).toHaveAttribute("aria-controls", "pipeline-stage-0-approvers-options");

    approver.focus();
    await user.keyboard("{Enter}");
    expect(approver).toHaveAttribute("aria-expanded", "true");
    const checkbox = screen.getByRole("checkbox", { name: "Avery Owner (owner)" });
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).not.toBeChecked();

    const results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);
  });

  it("links every error and focuses the exact first invalid field in a multi-stage save", async () => {
    const user = userEvent.setup();
    renderEditor();

    const stageNames = screen.getAllByRole("textbox", { name: "Name" });
    const stagePrompts = screen.getAllByRole("textbox", { name: "Prompt template" });
    await user.clear(stageNames[1]!);
    await user.clear(stagePrompts[1]!);
    await user.click(screen.getByRole("button", { name: "Save pipeline" }));

    await waitFor(() => expect(stageNames[1]).toHaveFocus());
    expect(stageNames[1]).toHaveAttribute("aria-invalid", "true");
    expect(stageNames[1]).toHaveAccessibleDescription(
      "Shown anywhere this stage appears in the pipeline. Stage 2 needs a name.",
    );
    expect(stagePrompts[1]).toHaveAttribute("aria-invalid", "true");

    const summary = screen.getByRole("alert", { name: "Fix these fields before saving" });
    const nameLink = within(summary).getByRole("link", { name: "Stage 2 needs a name." });
    expect(nameLink).toHaveAttribute("href", "#pipeline-stage-1-name");
    expect(
      within(summary).getByRole("link", { name: "Stage 2 needs a prompt template." }),
    ).toHaveAttribute("href", "#pipeline-stage-1-prompt");

    stageNames[0]!.focus();
    await user.click(nameLink);
    expect(stageNames[1]).toHaveFocus();

    const results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);
  });

  it("supports a keyboard-only create, reorder, remove, and save flow", async () => {
    const user = userEvent.setup();
    const onPipelineSaved = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        pipeline: {
          ...pipeline,
          stages: [
            pipeline.stages[1],
            {
              ...pipeline.stages[0],
              name: "Intake",
              slug: "intake",
              id: "00000000-0000-4000-8000-000000000099",
            },
            pipeline.stages[0],
          ],
        },
        success: true,
      }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    renderEditor(onPipelineSaved);

    await user.click(screen.getByRole("button", { name: "+ Add stage" }));
    const names = screen.getAllByRole("textbox", { name: "Name" });
    const newName = names[2]!;
    await user.clear(newName);
    await user.type(newName, "Intake");
    expect(screen.queryAllByRole("textbox", { name: "Slug" })).toHaveLength(0);

    const intakeHelp = screen.getAllByText("Template variables")[2]!;
    await user.click(intakeHelp);
    expect(screen.getAllByText("{{artifact.previousStages.plan}}").length).toBeGreaterThan(0);
    expect(screen.getByText("{{artifact.previousStages.build}}")).toBeInTheDocument();

    const prompts = screen.getAllByRole("textbox", { name: "Prompt template" });
    await user.type(prompts[2]!, "Intake prompt");

    const approverButtons = screen.getAllByRole("button", {
      name: /Approvers/,
    });
    await user.click(approverButtons[2]!);
    await user.click(screen.getByRole("checkbox", { name: "Avery Owner (owner)" }));

    await user.click(screen.getByRole("button", { name: "Move Intake up to position 2 of 3" }));
    expect(
      screen.queryByRole("button", { name: /Drag to reorder Intake/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive Build from position 3 of 3" }));
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Archive Build?");
    expect(screen.getByText(/Existing sessions keep the stage/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive Build" }));
    expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(2);
    expect(screen.getByDisplayValue("Intake")).toBeInTheDocument();
    expect(screen.getByText("Archived stages (1)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save pipeline" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      stages: Array<{ name: string; slug: string }>;
    };
    expect(body.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Intake", slug: "intake" })]),
    );
    await waitFor(() => expect(screen.getByText(/Saved at/)).toBeInTheDocument());
    expect(onPipelineSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        stages: expect.arrayContaining([expect.objectContaining({ slug: "intake" })]),
      }),
    );

    const results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);
  });

  it("preserves edits on save failure and offers retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ error: "Server unavailable" }),
        ok: false,
      })
      .mockResolvedValueOnce({
        json: async () => ({ pipeline, success: true }),
        ok: true,
      });
    vi.stubGlobal("fetch", fetchMock);

    renderEditor();

    const nameField = screen.getByRole("textbox", { name: "Pipeline name" });
    await user.clear(nameField);
    await user.type(nameField, "Revised");
    await user.click(screen.getByRole("button", { name: "Save pipeline" }));

    await waitFor(() => expect(screen.getByText(/Server unavailable/)).toBeInTheDocument());
    expect(nameField).toHaveValue("Revised");
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("restores an archived stage with its durable id and saves it as active", async () => {
    const user = userEvent.setup();
    const reviewStage = {
      ...pipeline.stages[0]!,
      archivedAt: "2026-08-10T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000013",
      name: "Review",
      position: 3,
      slug: "review",
    };
    const pipelineWithArchive: PipelineConfiguration = {
      ...pipeline,
      archivedStages: [reviewStage],
    };
    const savedPipeline: PipelineConfiguration = {
      ...pipeline,
      archivedStages: [],
      stages: [...pipeline.stages, reviewStage],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ pipeline: savedPipeline, success: true }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    renderEditor(undefined, pipelineWithArchive);
    await user.click(screen.getByText("Archived stages (1)"));
    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(screen.getByDisplayValue("Review")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save pipeline" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      stages: Array<{ id?: string; slug: string }>;
    };
    expect(body.stages.at(-1)).toMatchObject({ id: reviewStage.id, slug: "review" });
  });

  it("locks editing while save is in flight and restores focus after canceling remove", async () => {
    const user = userEvent.setup();
    let resolveFetch: ((value: { json: () => Promise<object>; ok: boolean }) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderEditor();

    const nameField = screen.getByRole("textbox", { name: "Pipeline name" });
    await user.clear(nameField);
    await user.type(nameField, "Locked");
    await user.click(screen.getByRole("button", { name: "Save pipeline" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(nameField).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ Add stage" })).toBeDisabled();

    resolveFetch?.({
      json: async () => ({ pipeline: { ...pipeline, name: "Locked" }, success: true }),
      ok: true,
    });
    await waitFor(() => expect(nameField).not.toBeDisabled());

    const removeBuild = screen.getByRole("button", {
      name: "Archive Build from position 2 of 2",
    });
    removeBuild.focus();
    await user.click(removeBuild);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(removeBuild).toHaveFocus());
  });

  it("restores focus to a surviving row after removing the first stage", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("button", { name: "Archive Plan from position 1 of 2" }));
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Archive Plan?");
    await user.click(screen.getByRole("button", { name: "Archive Plan" }));

    await waitFor(() => {
      expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(1);
    });
    const survivingName = screen.getByRole("textbox", { name: "Name" });
    expect(survivingName).toHaveValue("Build");
    await waitFor(() => expect(survivingName).toHaveFocus());
  });

  it("toggles approval policy, shows members only for Specific members, and preserves selections", async () => {
    const user = userEvent.setup();
    renderEditor();

    const anyone = screen.getAllByRole("radio", { name: "Anyone in the workspace" })[0]!;
    const specific = screen.getAllByRole("radio", { name: "Specific members" })[0]!;
    expect(specific).toBeChecked();
    expect(screen.getAllByRole("button", { name: "Approvers 1 member" })).toHaveLength(2);

    await user.click(anyone);
    expect(anyone).toBeChecked();
    expect(screen.getAllByRole("button", { name: /Approvers/ })).toHaveLength(1);

    await user.click(specific);
    expect(specific).toBeChecked();
    expect(screen.getAllByRole("button", { name: "Approvers 1 member" })).toHaveLength(2);

    const results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);
  });

  it("rejects Specific members with no approver using the inline error pattern", async () => {
    const user = userEvent.setup();
    renderEditor();

    const approver = screen.getAllByRole("button", { name: "Approvers 1 member" })[0]!;
    await user.click(approver);
    await user.click(screen.getByRole("checkbox", { name: "Avery Owner (owner)" }));
    await user.click(screen.getByRole("button", { name: "Save pipeline" }));

    const summary = await screen.findByRole("alert", { name: "Fix this field before saving" });
    expect(
      within(summary).getByRole("link", { name: "Plan needs at least one approver." }),
    ).toHaveAttribute("href", "#pipeline-stage-0-approvers");
    expect(document.getElementById("pipeline-stage-0-approvers-error")).toHaveTextContent(
      "Plan needs at least one approver.",
    );

    const results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);
  });

  it("keeps a saved stage slug unchanged when the name is edited", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ pipeline, success: true }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    renderEditor();
    const planName = screen.getAllByRole("textbox", { name: "Name" })[0]!;
    await user.clear(planName);
    await user.type(planName, "Planning");
    await user.click(screen.getByRole("button", { name: "Save pipeline" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      stages: Array<{ id: string; name: string; slug: string }>;
    };
    expect(body.stages[0]).toMatchObject({
      id: pipeline.stages[0]?.id,
      name: "Planning",
      slug: "plan",
    });
  });

  it("omits slug text from the archived stage list", async () => {
    const user = userEvent.setup();
    const reviewStage = {
      ...pipeline.stages[0]!,
      archivedAt: "2026-08-10T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000013",
      name: "Review",
      position: 3,
      slug: "review",
    };
    renderEditor(undefined, { ...pipeline, archivedStages: [reviewStage] });

    await user.click(screen.getByText("Archived stages (1)"));
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.queryByText("review")).not.toBeInTheDocument();
  });
});
