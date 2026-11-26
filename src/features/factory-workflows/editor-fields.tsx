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
  removeObsoleteEditorGrants,
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

function ownerPath(path: Path): Path {
  const [section, , , property, detail] = path;
  if (section === "nodes" && path[2] === "approverMemberIds") return path.slice(0, 3);
  if (section === "nodes" && path[2] === "repair" && property === "eligibleRuleIds") {
    return path.slice(0, 4);
  }
  if (
    section === "routePolicy" &&
    (property === "allowedDestinationIds" || property === "foremanProfile")
  ) {
    return path.slice(0, 4);
  }
  if (section === "routePolicy" && property === "fallback" && detail === "kind") {
    return path.slice(0, 4);
  }
  if (section === "delegationPolicy" && path[1] === "targets") return path.slice(0, 3);
  if (
    section === "repositorySets" &&
    (property === "writerGrant" || property === "branchEdgeIds")
  ) {
    return path.slice(0, 4);
  }
  return path;
}

export function workflowFieldId(path: Path) {
  return "workflow-field-" + ownerPath(path).map(String).join("-");
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
  const issues = [
    ...new Set(
      diagnostics
        .filter(({ path: value }) => workflowFieldId(value) === id)
        .map(({ message }) => message),
    ),
  ];
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = issues.length ? `${id}-error` : undefined;
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label className="type-label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-invalid": issues.length ? true : undefined,
        "aria-describedby": [descriptionId, errorId].filter(Boolean).join(" ") || undefined,
      })}
      {description ? (
        <p className="text-sm text-muted" id={descriptionId}>
          {description}
        </p>
      ) : null}
      {errorId ? (
        <div className="text-sm text-danger" id={errorId}>
          {issues.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type FieldProps = Omit<Parameters<typeof Field>[0], "children">;

const unavailableReference = "Unavailable — choose a replacement";

function matchesReference({ label }: Option, query: string) {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((term) => label.toLowerCase().includes(term));
}

function ReferenceSearch({
  label,
  query,
  change,
  noMatches,
  hasMore,
}: {
  label: string;
  query: string;
  change: (query: string) => void;
  noMatches: boolean;
  hasMore: boolean;
}) {
  return (
    <div className="grid gap-1">
      <label className="grid gap-1 text-xs text-muted">
        Filter {label.toLowerCase()}
        <input
          type="search"
          autoComplete="off"
          className="ui-input w-full"
          value={query}
          onChange={(event) => change(event.currentTarget.value)}
        />
      </label>
      {noMatches ? (
        <p className="text-xs text-muted" role="status">
          No {hasMore ? "loaded " : ""}choices match.{" "}
          {hasMore ? "Load more to continue searching." : "Try a different filter."}
        </p>
      ) : null}
    </div>
  );
}

function ExactReferences({ values }: { values: string[] }) {
  return values.length ? (
    <details className="text-xs text-muted">
      <summary className="w-fit cursor-pointer">
        Exact reference{values.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 grid gap-1">
        {values.map((value) => (
          <li className="wrap-anywhere" key={value}>
            <code className="select-all">{value}</code>
          </li>
        ))}
      </ul>
    </details>
  ) : null;
}

export function WorkflowOptions({
  value,
  options,
  change,
  empty,
  disabled,
  reference,
  unavailable = unavailableReference,
  ...field
}: FieldProps & {
  value: string;
  options: readonly Option[];
  empty?: string;
  disabled?: boolean;
  reference?: { hasMore?: boolean; detail?: string };
  unavailable?: string;
  change: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const current = options.find(({ id }) => id === value);
  const label = current?.label || (value ? unavailable : (empty ?? "Select an option"));
  const filtered = reference
    ? options.filter((option) => matchesReference(option, query))
    : options;
  return (
    <Field {...field}>
      {(attributes) => (
        <>
          {reference && !disabled && options.length > 0 ? (
            <ReferenceSearch
              label={field.label}
              query={query}
              change={setQuery}
              noMatches={filtered.length === 0}
              hasMore={!!reference.hasMore}
            />
          ) : null}
          <Select
            disabled={disabled}
            value={value}
            onValueChange={(next) => {
              if (next !== value) change(next);
            }}
          >
            <SelectTrigger className="w-full" {...attributes} fallbackLabel={label}>
              <span className="min-w-0 whitespace-normal wrap-anywhere">{label}</span>
            </SelectTrigger>
            <SelectContent>
              {empty !== undefined ? <SelectItem value="">{empty}</SelectItem> : null}
              {value && !current ? (
                <SelectItem value={value} disabled wrap>
                  {label}
                </SelectItem>
              ) : null}
              {current && !filtered.includes(current) ? (
                <SelectItem value={value} wrap>
                  {current.label}
                </SelectItem>
              ) : null}
              {filtered
                .filter(({ id }) => id !== "")
                .map(({ id, label: option }) => (
                  <SelectItem key={id} value={id} wrap>
                    {option}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {reference ? (
            <ExactReferences
              values={value ? [value, ...(reference.detail ? [reference.detail] : [])] : []}
            />
          ) : null}
        </>
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
          autoComplete="off"
          spellCheck={false}
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
  reference,
  unavailable = unavailableReference,
  ...field
}: FieldProps & {
  value: string[];
  options: readonly Option[];
  reference?: { hasMore?: boolean };
  unavailable?: string;
  change: (value: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const missing = [...new Set(value)].filter(
    (selected) => !options.some(({ id }) => id === selected),
  );
  const matches = reference ? options.filter((item) => matchesReference(item, query)) : options;
  const visible = reference
    ? options.filter((item) => value.includes(item.id) || matches.includes(item))
    : options;
  return (
    <Field {...field}>
      {(attributes) => (
        <>
          {reference && options.length ? (
            <ReferenceSearch
              label={field.label}
              query={query}
              change={setQuery}
              noMatches={matches.length === 0}
              hasMore={!!reference.hasMore}
            />
          ) : null}
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
                {unavailable}
              </option>
            ))}
            {visible.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          {reference ? <ExactReferences values={[...new Set(value)]} /> : null}
        </>
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

export function nodeOptions(
  nodes: WorkflowGraphDraft["nodes"],
  prompts: readonly Option[],
): Option[] {
  const names = nodes.map((node) => {
    if (node.kind === "deterministic")
      return operations.find(({ id }) => id === node.operation)!.label;
    if (node.kind === "human-gate") return "Approval";
    const promptId =
      node.kind === "review"
        ? node.reviewerPromptRevisionId
        : "agentPromptRevisionId" in node
          ? node.agentPromptRevisionId
          : null;
    const agent =
      promptId && prompts.find(({ id }) => id === promptId)?.label.replace(/ · Revision \d+$/, "");
    return agent
      ? node.kind === "agent"
        ? agent
        : `${nodeLabels[node.kind]} · ${agent}`
      : nodeLabels[node.kind];
  });
  return nodes.map(({ id }, index) => ({
    id,
    label:
      names.indexOf(names[index]!) === names.lastIndexOf(names[index]!)
        ? names[index]!
        : `${names[index]} · Step ${index + 1}`,
  }));
}

export function transitionName(edge: WorkflowEdgeDraft, nodes: readonly Option[]) {
  const from = nodes.find(({ id }) => id === edge.from)?.label ?? "Unavailable step";
  const to = nodes.find(({ id }) => id === edge.to)?.label ?? "Unavailable step";
  return `${from} → ${to} · ${edgeLabels[edge.kind]}`;
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
  const exact = choices.profiles.find(
    ({ id, digest }) => id === value?.definitionRevisionId && digest === value?.definitionDigest,
  );
  return (
    <WorkflowOptions
      label={label}
      path={path}
      diagnostics={diagnostics}
      value={value?.definitionRevisionId ?? ""}
      options={
        exact || !value
          ? choices.profiles
          : choices.profiles.filter(({ id }) => id !== value.definitionRevisionId)
      }
      reference={{ hasMore: !!choices.nextCursors?.profiles, detail: value?.definitionDigest }}
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
  const targets = new Map(
    graph.edges
      .filter(({ from, to }) => from === id && to !== id)
      .map((edge) => [edge.to, edge.kind]),
  );
  const nodeChoices = nodeOptions(graph.nodes, choices.prompts);
  const allowedTargets = nodeChoices.filter(({ id }) => {
    const kind = targets.get(id);
    return (
      (kind === "route" || kind === "loop") &&
      !(route.fallback.kind === "route" && route.fallback.destinationId === id)
    );
  });
  const fallbackTargets = nodeChoices.filter(
    ({ id }) => targets.get(id) === "route" && !route.allowedDestinationIds.includes(id),
  );
  const transitionHelp =
    graph.nodes.length < 2 ? (
      <a className="underline underline-offset-4" href="#workflow-add-step">
        Add a step
      </a>
    ) : (
      <a className="underline underline-offset-4" href="#workflow-add-transition">
        Add transition
      </a>
    );
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
        options={allowedTargets}
        unavailable="No longer eligible — remove this destination"
        value={route.allowedDestinationIds}
        change={(allowedDestinationIds) => change({ allowedDestinationIds })}
      />
      {!allowedTargets.length ? (
        <p className="text-sm text-muted">
          {transitionHelp} to make an outgoing Route or Loop destination available.
        </p>
      ) : null}
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
                ? {
                    kind: "route",
                    destinationId: fallbackTargets.length === 1 ? fallbackTargets[0]!.id : "",
                  }
                : { kind: "clarification" },
          })
        }
      />
      {route.fallback.kind === "route" ? (
        <WorkflowOptions
          label="Fallback destination"
          path={[...path, "fallback", "destinationId"]}
          diagnostics={diagnostics}
          options={fallbackTargets}
          unavailable="No longer eligible — choose another destination"
          empty="Select a step"
          value={route.fallback.destinationId}
          change={(destinationId) => change({ fallback: { kind: "route", destinationId } })}
        />
      ) : null}
      {!fallbackTargets.length ? (
        <p className="text-sm text-muted">
          A fallback needs a separate outgoing Route transition. Remove a Route destination from the
          allowed list or use {transitionHelp}.
        </p>
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
  hasMorePrompts,
  update,
}: {
  graph: WorkflowGraphDraft;
  node: Extract<WorkflowNodeDraft, { kind: "review" }>;
  index: number;
  diagnostics: readonly EditorDiagnostic[];
  prompts: WorkflowEditorChoices["prompts"];
  hasMorePrompts: boolean;
  update: (node: WorkflowNodeDraft) => void;
}) {
  const path = ["nodes", index];
  const repair = node.repair;
  const ruleOptions = node.ruleIds.map((id, index) => ({
    id,
    label: /^review-\d+$/.test(id) ? `Rule ${index + 1}` : id.replace(/[.-]/g, " "),
  }));
  const promptLabel = prompts.find(({ id }) => id === node.reviewerPromptRevisionId)?.label;
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
        reference={{ hasMore: hasMorePrompts }}
        value={node.reviewerPromptRevisionId}
        change={(reviewerPromptRevisionId) => update({ ...node, reviewerPromptRevisionId })}
      />
      <div className="grid gap-2 sm:col-span-2">
        <h3 className="type-label">Review rules</h3>
        <p className="text-sm text-muted">
          {promptLabel
            ? `Rules checked by ${promptLabel}.`
            : "Choose the reviewer prompt that checks these rules."}{" "}
          Rule keys must match the reviewer prompt.
        </p>
        <ol className="grid gap-2">
          {node.ruleIds.map((rule, position) => (
            <li key={position} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <details className="min-w-0 text-sm">
                <summary className="cursor-pointer wrap-anywhere">
                  {ruleOptions[position]?.label} · Rule key
                </summary>
                <div className="mt-2">
                  <UniqueIdField
                    label={`Rule ${position + 1} ID`}
                    path={[...path, "ruleIds", position]}
                    diagnostics={diagnostics}
                    value={rule}
                    change={(id) => editRule(position, id)}
                  />
                </div>
              </details>
              <button
                type="button"
                className="ui-button w-fit"
                disabled={node.ruleIds.length === 1}
                onClick={() => editRule(position)}
                aria-label={`Remove rule ${position + 1}: ${ruleOptions[position]?.label}`}
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
          <details className="text-sm sm:col-span-2">
            <summary className="cursor-pointer">Advanced repair settings</summary>
            <div className="mt-2">
              <TextField
                label="Repair edge ID"
                path={[...path, "repair", "edgeId"]}
                diagnostics={diagnostics}
                value={repair.edgeId}
                change={(edgeId) => update({ ...node, repair: { ...repair, edgeId } })}
              />
            </div>
          </details>
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
            description={promptLabel ? `Rules from ${promptLabel}.` : undefined}
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
  grantsHref,
}: Fields & {
  choices: WorkflowEditorChoices;
  joinId: string;
  grantsHref?: string;
}) {
  const sets = graph.repositorySets;
  const rows = sets && Object.hasOwn(sets, joinId) ? sets[joinId] : [];
  const path = ["repositorySets", joinId];
  const branchEdges = branchEdgesForJoin(graph, joinId);
  const names = nodeOptions(graph.nodes, choices.prompts);
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
              options={options.filter(
                ({ id, version, repositoryId }) =>
                  id !== row.writerGrant.id ||
                  (version === row.writerGrant.version && repositoryId === row.repositoryId),
              )}
              reference={{
                hasMore: !!choices.nextCursors?.writers,
                detail: `Grant version ${row.writerGrant.version}`,
              }}
              description="Choose an active writer for the exact repository and grant version."
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
                .map((edge) => ({ id: edge.id, label: transitionName(edge, names) }))}
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
      {!candidate && rows.length < 8 ? (
        <p className="text-sm text-muted">
          No additional eligible repository writers are loaded.
          {choices.nextCursors?.writers ? " Load more writers to see additional choices." : null}
          {grantsHref ? (
            <>
              {" "}
              Check{" "}
              <a className="underline underline-offset-4" href={grantsHref}>
                execution grants
              </a>{" "}
              for active access.
            </>
          ) : null}
        </p>
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
  grantsHref,
  pickStep,
}: Fields & {
  choices: WorkflowEditorChoices;
  index: number;
  grantsHref?: string;
  pickStep?: (index: number) => void;
}) {
  const node = graph.nodes[index];
  if (!node) return null;
  const path = ["nodes", index];
  const assignment = node.kind === "agent" ? getAgentRepositoryWriter(graph, node.id) : undefined;
  const factoryGrantLabel = choices.grant
    ? `${choices.grantRepository ?? "Factory grant"} · Grant version ${choices.grant.version}`
    : undefined;
  const chosenGrant =
    assignment?.writerGrant ??
    graph.grants.find(({ id }) => "grantId" in node && id === node.grantId);
  const grantOptions = assignment
    ? choices.writers.filter(
        ({ id, version }) =>
          id === assignment.writerGrant.id && version === assignment.writerGrant.version,
      )
    : choices.grant &&
        factoryGrantLabel &&
        graph.grants.some(
          ({ id, version }) => id === choices.grant?.id && version === choices.grant.version,
        )
      ? [{ id: choices.grant.id, label: factoryGrantLabel }]
      : [];
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
        <ReviewFields
          {...{ graph, node, index, diagnostics, update }}
          prompts={choices.prompts}
          hasMorePrompts={!!choices.nextCursors?.prompts}
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
              reference={{ hasMore: !!choices.nextCursors?.approvers }}
              description="Select members to require their approval. Use Ctrl or Command to change multiple selections with a mouse."
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
            reference={{ hasMore: !!choices.nextCursors?.prompts }}
            value={node.agentPromptRevisionId}
            change={(agentPromptRevisionId) => update({ ...node, agentPromptRevisionId })}
          />
          <WorkflowOptions
            label="Execution grant"
            path={[...path, "grantId"]}
            diagnostics={diagnostics}
            disabled={!!assignment}
            options={grantOptions}
            reference={chosenGrant ? { detail: `Grant version ${chosenGrant.version}` } : undefined}
            value={assignment?.writerGrant.id ?? node.grantId ?? ""}
            empty={
              assignment
                ? undefined
                : `Use workflow default${factoryGrantLabel ? ` · ${factoryGrantLabel}` : ""}`
            }
            change={(grantId) => update({ ...node, grantId: grantId || undefined })}
          />
          {assignment && pickStep ? (
            <button
              id="workflow-edit-join"
              type="button"
              className="ui-button w-fit sm:col-span-2"
              onClick={() => pickStep(graph.nodes.findIndex(({ id }) => id === assignment.joinId))}
            >
              Edit secondary writer at join
            </button>
          ) : chosenGrant && !grantOptions.length && grantsHref ? (
            <p className="text-sm text-muted sm:col-span-2">
              This grant may have expired or no longer match the active definition. Check{" "}
              <a className="underline underline-offset-4" href={grantsHref}>
                execution grants
              </a>{" "}
              or choose the workflow default.
            </p>
          ) : null}
        </>
      ) : null}
      {node.kind === "join" ? (
        <JoinRepositoryFields
          {...{ graph, edit, diagnostics, choices, grantsHref }}
          joinId={node.id}
        />
      ) : null}
      <details key={index} className="text-sm sm:col-span-2">
        <summary className="cursor-pointer">Advanced step settings</summary>
        <div className="mt-2">
          <UniqueIdField
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
        </div>
      </details>
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

export function EdgeFields({
  graph,
  edit,
  diagnostics,
  index,
  choices,
}: Fields & {
  index: number;
  choices: WorkflowEditorChoices;
}) {
  const edge = graph.edges[index];
  if (!edge) return null;
  const path = ["edges", index];
  const update = (next: WorkflowEdgeDraft) => edit(updateEditorEdge(graph, index, next));
  const nodes = nodeOptions(graph.nodes, choices.prompts);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
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
      <details key={index} className="text-sm sm:col-span-2">
        <summary className="cursor-pointer">Advanced transition settings</summary>
        <div className="mt-2">
          <UniqueIdField
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
        </div>
      </details>
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
  const withoutObsoleteGrants = removeObsoleteEditorGrants(graph, grant);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {grant ? (
        <ToggleField
          label={`Use approved factory grant · Version ${grant.version}`}
          description={
            choices.grantRepository ? `Primary repository: ${choices.grantRepository}.` : undefined
          }
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
      {withoutObsoleteGrants !== graph ? (
        <div className="grid content-start gap-1.5">
          <button
            type="button"
            className="ui-button w-fit"
            aria-describedby="workflow-obsolete-grant-removal"
            onClick={() => edit(withoutObsoleteGrants)}
          >
            Remove obsolete factory grants
          </button>
          <p id="workflow-obsolete-grant-removal" className="text-sm text-muted">
            Steps using those grants will use the workflow default.
          </p>
        </div>
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
