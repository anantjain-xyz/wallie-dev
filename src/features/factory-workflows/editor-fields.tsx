"use client";

import { useState, type ReactNode } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { EditorDiagnostic } from "@/features/factory-definition/editor-requests";

import {
  branchEdgesForJoin,
  defaultDelegationPolicy,
  defaultRoutePolicy,
  edgeLabels,
  getAgentRepositoryWriter,
  makeEdge,
  makeNode,
  nextEditorId,
  nodeLabels,
  setEditorNode,
  setEditorRepositoryWriters,
  setNodeRoute,
  updateEditorEdge,
  type RepositoryWriterDraft,
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

const nodeKinds = [
  "deterministic",
  "agent",
  "human-gate",
  "route",
  "branch",
  "join",
  "review",
] as const;
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
  description,
  children,
}: {
  path: Path;
  label: string;
  diagnostics: readonly EditorDiagnostic[];
  description?: string;
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
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = issue ? `${id}-error` : undefined;
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label className="type-label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-invalid": issue ? true : undefined,
        "aria-describedby": [descriptionId, errorId].filter(Boolean).join(" ") || undefined,
      })}
      {description ? (
        <p className="text-sm text-muted" id={descriptionId}>
          {description}
        </p>
      ) : null}
      {issue ? (
        <p className="text-sm text-danger" id={errorId}>
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
  disabled,
  ...field
}: FieldProps & {
  value: string;
  options: readonly Option[];
  empty?: string;
  disabled?: boolean;
  change: (value: string) => void;
}) {
  const current = options.find(({ id }) => id === value);
  const label = current?.label || value || empty || "Select an option";
  return (
    <Field {...field}>
      {(attributes) => (
        <Select
          disabled={disabled}
          value={value}
          onValueChange={(next) => {
            if (next !== value) change(next);
          }}
        >
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
  onBlur,
  ...field
}: FieldProps & {
  value: string;
  change: (value: string) => void;
  onBlur?: () => void;
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
          onBlur={onBlur}
        />
      )}
    </Field>
  );
}

function UniqueIdField({
  value,
  change,
  ...field
}: FieldProps & {
  value: string;
  change: (value: string) => boolean;
}) {
  const [rejected, setRejected] = useState<{ previous: string; attempted: string } | null>(null);
  const attempted = rejected?.previous === value ? rejected.attempted : undefined;
  const diagnostics =
    attempted === undefined
      ? field.diagnostics
      : [
          {
            path: [...field.path],
            message: `${field.label} “${attempted}” is already in use. Choose a unique ID.`,
          },
          ...field.diagnostics,
        ];
  return (
    <TextField
      {...field}
      diagnostics={diagnostics}
      value={attempted ?? value}
      onBlur={() => setRejected(null)}
      change={(id) => setRejected(change(id) ? null : { previous: value, attempted: id })}
    />
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

function ReviewFields({
  graph,
  node,
  index,
  diagnostics,
  prompts,
  update,
}: {
  graph: WorkflowGraphDraft;
  node: Extract<WorkflowNodeDraft, { kind: "review" }>;
  index: number;
  diagnostics: readonly EditorDiagnostic[];
  prompts: WorkflowEditorChoices["prompts"];
  update: (node: WorkflowNodeDraft) => void;
}) {
  const path = ["nodes", index];
  const repair = node.repair;
  const ruleOptions = node.ruleIds.map((id) => ({ id, label: id }));
  const editRule = (position: number, id?: string) => {
    const previous = node.ruleIds[position];
    if (id !== undefined && node.ruleIds.some((rule, index) => index !== position && rule === id)) {
      return false;
    }
    const ruleIds =
      id === undefined
        ? node.ruleIds.filter((_, current) => current !== position)
        : node.ruleIds.map((rule, current) => (current === position ? id : rule));
    const nextRepair = repair && {
      ...repair,
      eligibleRuleIds: repair.eligibleRuleIds.flatMap((rule) =>
        rule === previous ? (id === undefined ? [] : [id]) : [rule],
      ),
    };
    update({ ...node, ruleIds, repair: nextRepair });
    return true;
  };
  return (
    <>
      <WorkflowOptions
        label="Reviewer prompt revision"
        path={[...path, "reviewerPromptRevisionId"]}
        diagnostics={diagnostics}
        empty="Select a prompt"
        options={prompts}
        value={node.reviewerPromptRevisionId}
        change={(reviewerPromptRevisionId) => update({ ...node, reviewerPromptRevisionId })}
      />
      <div className="grid gap-2 sm:col-span-2">
        <h3 className="type-label">Review rules</h3>
        <ol className="grid gap-2">
          {node.ruleIds.map((rule, position) => (
            <li key={position} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <UniqueIdField
                label={`Rule ${position + 1} ID`}
                path={[...path, "ruleIds", position]}
                diagnostics={diagnostics}
                value={rule}
                change={(id) => editRule(position, id)}
              />
              <button
                type="button"
                className="ui-button w-fit"
                disabled={node.ruleIds.length === 1}
                onClick={() => editRule(position)}
                aria-label={`Remove rule ${rule}`}
              >
                Remove rule
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="ui-button w-fit"
          disabled={node.ruleIds.length >= 32}
          onClick={() =>
            update({
              ...node,
              ruleIds: [...node.ruleIds, nextEditorId("review", ruleOptions)],
            })
          }
        >
          Add review rule
        </button>
      </div>
      <ToggleField
        label="Allow bounded repair"
        path={[...path, "repair"]}
        diagnostics={diagnostics}
        value={!!repair}
        change={(enabled) =>
          update({
            ...node,
            repair: enabled
              ? {
                  edgeId: nextEditorId("repair", [
                    ...graph.edges,
                    ...graph.nodes.flatMap((item) =>
                      item.kind === "review" && item.repair ? [{ id: item.repair.edgeId }] : [],
                    ),
                  ]),
                  maxRepairs: 1,
                  eligibleRuleIds: node.ruleIds.slice(0, 1),
                }
              : undefined,
          })
        }
      />
      {repair ? (
        <>
          <TextField
            label="Repair edge ID"
            path={[...path, "repair", "edgeId"]}
            diagnostics={diagnostics}
            value={repair.edgeId}
            change={(edgeId) => update({ ...node, repair: { ...repair, edgeId } })}
          />
          <NumberField
            label="Maximum repairs"
            path={[...path, "repair", "maxRepairs"]}
            diagnostics={diagnostics}
            value={repair.maxRepairs}
            min={1}
            max={8}
            change={(maxRepairs) => update({ ...node, repair: { ...repair, maxRepairs } })}
          />
          <MultipleOptions
            label="Rules eligible for repair"
            path={[...path, "repair", "eligibleRuleIds"]}
            diagnostics={diagnostics}
            options={ruleOptions}
            value={repair.eligibleRuleIds}
            change={(eligibleRuleIds) =>
              update({ ...node, repair: { ...repair, eligibleRuleIds } })
            }
          />
        </>
      ) : null}
    </>
  );
}

function JoinRepositoryFields({
  graph,
  edit,
  diagnostics,
  choices,
  joinId,
}: Fields & {
  choices: WorkflowEditorChoices;
  joinId: string;
}) {
  const sets = graph.repositorySets;
  const rows = sets && Object.hasOwn(sets, joinId) ? sets[joinId] : [];
  const path = ["repositorySets", joinId];
  const branchEdges = branchEdgesForJoin(graph, joinId);
  const withBranches = (entries: RepositoryWriterDraft[]) =>
    edit(setEditorRepositoryWriters(graph, joinId, entries));
  const change = (index: number, next: RepositoryWriterDraft) =>
    withBranches(rows.map((row, position) => (position === index ? next : row)));
  const candidate = choices.writers.find(
    (writer) => !rows.some(({ repositoryId }) => repositoryId === writer.repositoryId),
  );

  return (
    <div className="grid gap-3 sm:col-span-2">
      <h3 className="type-label">Secondary repositories</h3>
      {rows.map((row, index) => {
        const occupied = new Set(
          rows.flatMap((entry, position) => (position === index ? [] : entry.branchEdgeIds)),
        );
        const options = choices.writers.filter(
          (writer) =>
            writer.repositoryId === row.repositoryId ||
            !rows.some((entry) => entry.repositoryId === writer.repositoryId),
        );
        return (
          <div key={index} className="grid gap-3 rounded-md border border-border p-3">
            <WorkflowOptions
              label="Repository and exact writer grant"
              path={[...path, index, "writerGrant"]}
              diagnostics={diagnostics}
              options={options.map(({ id, label }) => ({ id, label }))}
              value={row.writerGrant.id}
              change={(id) => {
                const writer = options.find((option) => option.id === id);
                if (writer)
                  change(index, {
                    ...row,
                    repositoryId: writer.repositoryId,
                    writerGrant: { id, version: writer.version },
                  });
              }}
            />
            <MultipleOptions
              label="Assigned branch outputs"
              path={[...path, index, "branchEdgeIds"]}
              diagnostics={diagnostics}
              options={branchEdges
                .filter(({ id }) => !occupied.has(id))
                .map(({ id }) => ({ id, label: id }))}
              value={row.branchEdgeIds}
              change={(branchEdgeIds) => change(index, { ...row, branchEdgeIds })}
            />
            <button
              type="button"
              className="ui-button w-fit"
              onClick={() => withBranches(rows.filter((_, position) => position !== index))}
            >
              Remove secondary repository
            </button>
          </div>
        );
      })}
      {candidate && rows.length < 8 ? (
        <button
          type="button"
          className="ui-button w-fit"
          onClick={() =>
            withBranches([
              ...rows,
              {
                repositoryId: candidate.repositoryId,
                writerGrant: { id: candidate.id, version: candidate.version },
                branchEdgeIds: [],
              },
            ])
          }
        >
          Add secondary repository
        </button>
      ) : null}
    </div>
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
  const assignment = node.kind === "agent" ? getAgentRepositoryWriter(graph, node.id) : undefined;
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
      <UniqueIdField
        key={index}
        label="Step ID"
        path={[...path, "id"]}
        diagnostics={diagnostics}
        value={node.id}
        change={(id) => {
          const next = setEditorNode(graph, index, { ...node, id });
          if (next === graph) return false;
          edit(next);
          return true;
        }}
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
      {node.kind === "review" ? (
        <ReviewFields {...{ graph, node, index, diagnostics, update }} prompts={choices.prompts} />
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
            description={
              assignment
                ? `To change this grant, edit the secondary repository assignment at join “${assignment.joinId}”.`
                : undefined
            }
            disabled={!!assignment}
            options={(assignment
              ? [assignment.writerGrant]
              : graph.grants.filter(({ id }) => id === choices.grant?.id || id === node.grantId)
            ).map(({ id, version }) => ({
              id,
              label:
                choices.writers.find((writer) => writer.id === id && writer.version === version)
                  ?.label ?? `Factory grant · Version ${version}`,
            }))}
            value={assignment?.writerGrant.id ?? node.grantId ?? ""}
            empty={assignment ? undefined : "Use workflow default"}
            change={(grantId) => update({ ...node, grantId: grantId || undefined })}
          />
        </>
      ) : null}
      {node.kind === "join" ? (
        <JoinRepositoryFields {...{ graph, edit, diagnostics, choices }} joinId={node.id} />
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
  const update = (next: WorkflowEdgeDraft) => edit(updateEditorEdge(graph, index, next));
  const nodes = nodeOptions(graph.nodes);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <UniqueIdField
        key={index}
        label="Transition ID"
        path={[...path, "id"]}
        diagnostics={diagnostics}
        value={edge.id}
        change={(id) => {
          const next = updateEditorEdge(graph, index, { ...edge, id });
          if (next === graph) return false;
          edit(next);
          return true;
        }}
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
          change={(enabled) => {
            const others = graph.grants.filter(({ id }) => id !== grant.id);
            edit({
              ...graph,
              grants: enabled ? [grant, ...others] : others,
              nodes: enabled
                ? graph.nodes
                : graph.nodes.map((node) =>
                    "grantId" in node && node.grantId === grant.id
                      ? { ...node, grantId: undefined }
                      : node,
                  ),
            });
          }}
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
      ) : graph.edges.some(({ kind }) => kind === "loop") ? (
        <button
          id={workflowFieldId(["routePolicy"])}
          type="button"
          className="ui-button w-fit"
          onClick={() => edit({ ...graph, routePolicy: defaultRoutePolicy })}
        >
          Set workflow limits
        </button>
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
