// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";

import { EdgeFields, NodeFields } from "./editor-fields";
import {
  defaultDelegationPolicy,
  initialGraph,
  makeNode,
  type WorkflowGraphDraft,
} from "./editor-graph";

afterEach(cleanup);

function Inspector({
  initial,
  node,
  edge,
}: {
  initial: WorkflowGraphDraft;
  node: number;
  edge?: number;
}) {
  const [graph, edit] = useState(initial);
  const fields = { graph, edit, diagnostics: [] };
  return (
    <>
      <NodeFields
        {...fields}
        index={node}
        choices={{ prompts: [], approvers: [], profiles: [], grant: null }}
      />
      {edge === undefined ? null : <EdgeFields {...fields} index={edge} />}
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
  const id = screen.getByRole("textbox", { name: "Step ID" });
  const target = screen.getByRole("combobox", { name: "To step" });
  fireEvent.change(id, { target: { value: "checkpoint" } });
  expect(id).toHaveValue("checkpoint");
  expect(id).toHaveAccessibleDescription(
    "Step ID “checkpoint” is already in use. Choose a unique ID.",
  );
  expect(target).toHaveTextContent("review");
  fireEvent.blur(id);
  expect(id).toHaveValue("review");
  fireEvent.change(id, { target: { value: "checkpoint" } });
  fireEvent.change(id, { target: { value: "checkpoint-review" } });
  expect(target).toHaveTextContent("checkpoint-review");
  expect(id).not.toHaveAttribute("aria-invalid");
});

it("preserves a selected execution profile when its catalog page is unavailable", () => {
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
  choose(label, revisionId);
  expect(screen.getByRole("combobox", { name: label })).toHaveTextContent(revisionId);
});
