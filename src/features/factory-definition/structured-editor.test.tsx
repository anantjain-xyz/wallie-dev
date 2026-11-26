// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredFactoryDefinitionEditor } from "./structured-editor";
import type { ReferencePickerCatalog } from "./named-references";
import {
  grantReferenceKey,
  routingConfigurationKey,
} from "@/lib/factory-definitions/named-reference-contracts";
import { mcpOperationScopeId } from "@/lib/factory-mcp/manifest";
import type { SerialFactoryDefinition } from "@/lib/factory-definitions/schema";

const planId = "00000000-0000-4000-8000-000000000001";
const buildId = "00000000-0000-4000-8000-000000000002";
const memberId = "00000000-0000-4000-8000-000000000003";
const namedId = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
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

function renderEditor(
  initial = initialDefinition,
  benchmarksHref?: string,
  options: ReferencePickerCatalog["options"] = {},
) {
  const onChange = vi.fn<(definition: SerialFactoryDefinition) => void>();

  function Harness() {
    const [definition, setDefinition] = useState(initial);
    return (
      <StructuredFactoryDefinitionEditor
        benchmarksHref={benchmarksHref}
        namedReferences={{
          options: {
            approvers: [{ id: memberId, label: "Alex Reviewer · alex@example.test · member" }],
            ...options,
          },
          hasMore: () => false,
          loadMore: () => undefined,
          pending: null,
        }}
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

function choose(field: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: field }));
  fireEvent.click(
    within(screen.getByRole("listbox", { name: field })).getByRole("option", {
      name: option,
    }),
  );
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
      screen.getByRole("combobox", { name: "Implementation agent prompt revision" }),
    ).toHaveTextContent("Agent prompt revision unavailable");
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
    const grantId = namedId(11);
    const principalId = namedId(12);
    const agentId = namedId(13);
    const implementationAgent = namedId(14);
    const { current } = renderEditor(
      {
        ...initialDefinition,
        implementationAgent,
        executionGrant: { id: grantId, version: 3 },
        credentialBindingId: namedId(15),
      },
      undefined,
      {
        implementationAgent: [
          { id: implementationAgent, agentId, label: "Operator agent · Revision 6" },
        ],
        tools: [
          {
            id: toolRevisionId,
            label: "Issue reader · Revision 2",
            authKind: "bearer",
            operations: ["read_item", "list_items"],
          },
        ],
        grants: [
          {
            id: grantReferenceKey(grantId, 3),
            grantId,
            version: 3,
            principalId,
            toolIds: ["read_item", "list_items"].map((name) =>
              mcpOperationScopeId(toolRevisionId, name),
            ),
            label: "Release bot · Grant v3",
          },
        ],
        bindings: [
          {
            id: secretBindingId,
            label: "Release bot · Saved bearer binding",
            grantId,
            toolId: toolRevisionId,
            principalId,
            agentId,
          },
          {
            id: namedId(16),
            label: "Other agent binding",
            grantId,
            toolId: toolRevisionId,
            principalId,
            agentId: namedId(17),
          },
        ],
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add tool binding" }));
    choose("Tool revision 1", "Issue reader · Revision 2");
    fireEvent.click(screen.getByRole("button", { name: /Allowed operations/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "read_item" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "list_items" }));
    fireEvent.click(screen.getByRole("combobox", { name: "MCP secret binding" }));
    expect(screen.queryByRole("option", { name: "Other agent binding" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Release bot · Saved bearer binding" }));
    expect(current().mcpBindings).toEqual([
      { toolRevisionId, operations: ["read_item", "list_items"], secretBindingId },
    ]);
    choose("Tool revision 1", "Issue reader · Revision 2");
    choose("Execution grant", "Release bot · Grant v3");
    expect(current().credentialBindingId).toBe(namedId(15));
    expect(current().mcpBindings).toEqual([
      { toolRevisionId, operations: ["read_item", "list_items"], secretBindingId },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove tool binding 1" }));
    expect(current().mcpBindings).toBeUndefined();
  });

  it("keeps revoked tool operations removable without offering new operations", () => {
    const toolRevisionId = namedId(34);
    const grantId = namedId(35);
    const { current } = renderEditor(
      {
        ...initialDefinition,
        executionGrant: { id: grantId, version: 1 },
        mcpBindings: [{ toolRevisionId, operations: ["read"] }],
      },
      undefined,
      {
        tools: [
          {
            id: toolRevisionId,
            label: "Older tool · Revision 1",
            operations: ["read", "write"],
            unavailable: true,
          },
        ],
        grants: [
          {
            id: grantReferenceKey(grantId, 1),
            grantId,
            version: 1,
            label: "Release bot · Grant v1",
            toolIds: ["read", "write"].map((name) => mcpOperationScopeId(toolRevisionId, name)),
          },
        ],
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /Allowed operations/ }));
    expect(screen.queryByRole("checkbox", { name: "write" })).toBeNull();
    const saved = screen.getByRole("checkbox", { name: "read · Unavailable" });
    expect(saved).toBeChecked();
    fireEvent.click(saved);
    expect(current().mcpBindings).toEqual([{ toolRevisionId, operations: [] }]);
  });

  it("emits editable compiler input for references, runtime, and operating rules", () => {
    const { current } = renderEditor(initialDefinition, undefined, {
      skills: [
        { id: namedId(21), label: "Issue planning · Revision 4" },
        { id: namedId(22), label: "Code review · Revision 2" },
      ],
    });
    choose("Add a skill revision", "Issue planning · Revision 4");
    choose("Add a skill revision", "Code review · Revision 2");
    expect(
      within(screen.getByRole("list", { name: "Skills" })).getByText("Issue planning · Revision 4"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("combobox", { name: "Default writable repository" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Default writable repository" })).getByRole(
        "option",
        { name: repositories[1].fullName },
      ),
    );
    choose("Delivery policy revision", "No policy pinned");
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
      skills: [namedId(21), namedId(22)],
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

  it("picks an exact routing tuple without transcribing components", () => {
    const configuration = {
      agentId: namedId(24),
      definitionRevisionId: namedId(25),
      experimentId: namedId(26),
      qualificationId: namedId(27),
      scorerRevisionId: namedId(28),
      modelKey: "openai/gpt-5.6",
      harness: "codex",
      workerRuntime: "node",
    } as const;
    const label = "Planner · openai/gpt-5.6 · Readiness v2";
    const historical = { ...configuration, scorerRevisionId: undefined };
    const { current } = renderEditor(initialDefinition, undefined, {
      routing: [
        { id: routingConfigurationKey(configuration), configuration, label },
        {
          id: routingConfigurationKey(historical),
          configuration: historical,
          label: "Planner · Historical implicit scorer",
          labelOnly: true,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Add routing policy" }));
    fireEvent.click(screen.getByRole("button", { name: "Add task class" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task class name" }), {
      target: { value: "Plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add routing rule" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Primary configuration" }));
    const choices = within(screen.getByRole("listbox", { name: "Primary configuration" }));
    expect(
      choices.queryByRole("option", { name: "Planner · Historical implicit scorer" }),
    ).toBeNull();
    fireEvent.click(choices.getByRole("option", { name: label }));
    expect(current().modelRouting?.rules[0]).toMatchObject({
      configuration,
      onUnavailable: { kind: "escalate" },
    });
    expect(
      screen.queryByRole("textbox", { name: "Capability qualification ID" }),
    ).not.toBeInTheDocument();
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
    fireEvent.click(within(stage).getByRole("button", { name: /Approvers/ }));
    fireEvent.click(within(stage).getByRole("checkbox", { name: /Alex Reviewer/ }));
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
  const configuration = {
    agentId: namedId(29),
    definitionRevisionId: namedId(30),
    experimentId: namedId(31),
    qualificationId: namedId(32),
    scorerRevisionId: namedId(33),
    modelKey: "openai/gpt-5.5",
    harness: "codex",
    workerRuntime: "node",
  } as const;
  const label = "Builder · openai/gpt-5.5 · Delivery v3";
  const { current } = renderEditor(initialDefinition, benchmarksHref, {
    routing: [{ id: routingConfigurationKey(configuration), configuration, label }],
  });
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
  choose("Rule fallback configuration", label);
  expect(current().modelRouting?.rules[0]?.constraints.qualityFloorBps).toBe(8_325);
  expect(current().modelRouting?.rules[0]?.onUnavailable).toEqual({
    kind: "fallback",
    configuration,
  });
  fireEvent.click(routing.getByRole("combobox", { name: "When the primary is unavailable" }));
  fireEvent.click(
    within(screen.getByRole("listbox", { name: "When the primary is unavailable" })).getByRole(
      "option",
      { name: "Use fallback" },
    ),
  );
  expect(current().modelRouting?.rules[0]?.constraints.qualityFloorBps).toBe(8_325);
  expect(current().modelRouting?.rules[0]?.onUnavailable).toEqual({
    kind: "fallback",
    configuration,
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
