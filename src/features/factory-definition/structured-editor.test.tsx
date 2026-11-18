// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredFactoryDefinitionEditor } from "./structured-editor";
import type { SerialFactoryDefinition } from "@/lib/factory-definitions/schema";

const planId = "00000000-0000-4000-8000-000000000001";
const buildId = "00000000-0000-4000-8000-000000000002";
const memberId = "00000000-0000-4000-8000-000000000003";
const repositories = [
  { id: "00000000-0000-4000-8000-000000000007", fullName: "wallie/notes", isArchived: false },
  { id: "00000000-0000-4000-8000-000000000008", fullName: "wallie/runtime", isArchived: false },
  { id: "00000000-0000-4000-8000-000000000009", fullName: "wallie/docs", isArchived: false },
  { id: "00000000-0000-4000-8000-000000000010", fullName: "wallie/archive", isArchived: true },
];

const initialDefinition: SerialFactoryDefinition = {
  schemaVersion: 1,
  kind: "serial",
  pipeline: "Default",
  repository: "wallie/notes",
  sandboxProvider: "vercel",
  agent: {
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    concurrencyLimit: 2,
    stallTimeoutMs: 900_000,
    maxRetries: 3,
    maxTurns: 5,
  },
  executionPolicy: null,
  deliveryPolicy: "00000000-0000-4000-8000-000000000004",
  skills: [],
  tools: [],
  operatingRulesMd: "Keep changes focused.",
  stages: [
    {
      id: planId,
      name: "Plan",
      slug: "plan",
      description: "",
      promptTemplateMd: "Draft a plan.",
      anyoneCanApprove: false,
      approverMemberIds: [memberId],
    },
    {
      id: buildId,
      name: "Build",
      slug: "build",
      description: "",
      promptTemplateMd: "Implement the plan.",
      anyoneCanApprove: true,
      approverMemberIds: [],
    },
  ],
};

function renderEditor(initial = initialDefinition) {
  const onChange = vi.fn<(definition: SerialFactoryDefinition) => void>();

  function Harness() {
    const [definition, setDefinition] = useState(initial);
    return (
      <StructuredFactoryDefinitionEditor
        onChange={(next) => {
          onChange(next);
          setDefinition(next);
        }}
        repositories={repositories}
        value={definition}
      />
    );
  }

  render(<Harness />);
  return { current: () => onChange.mock.lastCall?.[0] ?? initial };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("structured factory definition editor", () => {
  it("keeps the pinned agent prompt revision while editing stage instructions", () => {
    const revisionId = "00000000-0000-4000-8000-000000000005";
    const { current } = renderEditor({ ...initialDefinition, implementationAgent: revisionId });
    expect(
      screen.getByRole("textbox", { name: "Implementation agent prompt revision" }),
    ).toHaveValue(revisionId);
    fireEvent.change(screen.getByRole("textbox", { name: "Operating rules" }), {
      target: { value: "Keep the agent identity." },
    });
    expect(current().implementationAgent).toBe(revisionId);
  });

  it("preserves explicit MCP bindings when changing another structured setting", () => {
    const mcpBindings = [
      {
        toolRevisionId: "00000000-0000-4000-8000-000000000005",
        operations: ["read_item"],
      },
    ];
    const { current } = renderEditor({ ...initialDefinition, mcpBindings });
    fireEvent.change(screen.getByRole("textbox", { name: "Operating rules" }), {
      target: { value: "Keep the approved bindings." },
    });
    expect(current().mcpBindings).toEqual(mcpBindings);
  });

  it("emits editable compiler input for references, runtime, and operating rules", () => {
    const { current } = renderEditor();
    const skills = screen.getByRole("textbox", { name: "Skills" });

    fireEvent.change(skills, { target: { value: "issue-planning\n" } });
    expect(skills).toHaveValue("issue-planning\n");
    fireEvent.change(skills, { target: { value: "issue-planning\ncode-review" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Default writable repository" }), {
      target: { value: repositories[1].id },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Delivery policy revision" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Sandbox provider" }), {
      target: { value: "e2b" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Agent provider" }), {
      target: { value: "cursor" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Stall timeout (minutes)" }), {
      target: { value: "12.5" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Operating rules" }), {
      target: { value: "Validate each change." },
    });

    expect(current()).toMatchObject({
      ...initialDefinition,
      repository: repositories[1].id,
      deliveryPolicy: null,
      skills: ["issue-planning", "code-review"],
      sandboxProvider: "e2b",
      operatingRulesMd: "Validate each change.",
      agent: {
        ...initialDefinition.agent,
        provider: "cursor",
        model: "auto",
        effort: null,
        stallTimeoutMs: 750_000,
      },
    });
    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeDisabled();
  });

  it("keeps writable and read-context assignments distinct while editing", () => {
    const { current } = renderEditor();
    const writable = screen.getByRole("combobox", { name: "Other writable repositories" });
    const readContext = screen.getByRole("combobox", { name: "Read-only context repositories" });
    expect(within(readContext).queryByRole("option", { name: "wallie/archive" })).toBeNull();
    expect(within(readContext).queryByRole("option", { name: "wallie/notes" })).toBeNull();

    fireEvent.change(writable, { target: { value: repositories[1].id } });
    expect(within(readContext).queryByRole("option", { name: "wallie/runtime" })).toBeNull();
    fireEvent.change(readContext, { target: { value: repositories[2].id } });
    expect(current()).toMatchObject({
      repository: "wallie/notes",
      writableRepositories: [repositories[1].id],
      readContextRepositories: [repositories[2].id],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove wallie/docs from read-only context repositories",
      }),
    );
    expect(current().readContextRepositories).toBeUndefined();
    expect(within(writable).getByRole("option", { name: "wallie/docs" })).toBeInTheDocument();
  });

  it("moves stages with stable identities and keeps focus on edited stages", () => {
    const newId = "00000000-0000-4000-8000-000000000005";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(newId);
    const { current } = renderEditor();
    const list = screen.getByRole("list", { name: "Stage order" });

    fireEvent.click(within(list).getByRole("button", { name: "Move Build up" }));
    expect(current().stages.map(({ id }) => id)).toEqual([buildId, planId]);
    expect(within(list).getByRole("heading", { name: "1. Build" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Moved Build to position 1.");

    fireEvent.click(screen.getByRole("button", { name: "Add stage" }));
    const stage = within(list).getByRole("listitem", { name: "3. Stage 3" });
    const stageName = within(stage).getByRole("textbox", { name: "Stage name" });
    expect(stageName).toHaveFocus();
    fireEvent.change(stageName, { target: { value: "Review" } });
    fireEvent.change(within(stage).getByRole("textbox", { name: "Stage slug" }), {
      target: { value: "review" },
    });
    fireEvent.change(within(stage).getByRole("textbox", { name: "Stage prompt" }), {
      target: { value: "Review the changes." },
    });
    fireEvent.change(within(stage).getByRole("textbox", { name: "Approvers" }), {
      target: { value: memberId },
    });
    expect(current().stages[2]).toMatchObject({
      id: newId,
      name: "Review",
      slug: "review",
      promptTemplateMd: "Review the changes.",
      approverMemberIds: [memberId],
    });

    fireEvent.click(within(stage).getByRole("button", { name: "Remove Review" }));
    expect(current().stages.map(({ id }) => id)).toEqual([buildId, planId]);
    expect(within(list).getByRole("heading", { name: "2. Plan" })).toHaveFocus();
    fireEvent.click(within(list).getByRole("button", { name: "Remove Plan" }));
    expect(within(list).getByRole("button", { name: "Remove Build" })).toBeDisabled();
  });
});
