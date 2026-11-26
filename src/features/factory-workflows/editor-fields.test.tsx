// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";

import { EdgeFields, NodeFields, PolicyFields } from "./editor-fields";
import {
  defaultDelegationPolicy,
  initialGraph,
  makeNode,
  setEditorRepositoryWriters,
  type WorkflowEditorChoices,
  type WorkflowGraphDraft,
} from "./editor-graph";

afterEach(cleanup);

const primaryGrant = { id: "655d0000-0000-4000-8000-000000000011", version: 1 };
const secondaryGrant = { id: "655d0000-0000-4000-8000-000000000012", version: 2 };
const secondaryWriter = {
  ...secondaryGrant,
  repositoryId: "655d0000-0000-4000-8000-000000000013",
  label: "Repository Docs · Grant version 2",
};
const choices: WorkflowEditorChoices = {
  prompts: [],
  approvers: [],
  profiles: [],
  grant: primaryGrant,
  writers: [secondaryWriter],
};

function Inspector({
  initial,
  node,
  edge,
  policies = false,
}: {
  initial: WorkflowGraphDraft;
  node: number;
  edge?: number;
  policies?: boolean;
}) {
  const [graph, edit] = useState(initial);
  const fields = { graph, edit, diagnostics: [] };
  return (
    <>
      <NodeFields {...fields} index={node} choices={choices} />
      {edge === undefined ? null : <EdgeFields {...fields} index={edge} choices={choices} />}
      {policies ? <PolicyFields {...fields} choices={choices} /> : null}
    </>
  );
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(
    within(screen.getByRole("listbox", { name: label })).getByRole("option", { name: option }),
  );
}

it("preserves the selected operation and loop limit when the same kinds are reselected", () => {
  render(
    <Inspector
      node={1}
      edge={0}
      initial={{
        ...initialGraph,
        nodes: [
          ...initialGraph.nodes,
          { id: "policy", kind: "deterministic", operation: "policy" },
        ],
        edges: [{ id: "repeat", kind: "loop", from: "policy", to: "checkpoint", maxTraversals: 4 }],
      }}
    />,
  );
  choose("Step kind", "Deterministic step");
  expect(screen.getByRole("combobox", { name: "Operation" })).toHaveTextContent("Execution policy");
  choose("Transition kind", "Loop");
  expect(screen.getByRole("spinbutton", { name: "Maximum traversals" })).toHaveValue(4);
});

it("keeps the current step and its references until the new ID is unique", () => {
  render(
    <Inspector
      node={1}
      edge={0}
      initial={{
        ...initialGraph,
        nodes: [...initialGraph.nodes, makeNode("review", "human-gate")],
        edges: [{ id: "next", kind: "next", from: "checkpoint", to: "review" }],
      }}
    />,
  );
  fireEvent.click(screen.getByText("Advanced step settings"));
  const id = screen.getByRole("textbox", { name: "Step ID" });
  const target = screen.getByRole("combobox", { name: "To step" });
  fireEvent.change(id, { target: { value: "checkpoint" } });
  expect(id).toHaveValue("checkpoint");
  expect(id).toHaveAccessibleDescription(
    "Step ID “checkpoint” is already in use. Choose a unique ID.",
  );
  expect(target).toHaveAttribute("data-value", "review");
  fireEvent.blur(id);
  expect(id).toHaveValue("review");
  fireEvent.change(id, { target: { value: "checkpoint" } });
  fireEvent.change(id, { target: { value: "checkpoint-review" } });
  expect(target).toHaveAttribute("data-value", "checkpoint-review");
  expect(target).toHaveTextContent("Approval");
  expect(id).not.toHaveAttribute("aria-invalid");
});

it("preserves an unavailable exact execution profile without making its ID an option", () => {
  const revisionId = "655d0000-0000-4000-8000-000000000003";
  render(
    <Inspector
      node={1}
      initial={{
        ...initialGraph,
        nodes: [...initialGraph.nodes, makeNode("agent", "agent")],
        delegationPolicy: {
          ...defaultDelegationPolicy,
          targets: {
            agent: { definitionRevisionId: revisionId, definitionDigest: "a".repeat(64) },
          },
        },
      }}
    />,
  );
  const label = "Delegated execution profile";
  const profile = screen.getByRole("combobox", { name: label });
  expect(profile).toHaveAttribute("data-value", revisionId);
  expect(profile).toHaveTextContent("Unavailable — choose a replacement");
  fireEvent.click(profile);
  expect(
    screen.getByRole("option", { name: "Unavailable — choose a replacement" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("option", { name: revisionId })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "No execution profile" }));
  expect(profile).toHaveAttribute("data-value", "");
});

it("keeps repair eligibility on the intended review rule when another rule is renamed", () => {
  const reviewerPromptRevisionId = "655d0000-0000-4000-8000-000000000004";
  render(
    <Inspector
      node={1}
      initial={{
        ...initialGraph,
        nodes: [
          ...initialGraph.nodes,
          {
            id: "review",
            kind: "review",
            reviewerPromptRevisionId,
            ruleIds: ["security", "behavior"],
            repair: { edgeId: "repair", maxRepairs: 2, eligibleRuleIds: ["security"] },
          },
        ],
      }}
    />,
  );
  choose("Step kind", "Review");
  expect(screen.getByRole("combobox", { name: "Reviewer prompt revision" })).toHaveAttribute(
    "data-value",
    reviewerPromptRevisionId,
  );
  fireEvent.click(screen.getByText("behavior · Rule key"));
  const rule = screen.getByRole("textbox", { name: "Rule 2 ID" });
  const eligible = screen.getByRole("listbox", { name: "Rules eligible for repair" });
  fireEvent.change(rule, { target: { value: "security" } });
  expect(rule).toHaveAccessibleDescription(
    "Rule 2 ID “security” is already in use. Choose a unique ID.",
  );
  fireEvent.change(rule, { target: { value: "security-check" } });
  expect(eligible).toHaveValue(["security"]);
  expect(within(eligible).getByRole("option", { name: "security check" })).toHaveValue(
    "security-check",
  );
  expect(screen.getByRole("spinbutton", { name: "Maximum repairs" })).toHaveValue(2);
});

it("opens a join named constructor and edits only its own repository assignments", () => {
  const initial: WorkflowGraphDraft = {
    ...initialGraph,
    nodes: [makeNode("constructor", "join"), makeNode("integrate", "join")],
    repositorySets: {
      integrate: [
        {
          repositoryId: secondaryWriter.repositoryId,
          writerGrant: secondaryGrant,
          branchEdgeIds: [],
        },
      ],
    },
  };
  const { rerender } = render(<Inspector node={0} initial={initial} />);
  expect(screen.getByRole("button", { name: "Add secondary repository" })).toBeEnabled();
  const writer = { name: "Repository and exact writer grant" };
  expect(screen.queryByRole("combobox", writer)).toBeNull();

  rerender(<Inspector node={1} initial={initial} />);
  expect(screen.getByRole("combobox", writer)).toHaveTextContent(secondaryWriter.label);
  fireEvent.click(screen.getByRole("button", { name: "Remove secondary repository" }));
  expect(screen.queryByRole("combobox", writer)).toBeNull();
});

it("shows a branch agent's exact secondary grant until the join removes its assignment", () => {
  const graph: WorkflowGraphDraft = {
    ...initialGraph,
    entryNodeId: "split",
    nodes: [makeNode("split", "branch"), makeNode("build", "agent"), makeNode("integrate", "join")],
    edges: [
      { id: "work", from: "split", to: "build", kind: "branch", required: true },
      { id: "output", from: "build", to: "integrate", kind: "branch-result" },
    ],
    grants: [primaryGrant],
  };
  const initial = setEditorRepositoryWriters(graph, "integrate", [
    {
      repositoryId: secondaryWriter.repositoryId,
      writerGrant: secondaryGrant,
      branchEdgeIds: ["work"],
    },
  ]);
  const { rerender } = render(<Inspector node={1} initial={initial} />);
  const grant = () => screen.getByRole("combobox", { name: "Execution grant" });
  expect(grant()).toHaveTextContent(secondaryWriter.label);
  expect(grant()).toBeDisabled();
  expect(grant()).toHaveAttribute("data-value", secondaryGrant.id);

  rerender(<Inspector node={2} initial={initial} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove secondary repository" }));
  rerender(<Inspector node={1} initial={initial} />);
  expect(grant()).toBeEnabled();
  expect(grant()).toHaveTextContent("Use workflow default");
  choose("Execution grant", "Factory grant · Grant version 1");
  expect(grant()).toHaveAttribute("data-value", primaryGrant.id);
});

it("keeps connected route and loop choices when provisional Next edges share their targets", () => {
  render(
    <Inspector
      node={0}
      initial={{
        ...initialGraph,
        entryNodeId: "route",
        nodes: [
          makeNode("route", "route"),
          makeNode("selected", "human-gate"),
          makeNode("destination", "join"),
          makeNode("loop", "branch"),
          makeNode("unrelated", "deterministic"),
        ],
        edges: [
          { id: "selected", from: "route", to: "selected", kind: "route" },
          { id: "destination", from: "route", to: "destination", kind: "route" },
          { id: "loop", from: "route", to: "loop", kind: "loop", maxTraversals: 1 },
          { id: "next-allowed", from: "route", to: "selected", kind: "next" },
          { id: "next-fallback", from: "route", to: "destination", kind: "next" },
          { id: "next-loop", from: "route", to: "loop", kind: "next" },
          { id: "next-only", from: "route", to: "unrelated", kind: "next" },
        ],
        routePolicy: {
          maxNodeVisits: 8,
          maxLoopTraversals: 2,
          nodes: {
            route: {
              minimumConfidence: 0.5,
              allowedDestinationIds: ["selected"],
              fallback: { kind: "clarification" },
            },
          },
        },
      }}
    />,
  );
  const allowed = screen.getByRole("listbox", { name: "Allowed route destinations" });
  expect(
    within(allowed)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value),
  ).toEqual(["selected", "destination", "loop"]);
  expect(
    within(allowed).queryByRole("option", { name: /no longer eligible/i }),
  ).not.toBeInTheDocument();
  choose("Fallback", "Send to a step");
  const fallback = screen.getByRole("combobox", { name: "Fallback destination" });
  expect(fallback).toHaveAttribute("data-value", "destination");
  expect(allowed).toHaveValue(["selected"]);
  expect(within(allowed).queryByRole("option", { name: "Join" })).toBeNull();
  fireEvent.click(fallback);
  expect(
    within(screen.getByRole("listbox", { name: "Fallback destination" }))
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Select a step", "Join"]);
});

it("sets graph-wide limits with a loop and keeps them when a Route step is added", () => {
  render(
    <Inspector
      node={1}
      policies
      initial={{
        ...initialGraph,
        nodes: [...initialGraph.nodes, makeNode("check", "deterministic")],
        edges: [
          { id: "next", from: "checkpoint", to: "check", kind: "next" },
          { id: "repeat", from: "check", to: "checkpoint", kind: "loop", maxTraversals: 2 },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set workflow limits" }));
  const visits = screen.getByRole("spinbutton", { name: "Maximum workflow visits" });
  const traversals = screen.getByRole("spinbutton", { name: "Maximum total loop traversals" });
  fireEvent.change(visits, { target: { value: "41" } });
  fireEvent.change(traversals, { target: { value: "7" } });
  expect(visits).toHaveValue(41);
  expect(traversals).toHaveValue(7);

  choose("Step kind", "Route");
  expect(screen.getByLabelText("Minimum confidence")).toBeInTheDocument();
  expect(visits).toHaveValue(41);
  expect(traversals).toHaveValue(7);
});
