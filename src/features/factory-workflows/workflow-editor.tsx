"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
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
import { workflowEditorReferencePins } from "@/lib/factory-workflows/editor-reference-pins";
import { workflowTemplates } from "@/lib/factory-workflows/workflow-templates";
import {
  workspaceFactoryDefinitionPath,
  workspaceGovernancePath,
  workspaceWorkflowDetailPath,
  workspaceWorkflowsPath,
} from "@/lib/routes";

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
  transitionName,
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
import {
  emptyTemplateRoles,
  useWorkflowDraftRecovery,
  writeWorkflowDraftRecovery,
  type DraftRecovery,
} from "./editor-recovery";
import { TemplateSetup } from "./template-setup";

const panel = "min-w-0 rounded-lg border border-border bg-sheet p-4";
const nodeButton =
  "min-w-0 rounded-md border border-border bg-sheet text-left hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent aria-pressed:border-accent aria-pressed:bg-accent-soft";

function GraphCanvas({
  graph,
  selected,
  pick,
  names,
}: {
  graph: WorkflowGraphDraft;
  selected: number;
  pick: (index: number) => void;
  names: ReturnType<typeof nodeOptions>;
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
              <span className="truncate text-sm font-medium" title={names[index]?.label}>
                {names[index]?.label}
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
  names,
}: {
  graph: WorkflowGraphDraft;
  selected: number;
  pick: (index: number) => void;
  names: ReturnType<typeof nodeOptions>;
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
              <span className="wrap-anywhere text-sm font-medium">{names[index]?.label}</span>
              <span className="wrap-anywhere text-xs text-muted">
                {nodeLabels[node.kind]}
                {graph.entryNodeId === node.id ? " · Entry" : ""}
              </span>
            </button>
            {outgoing.length ? (
              <ul
                className="ml-3 border-l border-border pl-3 pt-1 text-xs text-muted"
                aria-label={`Outgoing transitions from ${names[index]?.label}`}
              >
                {outgoing.map((edge, edgeIndex) => (
                  <li key={edgeIndex} className="wrap-anywhere py-0.5">
                    {edgeLabels[edge.kind]} →{" "}
                    {names.find(({ id }) => id === edge.to)?.label ?? "Unavailable step"}
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

function diagnosticLabel(
  path: EditorDiagnostic["path"],
  graph: WorkflowGraphDraft,
  names: ReturnType<typeof nodeOptions>,
) {
  const [key, index] = path;
  if (key === "nodes" && typeof index === "number") return names[index]?.label || "Step";
  if (key === "edges" && typeof index === "number" && graph.edges[index])
    return transitionName(graph.edges[index], names);
  return diagnosticLabels[String(key)] ?? "Workflow";
}

type Notice = { kind: "status" | "alert"; message: string };
type DraftAction = "save" | "publish" | "reload";
type RecoverySource = "working" | "kept";
type DraftConfirmation =
  | { kind: "reload" }
  | { kind: "restore"; source: RecoverySource }
  | { kind: "leave"; proceed: () => void };
type BrowserNavigation = EventTarget & {
  traverseTo: (key: string) => { finished: Promise<unknown> };
};
type TraversalEvent = Event & {
  navigationType: string;
  destination: { key: string; url: string; sameDocument: boolean };
};
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

function refreshReferenceChoices(
  previous: WorkflowEditorCatalog,
  latest: WorkflowEditorCatalog,
  snapshot: WorkflowAuthoringSnapshot,
) {
  const pins = workflowEditorReferencePins(snapshot.graph);
  function keepPaged<Choice extends { id: string }>(
    kind: WorkflowReferenceKind,
    prior: Choice[],
    fresh: Choice[],
  ) {
    const seen = new Set(fresh.map(({ id }) => id));
    return [...fresh, ...prior.filter(({ id }) => !seen.has(id) && !pins[kind].has(id))];
  }
  return {
    ...latest,
    prompts: keepPaged("prompts", previous.prompts, latest.prompts),
    profiles: keepPaged("profiles", previous.profiles, latest.profiles),
    nextCursors: {
      ...latest.nextCursors,
      prompts: previous.nextCursors.prompts,
      profiles: previous.nextCursors.profiles,
    },
  };
}

export function WorkflowEditor({
  initial,
  endpoint,
  workspaceSlug,
  factoryId,
  recoveryOwner,
  choices: initialChoices,
}: {
  initial: WorkflowAuthoringSnapshot;
  endpoint: string;
  workspaceSlug: string;
  factoryId: string;
  recoveryOwner: string;
  choices: WorkflowEditorCatalog;
}) {
  const router = useRouter();
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
  const [roles, setRoles] = useState(emptyTemplateRoles);
  const [confirmation, setConfirmation] = useState<DraftConfirmation | null>(null);
  const confirmationOrigin = useRef<HTMLElement | null>(null);
  const editorTitle = useRef<HTMLHeadingElement>(null);
  const restoredKeptCopy = useRef(false);
  const hadDirtyEdits = useRef(false);
  const [focusRequest, setFocusRequest] = useState<{ fieldId: string } | null>(null);
  const commandRef = useRef<WorkflowAuthoringCommand | null>(null);
  const submitting = useRef(false);
  const graphJson = JSON.stringify(graph);
  const graphDirty =
    graphJson !== JSON.stringify(snapshot.selectedDraftGraph ?? snapshot.graph ?? initialGraph);
  const rebase = workflowDraftNeedsRebase(snapshot);
  const readOnly = historical || !snapshot.baseDefinition;
  const editorProps = { graph, edit: setGraph, diagnostics };
  const currentDraftId = snapshot.draftId;
  const template = workflowTemplates.find(
    ({ id, version }) => id === snapshot.template?.id && version === snapshot.template.version,
  );
  const configuringTemplate =
    !!template && !snapshot.draftId && graphJson === JSON.stringify(initialGraph);
  const dirty =
    !historical && (graphDirty || (configuringTemplate && Object.values(roles).some(Boolean)));
  const recoveryKey = `wallie:workflow-draft:v1:${recoveryOwner}:${endpoint}`;
  const keptRecoveryKey = `${recoveryKey}:kept`;
  const workingRecovery = useWorkflowDraftRecovery(recoveryKey);
  const keptRecovery = useWorkflowDraftRecovery(keptRecoveryKey);
  const copy: DraftRecovery = {
    graph,
    roles,
    draftId: snapshot.draftId,
    activationId: snapshot.activationId,
    baseActivationId: snapshot.baseDefinition?.activationId ?? null,
  };
  const recoveryPayload = dirty ? JSON.stringify(copy) : null;
  const currentRevision = snapshot.recentDrafts.find(({ id }) => id === currentDraftId)?.revision;
  const liveRevision = snapshot.recentDrafts.find(
    ({ id }) => id === snapshot.publishedDraftId,
  )?.revision;
  const selectedRevision = snapshot.recentDrafts.find(
    ({ id }) => id === snapshot.selectedDraftId,
  )?.revision;
  const live = snapshot.publishedDraftId !== null;
  const viewingLive = historical && snapshot.selectedDraftId === snapshot.publishedDraftId;
  const publishReason = hasConflict
    ? "Load the latest draft before publishing."
    : rebase
      ? "The factory definition changed. Rebase and save before publishing."
      : !currentDraftId
        ? "Save a draft before publishing."
        : dirty
          ? "Save your changes before publishing."
          : currentDraftId === snapshot.publishedDraftId
            ? "This draft is already live for new sessions."
            : null;
  const names = nodeOptions(graph.nodes, choices.prompts);
  const settingsHref = workspaceFactoryDefinitionPath(workspaceSlug, { factory: factoryId });
  const grantsHref = `${workspaceGovernancePath(workspaceSlug, { factory: factoryId })}#execution-grants`;
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
    if (recoveryPayload) writeWorkflowDraftRecovery(recoveryKey, recoveryPayload);
    else if (hadDirtyEdits.current) writeWorkflowDraftRecovery(recoveryKey, null);
    hadDirtyEdits.current = !!recoveryPayload;
  }, [recoveryKey, recoveryPayload]);

  useEffect(() => {
    if (!dirty) return;
    const warnOnUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    const guardLink = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (
        !anchor ||
        (anchor.target && anchor.target.toLowerCase() !== "_self") ||
        anchor.hasAttribute("download")
      )
        return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.protocol !== window.location.protocol ||
        destination.pathname.startsWith("//") ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      )
        return;
      event.preventDefault();
      const href = destination.pathname + destination.search + destination.hash;
      confirmationOrigin.current = anchor;
      setConfirmation({ kind: "leave", proceed: () => router.push(href) });
    };
    const navigation = (window as Window & { navigation?: BrowserNavigation }).navigation;
    let permittedKey: string | null = null;
    const guardHistory = (event: Event) => {
      const { navigationType, destination } = event as TraversalEvent;
      if (navigationType !== "traverse" || !destination?.sameDocument || !event.cancelable) return;
      const target = new URL(destination.url);
      if (target.pathname === window.location.pathname && target.search === window.location.search)
        return;
      if (permittedKey === destination.key) {
        permittedKey = null;
        return;
      }
      event.preventDefault();
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      confirmationOrigin.current = focused;
      setConfirmation({
        kind: "leave",
        proceed: () => {
          if (!navigation) return;
          permittedKey = destination.key;
          void navigation.traverseTo(destination.key).finished.catch(() => {
            permittedKey = null;
          });
        },
      });
    };
    window.addEventListener("beforeunload", warnOnUnload);
    document.addEventListener("click", guardLink, true);
    navigation?.addEventListener("navigate", guardHistory);
    return () => {
      window.removeEventListener("beforeunload", warnOnUnload);
      document.removeEventListener("click", guardLink, true);
      navigation?.removeEventListener("navigate", guardHistory);
    };
  }, [dirty, router]);

  useEffect(() => {
    if (!focusRequest) return;
    let element = document.getElementById(focusRequest.fieldId);
    if (!element || element.matches(":disabled")) {
      element =
        (focusRequest.fieldId.endsWith("-grantId")
          ? document.getElementById("workflow-edit-join")
          : null) ?? document.getElementById("workflow-diagnostics");
    }
    for (
      let details = element?.closest("details");
      details;
      details = details.parentElement?.closest("details")
    ) {
      details.open = true;
    }
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
      if (failure instanceof FactoryEditorRequestError && failure.status === 409)
        setHasConflict(true);
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
            ? {
                snapshot: latest.snapshot,
                choices: refreshReferenceChoices(current.choices, latest.choices, latest.snapshot),
              }
            : latest,
        );
        if (dirty) writeWorkflowDraftRecovery(recoveryKey, null);
        restoredKeptCopy.current = false;
        setGraph(latest.snapshot.graph ?? initialGraph);
        setRoles(emptyTemplateRoles);
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
          : currentDraftId && !publishReason
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
            "The draft, live revision, or factory definition changed. Your edits are still here. Load the latest draft to continue.",
        });
        return;
      }
      const savedGraph = result.snapshot.graph ?? initialGraph;
      if (nextAction === "save") {
        writeWorkflowDraftRecovery(recoveryKey, null);
        if (restoredKeptCopy.current) writeWorkflowDraftRecovery(keptRecoveryKey, null);
        restoredKeptCopy.current = false;
      }
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
        message:
          failure instanceof FactoryEditorRequestError && failure.status === 409
            ? "The draft, live revision, or factory definition changed. Your edits are still here. Load the latest draft to continue."
            : failure instanceof Error
              ? failure.message
              : "The workflow could not be updated.",
      });
    } finally {
      submitting.current = false;
      setAction(null);
    }
  }

  function requestConfirmation(next: DraftConfirmation, origin: HTMLElement) {
    confirmationOrigin.current = origin;
    setConfirmation(next);
  }

  const recovery =
    confirmation?.kind === "restore"
      ? confirmation.source === "kept"
        ? keptRecovery
        : workingRecovery
      : null;

  function confirmDraftAction(keepCopy = false) {
    if (!confirmation) return;
    if (keepCopy && !writeWorkflowDraftRecovery(keptRecoveryKey, recoveryPayload)) {
      setNotice({
        kind: "alert",
        message: "This tab couldn’t store a recovery copy. Your edits are still here.",
      });
      setConfirmation(null);
      return;
    }
    setConfirmation(null);
    if (confirmation.kind === "leave") {
      writeWorkflowDraftRecovery(recoveryKey, null);
      confirmation.proceed();
    } else if (confirmation.kind === "reload") {
      void run("reload");
    } else if (recovery) {
      restoredKeptCopy.current = confirmation.source === "kept";
      setGraph(recovery.graph);
      setRoles(recovery.roles);
      setNodeIndex(0);
      setEdgeIndex(0);
      setNotice({
        kind: "status",
        message: "Recovery copy restored as unsaved edits. Review them before saving.",
      });
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
    setFocusRequest({ fieldId: workflowFieldId(["nodes", graph.nodes.length, "kind"]) });
  }

  function removeStep() {
    const next = deleteEditorNode(graph, nodeIndex);
    const survivor = Math.min(nodeIndex, next.nodes.length - 1);
    setGraph(next);
    setNodeIndex(Math.max(0, survivor));
    setEdgeIndex(0);
    setFocusRequest({
      fieldId: survivor < 0 ? "workflow-add-step" : workflowFieldId(["nodes", survivor, "kind"]),
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
  const recoveryHasOlderHead =
    recovery &&
    (recovery.draftId !== snapshot.draftId ||
      recovery.activationId !== snapshot.activationId ||
      recovery.baseActivationId !== (snapshot.baseDefinition?.activationId ?? null));

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
            <h1 ref={editorTitle} tabIndex={-1} className="type-page-title wrap-anywhere">
              {initial.displayName}
            </h1>
            {template ? (
              <p className="mt-1 text-sm text-muted">
                {template.label} · v{template.version}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <span className="font-medium">
                {historical
                  ? `Saved draft${selectedRevision ? ` ${selectedRevision}` : ""} · Read only`
                  : currentDraftId
                    ? `${readOnly ? "Current" : "Editing"} draft${currentRevision ? ` ${currentRevision}` : ""}`
                    : readOnly
                      ? "No saved draft"
                      : "Editing new draft"}
              </span>
              <span
                className={
                  live ? "rounded bg-accent-soft px-2 py-0.5 text-foreground" : "text-muted"
                }
              >
                {live ? `Live revision${liveRevision ? ` ${liveRevision}` : ""}` : "Not published"}
                {viewingLive ? " · Viewing live" : ""}
              </span>
              {live && !viewingLive && historical ? (
                <span className="text-muted">Viewing an inactive revision</span>
              ) : null}
            </div>
            {!historical ? (
              <p className="mt-2 text-sm font-medium" role="status">
                {dirty ? "Unsaved changes" : ""}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Draft actions">
            {!historical && (snapshot.draftId || hasConflict) ? (
              <button
                type="button"
                className="ui-button"
                disabled={!!action}
                onClick={(event) => {
                  if (dirty) requestConfirmation({ kind: "reload" }, event.currentTarget);
                  else void run("reload");
                }}
              >
                {action === "reload" ? "Loading latest draft…" : "Load current draft"}
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
                    (!!snapshot.draftId && !graphDirty && !rebase)
                  }
                  onClick={() => void run("save")}
                >
                  {action === "save" ? "Saving…" : rebase ? "Rebase and save draft" : "Save draft"}
                </button>
                <button
                  type="button"
                  className="ui-button-primary"
                  disabled={!!action || !!publishReason}
                  aria-describedby="workflow-publish-help"
                  onClick={() => void run("publish")}
                >
                  {action === "publish"
                    ? "Publishing…"
                    : `Publish draft${currentRevision ? ` ${currentRevision}` : ""}`}
                </button>
              </>
            ) : null}
          </div>
        </div>
        {!readOnly ? (
          <p id="workflow-publish-help" className="text-sm text-muted">
            {publishReason ??
              "Publishing makes this revision available for new sessions. Existing sessions keep their revision."}
          </p>
        ) : null}
      </header>

      {!snapshot.baseDefinition && !historical ? (
        <p className="text-sm text-muted">
          Activate a{" "}
          <Link className="underline underline-offset-4" href={settingsHref}>
            factory definition
          </Link>{" "}
          to edit this workflow.
        </p>
      ) : null}

      {!readOnly && !dirty
        ? (["kept", "working"] as const).map((source) => {
            const saved = source === "kept" ? keptRecovery : workingRecovery;
            if (!saved) return null;
            const label =
              source === "working" && keptRecovery ? "interrupted edits" : "recovery copy";
            return (
              <div
                key={source}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-warning-soft px-4 py-3 text-sm"
              >
                <p className="min-w-0 flex-1">
                  {source === "kept"
                    ? "You kept a recovery copy after a draft conflict."
                    : "This tab recovered unsaved changes from your last visit."}{" "}
                  These changes aren’t saved or published.
                </p>
                <button
                  className="ui-button"
                  type="button"
                  disabled={!!action}
                  onClick={(event) =>
                    requestConfirmation({ kind: "restore", source }, event.currentTarget)
                  }
                >
                  Review {label}
                </button>
                <button
                  className="ui-button"
                  type="button"
                  disabled={!!action}
                  onClick={() =>
                    writeWorkflowDraftRecovery(
                      source === "kept" ? keptRecoveryKey : recoveryKey,
                      null,
                    )
                  }
                >
                  Remove {label}
                </button>
              </div>
            );
          })
        : null}

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
                    {diagnosticLabel(path, graph, names)} · {message}
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
          roles={roles}
          setRoles={setRoles}
          settingsHref={settingsHref}
          loadMore={(catalog) => void loadMoreReferences(catalog)}
          apply={(nextGraph) => {
            setGraph(nextGraph);
            setRoles(emptyTemplateRoles);
            setNodeIndex(0);
            setEdgeIndex(0);
            setNotice({
              kind: "status",
              message: "Template loaded. Save a draft to retain these roles.",
            });
            setFocusRequest({ fieldId: workflowFieldId(["nodes", 0, "kind"]) });
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
            <a
              href="#workflow-step-properties"
              className="text-sm text-muted underline underline-offset-4 lg:hidden"
            >
              Jump to step properties
            </a>
            {snapshot.publishedDraftId && snapshot.publishedDraftId !== initial.selectedDraftId ? (
              <Link
                className="text-sm text-muted underline underline-offset-4"
                href={pageFor(snapshot.publishedDraftId)}
              >
                Inspect live revision{liveRevision ? ` ${liveRevision}` : ""}
              </Link>
            ) : null}
          </div>

          {view === "Graph" ? (
            <GraphCanvas graph={graph} names={names} selected={nodeIndex} pick={setNodeIndex} />
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
                  options={names}
                  value={graph.entryNodeId}
                  change={(entryNodeId) => setGraph({ ...graph, entryNodeId })}
                />
              </fieldset>
              <OrderedSteps graph={graph} names={names} selected={nodeIndex} pick={setNodeIndex} />
            </section>

            <section className={panel} aria-label="Step properties">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 id="workflow-step-properties" tabIndex={-1} className="font-medium">
                  Step properties
                </h2>
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
                <NodeFields
                  {...editorProps}
                  index={nodeIndex}
                  choices={choices}
                  grantsHref={grantsHref}
                  pickStep={(index) => {
                    if (index < 0) return;
                    setNodeIndex(index);
                    setFocusRequest({ fieldId: workflowFieldId(["nodes", index, "kind"]) });
                  }}
                />
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
                  id="workflow-add-transition"
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
                          {transitionName(edge, names)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                <div>
                  <fieldset disabled={readOnly || !!action}>
                    <EdgeFields {...editorProps} index={edgeIndex} choices={choices} />
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
                  {id === snapshot.publishedDraftId ? " · Live" : ""}
                  {id === currentDraftId && id !== snapshot.publishedDraftId
                    ? " · Latest saved"
                    : ""}
                </Link>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent
          title={
            confirmation?.kind === "restore"
              ? "Restore unsaved changes?"
              : confirmation?.kind === "reload"
                ? "Load the latest draft?"
                : "Leave this workflow?"
          }
          description={
            confirmation?.kind === "restore"
              ? recoveryHasOlderHead
                ? "This copy predates the latest draft, publication, or factory definition. Restoring it replaces what’s in the editor, not what’s saved. Review the latest draft first so you don’t overwrite someone else’s changes."
                : "The copy will replace what’s in the editor. You can review and save it as a new draft."
              : confirmation?.kind === "reload"
                ? hasConflict
                  ? keptRecovery
                    ? "Loading the latest draft replaces what’s in the editor. Keeping this copy replaces the earlier recovery copy in this tab."
                    : "Loading the latest draft replaces what’s in the editor. Keep a recovery copy in this tab if you want to revisit your changes."
                  : "Loading the latest draft replaces your unsaved changes."
                : "Leaving now discards your unsaved changes. Keep editing to save them first."
          }
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!editorTitle.current) return;
            const origin = confirmationOrigin.current;
            confirmationOrigin.current = null;
            if (document.activeElement !== document.body && document.activeElement !== origin)
              return;
            if (origin?.isConnected && !origin.matches(":disabled")) origin.focus();
            else editorTitle.current.focus();
          }}
        >
          <AlertDialogFooter className="flex-wrap">
            <AlertDialogCancel className="ui-button">
              {confirmation?.kind === "restore" ? "Cancel" : "Keep editing"}
            </AlertDialogCancel>
            <AlertDialogAction className="ui-button" onClick={() => confirmDraftAction()}>
              {confirmation?.kind === "restore"
                ? "Restore as unsaved changes"
                : confirmation?.kind === "reload"
                  ? "Discard changes and load latest"
                  : "Discard changes and leave"}
            </AlertDialogAction>
            {confirmation?.kind === "reload" && hasConflict ? (
              <AlertDialogAction
                className="ui-button-primary"
                onClick={() => confirmDraftAction(true)}
              >
                Keep a recovery copy and load latest
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
