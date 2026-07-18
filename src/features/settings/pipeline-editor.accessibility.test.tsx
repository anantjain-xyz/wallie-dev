// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PipelineEditor } from "@/features/settings/pipeline-editor";
import type { SessionPipeline } from "@/features/sessions/types";

const pipeline: SessionPipeline = {
  id: "00000000-0000-4000-8000-000000000001",
  isDefault: true,
  name: "Default",
  operatingRulesMd: "Keep changes reviewable.",
  stages: [
    {
      approverMemberIds: [],
      description: "Define the work",
      id: "00000000-0000-4000-8000-000000000011",
      name: "Plan",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      position: 0,
      promptTemplateMd: "Write a plan for {{session.title}}.",
      slug: "plan",
    },
    {
      approverMemberIds: [],
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
    id: "00000000-0000-4000-8000-000000000021",
    role: "owner" as const,
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PipelineEditor accessibility", () => {
  it("labels every stage field and supports keyboard approver selection", async () => {
    const user = userEvent.setup();
    render(
      <main>
        <PipelineEditor
          canManage
          pipeline={pipeline}
          workspaceId="00000000-0000-4000-8000-000000000002"
          workspaceMembers={workspaceMembers}
        />
      </main>,
    );

    expect(screen.getByRole("textbox", { name: "Pipeline name" })).toHaveAccessibleDescription(
      "Identifies this pipeline throughout the workspace.",
    );
    expect(screen.getAllByRole("textbox", { name: "Stage name" })).toHaveLength(2);
    expect(screen.getAllByRole("textbox", { name: "Slug" })).toHaveLength(2);
    expect(screen.getAllByRole("textbox", { name: "Description" })).toHaveLength(2);
    expect(screen.getAllByRole("textbox", { name: "Prompt template" })).toHaveLength(2);

    const approver = screen.getAllByRole("button", {
      name: "Approvers Owners and admins (default)",
    })[0]!;
    expect(approver).toHaveAttribute("aria-expanded", "false");
    expect(approver).toHaveAttribute("aria-controls", "pipeline-stage-0-approvers-options");

    approver.focus();
    await user.keyboard("{Enter}");
    expect(approver).toHaveAttribute("aria-expanded", "true");
    const checkbox = screen.getByRole("checkbox", { name: "Avery Owner (owner)" });
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();

    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("links every error and focuses the exact first invalid field in a multi-stage save", async () => {
    const user = userEvent.setup();
    render(
      <main>
        <PipelineEditor
          canManage
          pipeline={pipeline}
          workspaceId="00000000-0000-4000-8000-000000000002"
          workspaceMembers={workspaceMembers}
        />
      </main>,
    );

    const stageNames = screen.getAllByRole("textbox", { name: "Stage name" });
    const stageSlugs = screen.getAllByRole("textbox", { name: "Slug" });
    await user.clear(stageNames[1]!);
    await user.clear(stageSlugs[1]!);
    await user.type(stageSlugs[1]!, "Bad Slug");
    await user.click(screen.getByRole("button", { name: "Save pipeline" }));

    await waitFor(() => expect(stageNames[1]).toHaveFocus());
    expect(stageNames[1]).toHaveAttribute("aria-invalid", "true");
    expect(stageNames[1]).toHaveAccessibleDescription(
      "Shown anywhere this stage appears in the pipeline. Stage 2 needs a name.",
    );
    expect(stageSlugs[1]).toHaveAttribute("aria-invalid", "true");

    const summary = screen.getByRole("alert", { name: "Fix these fields before saving" });
    const nameLink = within(summary).getByRole("link", { name: "Stage 2 needs a name." });
    expect(nameLink).toHaveAttribute("href", "#pipeline-stage-1-name");
    expect(
      within(summary).getByRole("link", {
        name: "Stage 2 slug must use lowercase letters, numbers, and single hyphens.",
      }),
    ).toHaveAttribute("href", "#pipeline-stage-1-slug");

    stageSlugs[0]!.focus();
    await user.click(nameLink);
    expect(stageNames[1]).toHaveFocus();

    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
