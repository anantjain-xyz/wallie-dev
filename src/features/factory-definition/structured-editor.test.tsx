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

function renderEditor(initial = initialDefinition, benchmarksHref?: string) {
  const onChange = vi.fn<(definition: SerialFactoryDefinition) => void>();

  function Harness() {
    const [definition, setDefinition] = useState(initial);
    return (
      <StructuredFactoryDefinitionEditor
        benchmarksHref={benchmarksHref}
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

  it("edits and removes exact tool revision bindings", () => {
    const toolRevisionId = "00000000-0000-4000-8000-000000000005";
    const secretBindingId = "00000000-0000-4000-8000-000000000006";
    const { current } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add tool binding" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Tool revision 1" }), {
      target: { value: toolRevisionId },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Allowed operations" }), {
      target: { value: "read_item\nlist_items" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "MCP secret binding" }), {
      target: { value: secretBindingId },
    });
    expect(current().mcpBindings).toEqual([
      { toolRevisionId, operations: ["read_item", "list_items"], secretBindingId },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove tool binding 1" }));
    expect(current().mcpBindings).toBeUndefined();
  });

  it("emits editable compiler input for references, runtime, and operating rules", () => {
    const { current } = renderEditor();
    const skills = screen.getByRole("textbox", { name: "Skills" });

    fireEvent.change(skills, { target: { value: "issue-planning\n" } });
    expect(skills).toHaveValue("issue-planning\n");
    fireEvent.change(skills, { target: { value: "issue-planning\ncode-review" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Default writable repository" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Default writable repository" })).getByRole(
        "option",
        { name: repositories[1].fullName },
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Delivery policy revision" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Sandbox provider" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Sandbox provider" })).getByRole("option", {
        name: "E2B",
      }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Agent provider" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Agent provider" })).getByRole("option", {
        name: "Cursor",
      }),
    );
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
    fireEvent.click(readContext);
    const initialReadContextList = screen.getByRole("listbox", {
      name: "Read-only context repositories",
    });
    expect(
      within(initialReadContextList).queryByRole("option", { name: "wallie/archive" }),
    ).toBeNull();
    expect(
      within(initialReadContextList).queryByRole("option", { name: "wallie/notes" }),
    ).toBeNull();
    fireEvent.click(readContext);

    fireEvent.click(writable);
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Other writable repositories" })).getByRole(
        "option",
        { name: repositories[1].fullName },
      ),
    );
    fireEvent.click(readContext);
    const updatedReadContextList = screen.getByRole("listbox", {
      name: "Read-only context repositories",
    });
    expect(
      within(updatedReadContextList).queryByRole("option", { name: "wallie/runtime" }),
    ).toBeNull();
    fireEvent.click(
      within(updatedReadContextList).getByRole("option", { name: repositories[2].fullName }),
    );
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
    fireEvent.click(writable);
    expect(
      within(screen.getByRole("listbox", { name: "Other writable repositories" })).getByRole(
        "option",
        { name: "wallie/docs" },
      ),
    ).toBeInTheDocument();
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

it("adds and orders routing classes and rules through the structured definition", () => {
  const benchmarksHref = "/w/test/benchmarks";
  const { current } = renderEditor(initialDefinition, benchmarksHref);
  const routing = within(screen.getByRole("region", { name: "Model routing" }));
  fireEvent.click(routing.getByRole("button", { name: "Add routing policy" }));
  const addClass = routing.getByRole("button", { name: "Add task class" });
  expect(addClass).toHaveFocus();
  const benchmarks = routing.getByRole("link", { name: "Benchmarks (opens in a new tab)" });
  expect(benchmarks).toHaveAttribute("href", benchmarksHref);
  expect(benchmarks).toHaveAttribute("target", "_blank");
  expect(benchmarks).toHaveAttribute("rel", "noreferrer");

  for (const [index, [name, slug]] of [
    ["Planning", "plan"],
    ["Build", "build"],
  ].entries()) {
    fireEvent.click(addClass);
    const nameInput = routing.getAllByRole("textbox", { name: "Task class name" })[index];
    expect(nameInput).toHaveFocus();
    fireEvent.change(nameInput, { target: { value: name } });
    fireEvent.change(routing.getAllByRole("textbox", { name: "Task class slug" })[index], {
      target: { value: slug },
    });
    fireEvent.click(routing.getByRole("button", { name: "Add routing rule" }));
  }

  fireEvent.click(routing.getByRole("button", { name: "Move Build rule up" }));
  const editedRule = routing.getByRole("button", { name: "Hide Build rule" });
  expect(editedRule).toHaveFocus();
  const orderedIds = current()
    .modelRouting?.taskClasses.map(({ id }) => id)
    .reverse();
  expect(current().modelRouting?.rules.map(({ taskClassId }) => taskClassId)).toEqual(orderedIds);

  fireEvent.change(routing.getByRole("spinbutton", { name: "Quality floor (%)" }), {
    target: { value: "83.25" },
  });
  fireEvent.click(routing.getByRole("combobox", { name: "When the primary is unavailable" }));
  fireEvent.click(
    within(screen.getByRole("listbox", { name: "When the primary is unavailable" })).getByRole(
      "option",
      { name: "Use fallback" },
    ),
  );
  const fallback = within(routing.getByRole("group", { name: "Rule fallback configuration" }));
  fireEvent.change(fallback.getByRole("textbox", { name: "Model ID" }), {
    target: { value: "openai/gpt-5.5" },
  });
  expect(current().modelRouting?.rules[0]).toMatchObject({
    constraints: { qualityFloorBps: 8_325 },
    onUnavailable: { kind: "fallback", configuration: { modelKey: "openai/gpt-5.5" } },
  });
  expect(current().modelRouting?.rules[1]?.onUnavailable).toEqual({ kind: "escalate" });

  fireEvent.click(routing.getByRole("combobox", { name: "When no rule matches" }));
  fireEvent.click(
    within(screen.getByRole("listbox", { name: "When no rule matches" })).getByRole("option", {
      name: "Use fallback",
    }),
  );
  expect(
    routing.getByRole("group", { name: "Unmatched-task fallback configuration" }),
  ).toBeVisible();

  fireEvent.click(routing.getByRole("button", { name: "Remove Build and its rule" }));
  expect(current().modelRouting?.taskClasses.map(({ slug }) => slug)).toEqual(["plan"]);
  expect(current().modelRouting?.rules).toHaveLength(1);
  expect(current().stages).toEqual(initialDefinition.stages);
});
