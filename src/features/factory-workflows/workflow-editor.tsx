"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  FactoryEditorRequestError,
  type EditorDiagnostic,
} from "@/features/factory-definition/editor-requests";
import type {
  WorkflowAuthoringCommand,
  WorkflowAuthoringSnapshot,
  WorkflowEditorCatalog,
  WorkflowReferenceKind,
  WorkflowReferencePage,
} from "@/lib/factory-workflows/authoring-contracts";
import { workflowTemplates } from "@/lib/factory-workflows/workflow-templates";
import { workspaceWorkflowDetailPath, workspaceWorkflowsPath } from "@/lib/routes";

import {
  loadCurrentWorkflowEditor,
  loadMoreWorkflowReferences,
  sameWorkflowEditorBase,
  submitWorkflowAuthoringCommand,
  workflowDraftNeedsRebase,
} from "./authoring-client";
import {
  EdgeFields,
  NodeFields,
  PolicyFields,
  WorkflowOptions,
  nodeOptions,
  workflowFieldId,
} from "./editor-fields";
import {
  deleteEditorNode,
  edgeLabels,
  initialGraph,
  makeNode,
  nextEditorId,
  nodeLabels,
  updateEditorEdge,
  workflowLayers,
  type WorkflowGraphDraft,
} from "./editor-graph";

import { TemplateSetup } from "./template-setup";

const panel = "min-w-0 rounded-lg border border-border bg-sheet p-4";
const nodeButton =
  "min-w-0 rounded-md border border-border bg-sheet text-left hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent aria-pressed:border-accent aria-pressed:bg-accent-soft";

function GraphCanvas({
  graph,
  selected,
  pick,
}: {
  graph: WorkflowGraphDraft;
  selected: number;
  pick: (index: number) => void;
}) {
  const layers = workflowLayers(graph);
  const boxWidth = 176;
  const boxHeight = 56;
  const horizontalGap = 68;
  const verticalGap = 24;
  const gutter = 16;
  const positions = new Map(
    layers.flatMap((layer, col) =>
      layer.map(
        (id, row) =>
          [
            id,
            {
              x: gutter + col * (boxWidth + horizontalGap),
              y: gutter + row * (boxHeight + verticalGap),
            },
          ] as const,
      ),
    ),
  );
  const width =
    2 * gutter + layers.length * boxWidth + Math.max(0, layers.length - 1) * horizontalGap;
  const height =
    2 * gutter +
    Math.max(1, ...layers.map((layer) => layer.length)) * (boxHeight + verticalGap) -
    verticalGap;
  return (
    <div
      className="max-w-full overflow-auto rounded-lg border border-border bg-canvas"
      aria-label="Workflow graph"
    >
      <div className="relative" style={{ width, height }}>
        {graph.edges.map((edge, index) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to || edge.from === edge.to) return null;
          const forward = to.x >= from.x;
          const x = from.x + (forward ? boxWidth : 0);
          const y = from.y + boxHeight / 2;
          const dx = to.x + (forward ? 0 : boxWidth) - x;
          const dy = to.y + boxHeight / 2 - y;
          return (
            <span
              key={index}
              aria-hidden="true"
              className={`pointer-events-none absolute origin-left border-t ${edge.kind === "loop" || edge.kind === "route" ? "border-dashed border-accent" : "border-border-strong"}`}
              style={{
                left: x,
                top: y,
                width: Math.hypot(dx, dy),
                transform: `rotate(${Math.atan2(dy, dx)}rad)`,
              }}
            >
              <span className="absolute -right-0.5 -top-1 size-2 rotate-45 border-r border-t border-current text-muted" />
            </span>
          );
        })}
        {layers.flat().map((id) => {
          const index = graph.nodes.findIndex((node) => node.id === id);
          const node = graph.nodes[index];
          const position = positions.get(id);
          if (!node || !position) return null;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected === index}
              className={`${nodeButton} absolute grid content-center gap-0.5 px-3`}
              onClick={() => pick(index)}
              style={{ left: position.x, top: position.y, width: boxWidth, height: boxHeight }}
            >
              <span className="truncate text-sm font-medium" title={id}>
                {id || "Unnamed step"}
              </span>
              <span className="truncate text-xs text-muted">
                {nodeLabels[node.kind]}
                {graph.entryNodeId === id ? " · Entry" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OrderedSteps({
  graph,
  selected,
  pick,
}: {
  graph: WorkflowGraphDraft;
  selected: number;
  pick: (index: number) => void;
}) {
  const rank = new Map(
    workflowLayers(graph)
      .flat()
      .map((id, position) => [id, position]),
  );
  const ordered = graph.nodes
    .map((node, index) => ({ node, index }))
    .sort(
      (left, right) =>
        (rank.get(left.node.id) ?? left.index) - (rank.get(right.node.id) ?? right.index),
    );
  return (
    <ol className="grid gap-2" aria-label="Ordered workflow steps">
      {ordered.map(({ node, index }) => {
        const outgoing = graph.edges.filter(({ from }) => from === node.id);
        return (
          <li key={index} className="min-w-0">
            <button
              type="button"
              className={`${nodeButton} grid w-full gap-1 px-3 py-2`}
              onClick={() => pick(index)}
              aria-pressed={selected === index}
            >
              <span className="wrap-anywhere text-sm font-medium">{node.id || "Unnamed step"}</span>
              <span className="wrap-anywhere text-xs text-muted">
                {nodeLabels[node.kind]}
                {graph.entryNodeId === node.id ? " · Entry" : ""}
              </span>
            </button>
            {outgoing.length ? (
              <ul
                className="ml-3 border-l border-border pl-3 pt-1 text-xs text-muted"
                aria-label={`Outgoing transitions from ${node.id}`}
              >
                {outgoing.map((edge, edgeIndex) => (
                  <li key={edgeIndex} className="wrap-anywhere py-0.5">
                    {edgeLabels[edge.kind]} → {edge.to}
                    {edge.kind === "loop" ? ` · ${edge.maxTraversals} max` : ""}
                    {edge.kind === "branch" ? (edge.required ? " · Required" : " · Optional") : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

const diagnosticLabels = {
  entryNodeId: "Entry step",
  nodes: "Step",
  edges: "Transition",
  routePolicy: "Route policy",
  delegationPolicy: "Delegation policy",
  grants: "Grants",
  repositorySets: "Repository writers",
} as Readonly<Record<string, string>>;

function diagnosticLabel(path: EditorDiagnostic["path"], graph: WorkflowGraphDraft) {
  const [key, index] = path;
  if (key === "nodes" && typeof index === "number") return graph.nodes[index]?.id || "Step";
  if (key === "edges" && typeof index === "number") return graph.edges[index]?.id || "Transition";
  return diagnosticLabels[String(key)] ?? "Workflow";
}

type Notice = { kind: "status" | "alert"; message: string };
type DraftAction = "save" | "publish" | "reload";
const catalogLabels = {
  prompts: "prompt revisions",
  approvers: "approvers",
  profiles: "execution profiles",
  writers: "repository writers",
} satisfies Record<WorkflowReferenceKind, string>;

function appendReferencePage(choices: WorkflowEditorCatalog, page: WorkflowReferencePage) {
  const seen = new Set(choices[page.catalog].map(({ id }) => id));
  return {
    ...choices,
    [page.catalog]: [...choices[page.catalog], ...page.items.filter(({ id }) => !seen.has(id))],
    nextCursors: { ...choices.nextCursors, [page.catalog]: page.nextCursor },
  };
}

export function WorkflowEditor({
  initial,
  endpoint,
  workspaceSlug,
  factoryId,
  choices: initialChoices,
}: {
  initial: WorkflowAuthoringSnapshot;
  endpoint: string;
  workspaceSlug: string;
  factoryId: string;
  choices: WorkflowEditorCatalog;
}) {
  const historical = initial.selectedDraftId !== null;
  const initialValue = initial.selectedDraftGraph ?? initial.graph ?? initialGraph;
  const [graph, setGraph] = useState<WorkflowGraphDraft>(initialValue);
  const [{ snapshot, choices }, setEditorData] = useState({
    snapshot: initial,
    choices: initialChoices,
  });
  const [view, setView] = useState<"Graph" | "Ordered list">("Graph");
  const [nodeIndex, setNodeIndex] = useState(0);
  const [edgeIndex, setEdgeIndex] = useState(0);
  const [diagnostics, setDiagnostics] = useState<EditorDiagnostic[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [action, setAction] = useState<DraftAction | WorkflowReferenceKind | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ fieldId: string } | null>(null);
  const commandRef = useRef<WorkflowAuthoringCommand | null>(null);
  const submitting = useRef(false);
  const dirty =
    JSON.stringify(graph) !==
    JSON.stringify(snapshot.selectedDraftGraph ?? snapshot.graph ?? initialGraph);
  const rebase = workflowDraftNeedsRebase(snapshot);
  const readOnly = historical || !snapshot.baseDefinition;
  const editorProps = { graph, edit: setGraph, diagnostics };
  const currentDraftId = snapshot.draftId;
  const template = workflowTemplates.find(
    ({ id, version }) => id === snapshot.template?.id && version === snapshot.template.version,
  );
  const configuringTemplate = !!template && !snapshot.draftId && graph === initialGraph;
  const canPublish =
    !rebase && !dirty && !!currentDraftId && currentDraftId !== snapshot.publishedDraftId;
  const selectedNode = graph.nodes[nodeIndex];
  const stepCatalogs: WorkflowReferenceKind[] = [];
  if (selectedNode?.kind === "agent" || selectedNode?.kind === "route") {
    stepCatalogs.push("prompts", "profiles");
  }
  if (selectedNode?.kind === "review") stepCatalogs.push("prompts");
  if (selectedNode?.kind === "join") stepCatalogs.push("writers");
  if (selectedNode?.kind === "human-gate" && !selectedNode.anyoneCanApprove) {
    stepCatalogs.push("approvers");
  }

  useEffect(() => {
    if (!focusRequest) return;
    const element =
      document.getElementById(focusRequest.fieldId) ??
      document.getElementById("workflow-diagnostics");
    const details = element?.closest("details");
    if (details) details.open = true;
    element?.focus();
  }, [focusRequest]);

  function focusDiagnostic(path: EditorDiagnostic["path"]) {
    const [, index] = path;
    if (path[0] === "nodes" && typeof index === "number") setNodeIndex(index);
    if (path[0] === "edges" && typeof index === "number") setEdgeIndex(index);
    if (
      typeof path[2] === "string" &&
      (path[0] === "routePolicy" || path[0] === "delegationPolicy")
    ) {
      const node = graph.nodes.findIndex(({ id }) => id === path[2]);
      if (node !== -1) setNodeIndex(node);
    }
    if (path[0] === "repositorySets" && typeof index === "string") {
      const join = graph.nodes.findIndex(({ id }) => id === index);
      if (join !== -1) setNodeIndex(join);
    }
    setFocusRequest({ fieldId: workflowFieldId(path) });
  }

  async function loadMoreReferences(catalog: WorkflowReferenceKind) {
    const cursor = choices.nextCursors[catalog];
    if (submitting.current || cursor === null) return;
    submitting.current = true;
    setAction(catalog);
    setNotice(null);
    try {
      const page = await loadMoreWorkflowReferences(endpoint, catalog, cursor);
      setEditorData((current) => ({
        ...current,
        choices: appendReferencePage(current.choices, page),
      }));
      setNotice({ kind: "status", message: `More ${catalogLabels[catalog]} loaded.` });
    } catch (failure) {
      setNotice({
        kind: "alert",
        message: failure instanceof Error ? failure.message : "Could not load more references.",
      });
    } finally {
      submitting.current = false;
      setAction(null);
    }
  }

  async function run(nextAction: DraftAction) {
    if (submitting.current || (nextAction !== "reload" && readOnly)) return;
    submitting.current = true;
    setAction(nextAction);
    setNotice(null);
    setDiagnostics([]);
    setFocusRequest(null);
    try {
      if (nextAction === "reload") {
        const latest = await loadCurrentWorkflowEditor(endpoint);
        setEditorData((current) =>
          sameWorkflowEditorBase(current.snapshot.baseDefinition, latest.snapshot.baseDefinition)
            ? { ...current, snapshot: latest.snapshot }
            : latest,
        );
        setGraph(latest.snapshot.graph ?? initialGraph);
        setNodeIndex(0);
        setEdgeIndex(0);
        setHasConflict(false);
        commandRef.current = null;
        setNotice({ kind: "status", message: "Current draft loaded." });
        return;
      }
      const baseDefinition = snapshot.baseDefinition;
      if (!baseDefinition) return;
      const expected = {
        draftId: snapshot.draftId,
        activationId: snapshot.activationId,
        baseDefinition,
      };
      const command =
        nextAction === "save"
          ? { action: "save" as const, expected, graph, rebase }
          : currentDraftId && canPublish
            ? { action: "publish" as const, expected: { ...expected, draftId: currentDraftId } }
            : null;
      if (!command) return;
      const prior = commandRef.current;
      const reusable =
        prior && JSON.stringify({ ...prior, requestId: undefined }) === JSON.stringify(command);
      const captured: WorkflowAuthoringCommand = reusable
        ? prior
        : { ...command, requestId: crypto.randomUUID() };
      commandRef.current = captured;
      const result = await submitWorkflowAuthoringCommand(endpoint, initial.workflowId, captured);
      commandRef.current = null;
      if (result.moved) {
        setHasConflict(true);
        setNotice({
          kind: "alert",
          message:
            "The draft, publication, or base definition changed. Load the current draft before editing again.",
        });
        return;
      }
      const savedGraph = result.snapshot.graph ?? initialGraph;
      setEditorData((current) => ({
        ...current,
        snapshot: { ...result.snapshot, selectedDraftGraph: null, selectedDraftId: null },
      }));
      setGraph(savedGraph);
      setNodeIndex(
        Math.max(
          0,
          savedGraph.nodes.findIndex(({ id }) => id === graph.nodes[nodeIndex]?.id),
        ),
      );
      setEdgeIndex(
        Math.max(
          0,
          savedGraph.edges.findIndex(({ id }) => id === graph.edges[edgeIndex]?.id),
        ),
      );
      setHasConflict(false);
      setNotice({
        kind: "status",
        message: nextAction === "publish" ? "Workflow published." : "Draft saved.",
      });
    } catch (failure) {
      if (failure instanceof FactoryEditorRequestError) {
        if (failure.status < 500) commandRef.current = null;
        if (failure.status === 409) setHasConflict(true);
        setDiagnostics(failure.diagnostics);
        if (failure.diagnostics.length) focusDiagnostic(failure.diagnostics[0]!.path);
      }
      setNotice({
        kind: "alert",
        message: failure instanceof Error ? failure.message : "The workflow could not be updated.",
      });
    } finally {
      submitting.current = false;
      setAction(null);
    }
  }

  function addStep() {
    const id = nextEditorId("step", graph.nodes);
    setGraph({
      ...graph,
      nodes: [...graph.nodes, makeNode(id, "deterministic")],
      entryNodeId: graph.entryNodeId || id,
    });
    setNodeIndex(graph.nodes.length);
    setFocusRequest({ fieldId: workflowFieldId(["nodes", graph.nodes.length, "id"]) });
  }

  function removeStep() {
    const next = deleteEditorNode(graph, nodeIndex);
    const survivor = Math.min(nodeIndex, next.nodes.length - 1);
    setGraph(next);
    setNodeIndex(Math.max(0, survivor));
    setEdgeIndex(0);
    setFocusRequest({
      fieldId: survivor < 0 ? "workflow-add-step" : workflowFieldId(["nodes", survivor, "id"]),
    });
  }

  function addTransition() {
    const from = graph.nodes[nodeIndex]?.id ?? graph.nodes[0]?.id;
    const to = graph.nodes.find(({ id }) => id !== from)?.id;
    if (!from || !to) return;
    setGraph({
      ...graph,
      edges: [
        ...graph.edges,
        { id: nextEditorId("transition", graph.edges), kind: "next", from, to },
      ],
    });
    setEdgeIndex(graph.edges.length);
    setFocusRequest({ fieldId: workflowFieldId(["edges", graph.edges.length, "kind"]) });
  }

  const pageFor = (draft?: string) =>
    workspaceWorkflowDetailPath(workspaceSlug, initial.workflowId, { factory: factoryId, draft });

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-5 px-4 py-6 sm:px-6">
      <header className="grid gap-3 border-b border-border pb-4">
        <Link
          className="w-fit text-sm text-muted underline underline-offset-4"
          href={workspaceWorkflowsPath(workspaceSlug, { factory: factoryId })}
        >
          All workflows
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="type-page-title wrap-anywhere">{initial.displayName}</h1>
            {template ? (
              <p className="mt-1 text-sm text-muted">
                {template.label} · v{template.version}
              </p>
            ) : null}
            <p className="mt-1 text-sm text-muted">
              {historical
                ? "Saved draft · Read only"
                : snapshot.activationId
                  ? "Published workflow"
                  : "Unpublished workflow"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Draft actions">
            {!historical && (snapshot.draftId || hasConflict) ? (
              <button
                type="button"
                className="ui-button"
                disabled={!!action}
                onClick={() => void run("reload")}
              >
                Load current draft
              </button>
            ) : null}
            {historical ? (
              <Link className="ui-button" href={pageFor()}>
                Open current draft
              </Link>
            ) : null}
            {!readOnly ? (
              <>
                <button
                  type="button"
                  className="ui-button"
                  disabled={
                    !!action ||
                    hasConflict ||
                    configuringTemplate ||
                    (!!snapshot.draftId && !dirty && !rebase)
                  }
                  onClick={() => void run("save")}
                >
                  {action === "save" ? "Saving…" : rebase ? "Rebase and save draft" : "Save draft"}
                </button>
                <button
                  type="button"
                  className="ui-button-primary"
                  disabled={!!action || hasConflict || !canPublish}
                  onClick={() => void run("publish")}
                >
                  {action === "publish" ? "Publishing…" : "Publish draft"}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {!snapshot.baseDefinition ? (
        <p className="text-sm text-muted">Activate a factory definition to edit this workflow.</p>
      ) : rebase && !historical ? (
        <p className="rounded-md border border-border bg-warning-soft px-4 py-3 text-sm">
          The factory definition changed. Rebase this draft before publishing.
        </p>
      ) : null}

      {notice ? (
        <div
          id="workflow-diagnostics"
          tabIndex={-1}
          role={notice.kind}
          className={`rounded-md border border-border px-4 py-3 text-sm ${notice.kind === "alert" ? "bg-danger-soft" : "bg-success-soft"}`}
        >
          <p>{notice.message}</p>
          {diagnostics.length ? (
            <ul className="mt-2 list-inside list-disc space-y-1">
              {diagnostics.map(({ path, message }, index) => (
                <li key={index}>
                  <button
                    type="button"
                    className="wrap-anywhere text-left underline underline-offset-4"
                    onClick={() => focusDiagnostic(path)}
                  >
                    {diagnosticLabel(path, graph)} · {message}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {configuringTemplate && snapshot.template ? (
        <TemplateSetup
          template={snapshot.template}
          choices={choices}
          disabled={readOnly || !!action}
          loadMore={(catalog) => void loadMoreReferences(catalog)}
          apply={(nextGraph) => {
            setGraph(nextGraph);
            setNodeIndex(0);
            setEdgeIndex(0);
            setNotice({
              kind: "status",
              message: "Template loaded. Save a draft to retain these roles.",
            });
            setFocusRequest({ fieldId: workflowFieldId(["nodes", 0, "id"]) });
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              className="flex w-fit flex-wrap gap-1 rounded-lg border border-border bg-sheet p-1"
              role="group"
              aria-label="Workflow editor view"
            >
              {(["Graph", "Ordered list"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={view === candidate}
                  className="ui-button min-h-8 border-transparent px-3 aria-pressed:bg-accent-soft aria-pressed:text-foreground"
                  onClick={() => setView(candidate)}
                >
                  {candidate}
                </button>
              ))}
            </div>
            {snapshot.publishedDraftId && snapshot.publishedDraftId !== initial.selectedDraftId ? (
              <Link
                className="text-sm text-muted underline underline-offset-4"
                href={pageFor(snapshot.publishedDraftId)}
              >
                Inspect published draft
              </Link>
            ) : null}
          </div>

          {view === "Graph" ? (
            <GraphCanvas graph={graph} selected={nodeIndex} pick={setNodeIndex} />
          ) : null}

          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(15rem,0.65fr)_minmax(0,1.35fr)]">
            <section className={panel} aria-label="Workflow steps">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">Steps</h2>
                {!readOnly ? (
                  <button
                    id="workflow-add-step"
                    type="button"
                    className="ui-button"
                    onClick={addStep}
                    disabled={!!action || graph.nodes.length >= 128}
                  >
                    Add step
                  </button>
                ) : null}
              </div>
              <fieldset className="mb-3" disabled={readOnly || !!action}>
                <WorkflowOptions
                  label="Entry step"
                  path={["entryNodeId"]}
                  diagnostics={diagnostics}
                  options={nodeOptions(graph.nodes)}
                  value={graph.entryNodeId}
                  change={(entryNodeId) => setGraph({ ...graph, entryNodeId })}
                />
              </fieldset>
              <OrderedSteps graph={graph} selected={nodeIndex} pick={setNodeIndex} />
            </section>

            <section className={panel} aria-label="Step properties">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">Step properties</h2>
                {!readOnly && graph.nodes[nodeIndex] ? (
                  <button
                    type="button"
                    className="ui-button"
                    disabled={!!action}
                    onClick={removeStep}
                  >
                    Remove step
                  </button>
                ) : null}
              </div>
              <fieldset disabled={readOnly || !!action}>
                <NodeFields {...editorProps} index={nodeIndex} choices={choices} />
              </fieldset>
              {!readOnly ? (
                <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
                  {stepCatalogs
                    .filter((catalog) => choices.nextCursors[catalog] !== null)
                    .map((catalog) => (
                      <button
                        key={catalog}
                        type="button"
                        className="ui-button"
                        disabled={!!action}
                        onClick={() => void loadMoreReferences(catalog)}
                      >
                        {action === catalog
                          ? `Loading ${catalogLabels[catalog]}…`
                          : `Load more ${catalogLabels[catalog]}`}
                      </button>
                    ))}
                </div>
              ) : null}
            </section>
          </div>

          <section className={panel} aria-label="Workflow transitions">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">Transitions</h2>
              {!readOnly ? (
                <button
                  type="button"
                  className="ui-button"
                  onClick={addTransition}
                  disabled={!!action || graph.nodes.length < 2 || graph.edges.length >= 512}
                >
                  Add transition
                </button>
              ) : null}
            </div>
            {graph.edges.length ? (
              <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(15rem,0.65fr)_minmax(0,1.35fr)]">
                <ol className="grid content-start gap-2">
                  {graph.edges.map((edge, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        className={`${nodeButton} grid w-full gap-1 px-3 py-2`}
                        aria-pressed={edgeIndex === index}
                        onClick={() => setEdgeIndex(index)}
                      >
                        <span className="wrap-anywhere text-sm font-medium">
                          {edge.id || "Unnamed transition"}
                        </span>
                        <span className="wrap-anywhere text-xs text-muted">
                          {edge.from} → {edge.to} · {edgeLabels[edge.kind]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                <div>
                  <fieldset disabled={readOnly || !!action}>
                    <EdgeFields {...editorProps} index={edgeIndex} />
                  </fieldset>
                  {!readOnly && graph.edges[edgeIndex] ? (
                    <button
                      type="button"
                      className="ui-button mt-3"
                      disabled={!!action}
                      onClick={() => {
                        setGraph(updateEditorEdge(graph, edgeIndex));
                        setEdgeIndex(Math.max(0, Math.min(edgeIndex, graph.edges.length - 2)));
                      }}
                    >
                      Remove transition
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">No transitions.</p>
            )}
          </section>

          <details className={panel}>
            <summary className="cursor-pointer font-medium">Workflow policies</summary>
            <fieldset className="mt-4" disabled={readOnly || !!action}>
              <PolicyFields {...editorProps} choices={choices} />
            </fieldset>
          </details>
        </>
      )}
      {snapshot.recentDrafts.length ? (
        <details className={panel}>
          <summary className="cursor-pointer text-sm font-medium">Recent drafts</summary>
          <ol className="mt-3 flex flex-wrap gap-2">
            {snapshot.recentDrafts.map(({ id, revision }) => (
              <li key={id}>
                <Link
                  className="ui-button min-h-8"
                  href={pageFor(id)}
                  aria-current={id === initial.selectedDraftId ? "page" : undefined}
                >
                  Draft {revision}
                  {id === snapshot.publishedDraftId ? " · Published" : ""}
                </Link>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
