"use client";

import type { ReactNode } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { EditorDiagnostic } from "@/features/factory-definition/editor-requests";

import {
  defaultDelegationPolicy,
  edgeLabels,
  makeEdge,
  makeNode,
  nodeLabels,
  setEditorNode,
  setNodeRoute,
  type WorkflowEdgeDraft,
  type WorkflowEditorChoices,
  type WorkflowGraphDraft,
  type WorkflowNodeDraft,
} from "./editor-graph";

type Path = readonly (string | number)[];
type Option = { id: string; label: string };
type Fields = {
  graph: WorkflowGraphDraft;
  edit: (graph: WorkflowGraphDraft) => void;
  diagnostics: readonly EditorDiagnostic[];
};

const nodeKinds = ["deterministic", "agent", "human-gate", "route", "branch", "join"] as const;
const edgeKinds = ["next", "route", "loop", "branch", "branch-result"] as const;
const operations = [
  { id: "checkpoint", label: "Checkpoint" },
  { id: "validation", label: "Validation" },
  { id: "policy", label: "Execution policy" },
] as const;

export function workflowFieldId(path: Path) {
  return "workflow-field-" + path.map(String).join("-");
}

function Field({
  path,
  label,
  diagnostics,
  children,
}: {
  path: Path;
  label: string;
  diagnostics: readonly EditorDiagnostic[];
  children: (attributes: {
    id: string;
    "aria-invalid": true | undefined;
    "aria-describedby": string | undefined;
  }) => ReactNode;
}) {
  const id = workflowFieldId(path);
  const issue = diagnostics.find(
    ({ path: value }) => JSON.stringify(value) === JSON.stringify(path),
  );
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label className="type-label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-invalid": issue ? true : undefined,
        "aria-describedby": issue ? `${id}-error` : undefined,
      })}
      {issue ? (
        <p className="text-sm text-danger" id={`${id}-error`}>
          {issue.message}
        </p>
      ) : null}
    </div>
  );
}

type FieldProps = Omit<Parameters<typeof Field>[0], "children">;

export function WorkflowOptions({
  value,
  options,
  change,
  empty,
  ...field
}: FieldProps & {
  value: string;
  options: readonly Option[];
  empty?: string;
  change: (value: string) => void;
}) {
  const current = options.find(({ id }) => id === value);
  const label = current?.label || value || empty || "Select an option";
  return (
    <Field {...field}>
      {(attributes) => (
        <Select value={value} onValueChange={change}>
          <SelectTrigger className="w-full" {...attributes} fallbackLabel={label}>
            <span className="min-w-0 truncate">{label}</span>
          </SelectTrigger>
          <SelectContent>
            {empty !== undefined ? <SelectItem value="">{empty}</SelectItem> : null}
            {value && !current ? <SelectItem value={value}>{value}</SelectItem> : null}
            {options
              .filter(({ id }) => id !== "")
              .map(({ id, label: option }) => (
                <SelectItem key={id} value={id}>
                  {option}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}

function TextField({
  value,
  change,
  ...field
}: FieldProps & {
  value: string;
  change: (value: string) => void;
}) {
  return (
    <Field {...field}>
      {(attributes) => (
        <input
          className="ui-input w-full"
          {...attributes}
          value={value}
          maxLength={96}
          onChange={(event) => change(event.currentTarget.value)}
        />
      )}
    </Field>
  );
}

function NumberField({
  value,
  change,
  min = 0,
  max,
  step = 1,
  ...field
}: FieldProps & {
  value: number;
  change: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field {...field}>
      {(attributes) => (
        <input
          className="ui-input w-full"
          {...attributes}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            change(Number.isFinite(next) ? next : 0);
          }}
        />
      )}
    </Field>
  );
}

function MultipleOptions({
  value,
  change,
  options,
  ...field
}: FieldProps & {
  value: string[];
  options: readonly Option[];
  change: (value: string[]) => void;
}) {
  const missing = value.filter((selected) => !options.some(({ id }) => id === selected));
  return (
    <Field {...field}>
      {(attributes) => (
        <select
          className="ui-input min-h-24 w-full"
          {...attributes}
          multiple
          value={value}
          onChange={(event) =>
            change(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
          }
        >
          {missing.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
          {options.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function ToggleField({
  value,
  change,
  ...field
}: FieldProps & {
  value: boolean;
  change: (value: boolean) => void;
}) {
  return (
    <Field {...field}>
      {(attributes) => (
        <input
          className="size-4 accent-accent"
          {...attributes}
          type="checkbox"
          checked={value}
          onChange={(event) => change(event.currentTarget.checked)}
        />
      )}
    </Field>
  );
}

export function nodeOptions(nodes: WorkflowGraphDraft["nodes"]): Option[] {
  return nodes.map(({ id }) => ({ id, label: id || "Unnamed step" }));
}

function ProfilePicker({
  path,
  label,
  value,
  choices,
  diagnostics,
  change,
}: {
  path: Path;
  label: string;
  value?: { definitionRevisionId: string; definitionDigest: string };
  choices: WorkflowEditorChoices;
  diagnostics: readonly EditorDiagnostic[];
  change: (value?: { definitionRevisionId: string; definitionDigest: string }) => void;
}) {
  return (
    <WorkflowOptions
      label={label}
      path={path}
      diagnostics={diagnostics}
      value={value?.definitionRevisionId ?? ""}
      options={choices.profiles}
      empty="No execution profile"
      change={(id) => {
        const profile = choices.profiles.find((candidate) => candidate.id === id);
        change(
          profile
            ? { definitionRevisionId: profile.id, definitionDigest: profile.digest }
            : undefined,
        );
      }}
    />
  );
}

function RouteFields({
  graph,
  edit,
  diagnostics,
  choices,
  id,
}: Fields & {
  choices: WorkflowEditorChoices;
  id: string;
}) {
  const route = graph.routePolicy?.nodes[id];
  if (!route) return null;
  const path = ["routePolicy", "nodes", id];
  const change = (update: Partial<typeof route>) =>
    edit(setNodeRoute(graph, id, { ...route, ...update }));
  const targets = nodeOptions(graph.nodes.filter((candidate) => candidate.id !== id));
  return (
    <>
      <NumberField
        label="Minimum confidence"
        path={[...path, "minimumConfidence"]}
        diagnostics={diagnostics}
        value={route.minimumConfidence}
        change={(minimumConfidence) => change({ minimumConfidence })}
        max={1}
        step={0.01}
      />
      <MultipleOptions
        label="Allowed route destinations"
        path={[...path, "allowedDestinationIds"]}
        diagnostics={diagnostics}
        options={targets}
        value={route.allowedDestinationIds}
        change={(allowedDestinationIds) => change({ allowedDestinationIds })}
      />
      <WorkflowOptions
        label="Fallback"
        path={[...path, "fallback"]}
        diagnostics={diagnostics}
        options={[
          { id: "clarification", label: "Ask for clarification" },
          { id: "route", label: "Send to a step" },
        ]}
        value={route.fallback.kind}
        change={(kind) =>
          change({
            fallback:
              kind === "route"
                ? { kind: "route", destinationId: route.allowedDestinationIds[0] ?? "" }
                : { kind: "clarification" },
          })
        }
      />
      {route.fallback.kind === "route" ? (
        <WorkflowOptions
          label="Fallback destination"
          path={[...path, "fallback", "destinationId"]}
          diagnostics={diagnostics}
          options={targets}
          empty="Select a step"
          value={route.fallback.destinationId}
          change={(destinationId) => change({ fallback: { kind: "route", destinationId } })}
        />
      ) : null}
      <ProfilePicker
        label="Foreman execution profile"
        path={[...path, "foremanProfile"]}
        diagnostics={diagnostics}
        choices={choices}
        value={route.foremanProfile}
        change={(foremanProfile) => change({ foremanProfile })}
      />
    </>
  );
}

export function NodeFields({
  graph,
  edit,
  diagnostics,
  choices,
  index,
}: Fields & {
  choices: WorkflowEditorChoices;
  index: number;
}) {
  const node = graph.nodes[index];
  if (!node) return null;
  const path = ["nodes", index];
  const update = (next: WorkflowNodeDraft) => edit(setEditorNode(graph, index, next));
  const setProfile = (profile?: { definitionRevisionId: string; definitionDigest: string }) => {
    const policy = graph.delegationPolicy ?? defaultDelegationPolicy;
    const targets = { ...policy.targets };
    if (profile) targets[node.id] = profile;
    else delete targets[node.id];
    edit({ ...graph, delegationPolicy: { ...policy, targets } });
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label="Step ID"
        path={[...path, "id"]}
        diagnostics={diagnostics}
        value={node.id}
        change={(id) => update({ ...node, id })}
      />
      <WorkflowOptions
        label="Step kind"
        path={[...path, "kind"]}
        diagnostics={diagnostics}
        options={nodeKinds.map((id) => ({ id, label: nodeLabels[id] }))}
        value={node.kind}
        change={(value) => {
          const kind = nodeKinds.find((candidate) => candidate === value);
          if (kind) update(makeNode(node.id, kind));
        }}
      />
      {node.kind === "deterministic" ? (
        <WorkflowOptions
          label="Operation"
          path={[...path, "operation"]}
          diagnostics={diagnostics}
          options={operations}
          value={node.operation}
          change={(value) => {
            const operation = operations.find(({ id }) => id === value);
            if (operation) update({ ...node, operation: operation.id });
          }}
        />
      ) : null}
      {node.kind === "human-gate" ? (
        <>
          <ToggleField
            label="Any eligible member can approve"
            path={[...path, "anyoneCanApprove"]}
            diagnostics={diagnostics}
            value={node.anyoneCanApprove}
            change={(anyoneCanApprove) => update({ ...node, anyoneCanApprove })}
          />
          {!node.anyoneCanApprove ? (
            <MultipleOptions
              label="Required approvers"
              path={[...path, "approverMemberIds"]}
              diagnostics={diagnostics}
              options={choices.approvers}
              value={node.approverMemberIds ?? []}
              change={(approverMemberIds) => update({ ...node, approverMemberIds })}
            />
          ) : null}
        </>
      ) : null}
      {node.kind === "agent" || node.kind === "route" ? (
        <>
          <WorkflowOptions
            label="Agent prompt revision"
            path={[...path, "agentPromptRevisionId"]}
            diagnostics={diagnostics}
            empty="Select a prompt"
            options={choices.prompts}
            value={node.agentPromptRevisionId}
            change={(agentPromptRevisionId) => update({ ...node, agentPromptRevisionId })}
          />
          <WorkflowOptions
            label="Execution grant"
            path={[...path, "grantId"]}
            diagnostics={diagnostics}
            options={graph.grants.map(({ id, version }) => ({
              id,
              label: `Factory grant · Version ${version}`,
            }))}
            value={node.grantId ?? ""}
            empty="Use workflow default"
            change={(grantId) => update({ ...node, grantId: grantId || undefined })}
          />
        </>
      ) : null}
      {node.kind === "route" ? (
        <RouteFields {...{ graph, edit, diagnostics, choices }} id={node.id} />
      ) : null}
      {node.kind === "agent" ? (
        <ProfilePicker
          label="Delegated execution profile"
          path={["delegationPolicy", "targets", node.id]}
          diagnostics={diagnostics}
          choices={choices}
          value={graph.delegationPolicy?.targets[node.id]}
          change={setProfile}
        />
      ) : null}
    </div>
  );
}

export function EdgeFields({ graph, edit, diagnostics, index }: Fields & { index: number }) {
  const edge = graph.edges[index];
  if (!edge) return null;
  const path = ["edges", index];
  const update = (next: WorkflowEdgeDraft) =>
    edit({
      ...graph,
      edges: graph.edges.map((item, position) => (position === index ? next : item)),
    });
  const nodes = nodeOptions(graph.nodes);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label="Transition ID"
        path={[...path, "id"]}
        diagnostics={diagnostics}
        value={edge.id}
        change={(id) => update({ ...edge, id })}
      />
      <WorkflowOptions
        label="Transition kind"
        path={[...path, "kind"]}
        diagnostics={diagnostics}
        options={edgeKinds.map((id) => ({ id, label: edgeLabels[id] }))}
        value={edge.kind}
        change={(value) => {
          const kind = edgeKinds.find((candidate) => candidate === value);
          if (kind) update(makeEdge(edge, kind));
        }}
      />
      <WorkflowOptions
        label="From step"
        path={[...path, "from"]}
        diagnostics={diagnostics}
        options={nodes}
        value={edge.from}
        change={(from) => update({ ...edge, from })}
      />
      <WorkflowOptions
        label="To step"
        path={[...path, "to"]}
        diagnostics={diagnostics}
        options={nodes}
        value={edge.to}
        change={(to) => update({ ...edge, to })}
      />
      {edge.kind === "loop" ? (
        <NumberField
          label="Maximum traversals"
          path={[...path, "maxTraversals"]}
          diagnostics={diagnostics}
          value={edge.maxTraversals}
          min={1}
          max={16}
          change={(maxTraversals) => update({ ...edge, maxTraversals })}
        />
      ) : null}
      {edge.kind === "branch" ? (
        <ToggleField
          label="Required branch output"
          path={[...path, "required"]}
          diagnostics={diagnostics}
          value={edge.required}
          change={(required) => update({ ...edge, required })}
        />
      ) : null}
    </div>
  );
}

const delegationLimits = [
  ["maxChildren", "Maximum delegated children", 1],
  ["maxConcurrentChildren", "Maximum concurrent children", 1],
  ["maxAttempts", "Maximum delegated attempts", 1],
  ["maxTotalTokens", "Total token limit", 1],
  ["maxTokensPerAttempt", "Tokens per attempt", 1],
  ["maxCostUsd", "Total spend limit (USD)", 0.01],
  ["maxCostUsdPerAttempt", "Spend per attempt (USD)", 0.01],
] as const;

export function PolicyFields({
  graph,
  edit,
  diagnostics,
  choices,
}: Fields & { choices: WorkflowEditorChoices }) {
  const policy = graph.routePolicy;
  const delegation = graph.delegationPolicy;
  const grant = choices.grant;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {grant ? (
        <ToggleField
          label={`Use approved factory grant · Version ${grant.version}`}
          path={["grants"]}
          diagnostics={diagnostics}
          value={graph.grants.some(
            ({ id, version }) => id === grant.id && version === grant.version,
          )}
          change={(enabled) => edit({ ...graph, grants: enabled ? [grant] : [] })}
        />
      ) : null}
      {policy ? (
        <>
          <NumberField
            label="Maximum workflow visits"
            path={["routePolicy", "maxNodeVisits"]}
            diagnostics={diagnostics}
            value={policy.maxNodeVisits}
            min={1}
            max={1024}
            change={(maxNodeVisits) =>
              edit({ ...graph, routePolicy: { ...policy, maxNodeVisits } })
            }
          />
          <NumberField
            label="Maximum total loop traversals"
            path={["routePolicy", "maxLoopTraversals"]}
            diagnostics={diagnostics}
            value={policy.maxLoopTraversals}
            max={1024}
            change={(maxLoopTraversals) =>
              edit({ ...graph, routePolicy: { ...policy, maxLoopTraversals } })
            }
          />
        </>
      ) : null}
      {delegation ? (
        delegationLimits.map(([key, label, step]) => (
          <NumberField
            key={key}
            label={label}
            path={["delegationPolicy", key]}
            diagnostics={diagnostics}
            value={delegation[key]}
            min={step}
            step={step}
            change={(limit) =>
              edit({ ...graph, delegationPolicy: { ...delegation, [key]: limit } })
            }
          />
        ))
      ) : (
        <button
          type="button"
          className="ui-button w-fit"
          onClick={() => edit({ ...graph, delegationPolicy: defaultDelegationPolicy })}
        >
          Set delegation limits
        </button>
      )}
      {delegation ? (
        <button
          type="button"
          className="ui-button w-fit"
          onClick={() => edit({ ...graph, delegationPolicy: undefined })}
        >
          Remove delegation limits
        </button>
      ) : null}
    </div>
  );
}
