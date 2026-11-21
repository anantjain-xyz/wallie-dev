"use client";

import { useId, useRef, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  benchmarkAxisSnapshotSchema,
  freezeBenchmarkAxesRequestSchema,
  type BenchmarkAxisCatalog,
  type BenchmarkAxisRequest,
  type BenchmarkAxisSnapshot,
} from "@/lib/factory-benchmarks/experiment-axes-contracts";

type Selection = {
  definitionRevisionId: string;
  modelKey: string;
  harness: string;
  workerRuntime: string;
  qualificationId: string;
};

const blankSelection: Selection = {
  definitionRevisionId: "",
  modelKey: "",
  harness: "",
  workerRuntime: "",
  qualificationId: "",
};

type Definition = BenchmarkAxisCatalog["definitions"][number];
type Profile = BenchmarkAxisCatalog["profiles"][number];
type Option = { value: string; label: string };
type Axis = {
  name: Exclude<keyof Selection, "qualificationId">;
  label: string;
  options: Option[];
};

const harnessLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const runtimeLabels: Record<string, string> = { node: "Node.js", workerd: "Cloudflare Workers" };
const policyLabels = {
  blocked: "Blocked",
  recorded_fixtures: "Recorded fixtures",
  isolated_test: "Isolated test",
};

function axisOptions(values: string[], labels: Record<string, string> = {}): Option[] {
  return [...new Set(values)].sort().map((value) => ({ value, label: labels[value] ?? value }));
}

function resolveSelection(options: BenchmarkAxisCatalog, selection: Selection) {
  const definition = options.definitions.find(({ id }) => id === selection.definitionRevisionId);
  const profiles = options.profiles.filter(
    (profile) =>
      profile.modelKey === selection.modelKey &&
      profile.harness === selection.harness &&
      profile.workerRuntime === selection.workerRuntime &&
      profile.definitionIds.includes(selection.definitionRevisionId),
  );
  const available = profiles.filter(({ unavailableReason }) => unavailableReason === null);
  const profile =
    available.length === 1 && !selection.qualificationId
      ? available[0]
      : available.find(({ id }) => id === selection.qualificationId);

  if (!definition || !selection.modelKey || !selection.harness || !selection.workerRuntime) {
    return { definition, profiles, profile, reason: null };
  }

  const unavailable = profiles.find(({ id }) => id === selection.qualificationId);
  const reason = profiles.length
    ? (unavailable?.unavailableReason ??
      (available.length
        ? null
        : profiles.flatMap(({ unavailableReason }) => unavailableReason ?? []).join(" ")))
    : `${runtimeLabels[selection.workerRuntime]} has no qualified ${harnessLabels[selection.harness]} toolchain for this model and factory revision.`;
  return { definition, profiles, profile, reason };
}

function ExactPins({ definition, profile }: { definition: Definition; profile: Profile }) {
  return (
    <details className="rounded-md border border-border">
      <summary className="type-label cursor-pointer px-3 py-2">Exact configuration pins</summary>
      <dl className="type-secondary space-y-2 px-3 pb-3 [overflow-wrap:anywhere]">
        <div>
          <dt className="text-muted">Factory revision ID</dt>
          <dd className="font-mono">{definition.id}</dd>
        </div>
        <div>
          <dt className="text-muted">Factory revision SHA-256</dt>
          <dd className="font-mono">{definition.digest}</dd>
        </div>
        <div>
          <dt className="text-muted">Harness model ID</dt>
          <dd className="font-mono">{profile.harnessModel}</dd>
        </div>
        <div>
          <dt className="text-muted">Sandbox provider</dt>
          <dd>{profile.sandboxProvider}</dd>
        </div>
        <div>
          <dt className="text-muted">Sandbox connection revision</dt>
          <dd className="font-mono">{profile.sandboxConnectionRevision}</dd>
        </div>
        <div>
          <dt className="text-muted">Checked CLI version</dt>
          <dd>{profile.toolchain}</dd>
        </div>
        <div>
          <dt className="text-muted">Capability report SHA-256</dt>
          <dd className="font-mono">{profile.toolchainDigest}</dd>
        </div>
        <div>
          <dt className="text-muted">Qualification ID</dt>
          <dd className="font-mono">{profile.id}</dd>
        </div>
      </dl>
    </details>
  );
}

function CandidateFields({
  label,
  axes,
  selection,
  resolved,
  onChange,
}: {
  label: string;
  axes: Axis[];
  selection: Selection;
  resolved: ReturnType<typeof resolveSelection>;
  onChange: (selection: Selection) => void;
}) {
  const statusId = useId();
  const { definition, profiles, profile, reason } = resolved;
  return (
    <fieldset
      aria-describedby={statusId}
      className="min-w-0 space-y-3 rounded-md border border-border p-3 sm:p-4"
    >
      <legend className="type-label px-1">{label}</legend>
      {axes.map(({ label: axisLabel, name, options }) => (
        <label className="block min-w-0 space-y-1" key={name}>
          <span className="type-label">{axisLabel}</span>
          <select
            className="ui-input min-w-0"
            onChange={(event) =>
              onChange({ ...selection, [name]: event.target.value, qualificationId: "" })
            }
            required
            value={selection[name]}
          >
            <option value="">Select {axisLabel.toLowerCase()}</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {profiles.length > 1 ? (
        <label className="block min-w-0 space-y-1">
          <span className="type-label">Qualified toolchain</span>
          <select
            className="ui-input min-w-0"
            onChange={(event) => onChange({ ...selection, qualificationId: event.target.value })}
            value={profile?.id ?? selection.qualificationId}
          >
            <option value="">Select a toolchain</option>
            {profiles.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.toolchain} · {choice.sandboxProvider} · {choice.id.slice(0, 8)}
                {choice.unavailableReason ? " · Unavailable" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p
        aria-live="polite"
        className={`type-secondary [overflow-wrap:anywhere] ${reason ? "text-danger" : "text-muted"}`}
        id={statusId}
      >
        {reason ??
          (profile
            ? `Capability check passed · ${profile.toolchain}`
            : profiles.length
              ? "Select a qualified toolchain to continue."
              : "Choose the four axes to check compatibility.")}
      </p>
      {definition && profile ? <ExactPins definition={definition} profile={profile} /> : null}
    </fieldset>
  );
}

export function BenchmarkComparisonForm({
  workspaceId,
  factoryId,
  suiteRevisionId,
  suiteRevisionNumber,
  taskCount,
  options,
}: {
  workspaceId: string;
  factoryId: string;
  suiteRevisionId: string;
  suiteRevisionNumber: number;
  taskCount: number;
  options: BenchmarkAxisCatalog;
}) {
  const policyHelpId = useId();
  const [baseline, setBaseline] = useState(blankSelection);
  const [candidate, setCandidate] = useState(blankSelection);
  const [policyRevisionId, setPolicyRevisionId] = useState("");
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [receipt, setReceipt] = useState<BenchmarkAxisSnapshot | null>(null);
  const lastRequest = useRef<{ key: string; experimentId: string } | null>(null);
  const action = useApiAction<unknown, [BenchmarkAxisRequest]>({
    call: (command) =>
      fetch(`/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks/experiment-axes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      }),
    errorText: "Could not freeze the comparison.",
    setFlashMessage: setMessage,
    onSuccess: (payload) => setReceipt(benchmarkAxisSnapshotSchema.parse(payload)),
  });

  const baselineResult = resolveSelection(options, baseline);
  const candidateResult = resolveSelection(options, candidate);
  const sameConfiguration =
    !!baselineResult.profile &&
    baselineResult.profile.id === candidateResult.profile?.id &&
    baseline.definitionRevisionId === candidate.definitionRevisionId;
  const axes: Axis[] = [
    {
      name: "modelKey",
      label: "Model",
      options: axisOptions(options.profiles.map(({ modelKey }) => modelKey)),
    },
    {
      name: "harness",
      label: "Harness",
      options: axisOptions(Object.keys(harnessLabels), harnessLabels),
    },
    {
      name: "workerRuntime",
      label: "Worker runtime",
      options: axisOptions(Object.keys(runtimeLabels), runtimeLabels),
    },
    {
      name: "definitionRevisionId",
      label: "Factory revision",
      options: options.definitions.map(({ id, label }) => ({ value: id, label })),
    },
  ];
  const comparesMultipleAxes =
    baselineResult.profile &&
    candidateResult.profile &&
    axes.filter(({ name }) => baseline[name] !== candidate[name]).length > 1;

  const canFreeze =
    !!(baselineResult.profile && candidateResult.profile && policyRevisionId && taskCount) &&
    !sameConfiguration &&
    !receipt;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canFreeze || !baselineResult.profile || !candidateResult.profile) return;
    const fields = new FormData(event.currentTarget);
    const command = {
      suiteRevisionId,
      policyRevisionId,
      candidates: [
        {
          definitionRevisionId: baseline.definitionRevisionId,
          qualificationId: baselineResult.profile.id,
          workerRuntime: baselineResult.profile.workerRuntime,
        },
        {
          definitionRevisionId: candidate.definitionRevisionId,
          qualificationId: candidateResult.profile.id,
          workerRuntime: candidateResult.profile.workerRuntime,
        },
      ],
      repetitions: Number(fields.get("repetitions")),
      seed: Number(fields.get("seed")),
      timeoutMs: Number(fields.get("timeoutSeconds")) * 1_000,
    };
    const key = JSON.stringify(command);
    if (lastRequest.current?.key !== key) {
      lastRequest.current = { key, experimentId: crypto.randomUUID() };
    }
    const parsed = freezeBenchmarkAxesRequestSchema.safeParse({
      ...command,
      experimentId: lastRequest.current.experimentId,
    });
    if (!parsed.success) {
      setMessage({ kind: "error", text: "Check the comparison settings and try again." });
      return;
    }
    setMessage(null);
    void action.run(parsed.data);
  }

  return (
    <form
      aria-label="Benchmark comparison"
      className="ui-sheet space-y-4 p-4 sm:p-5"
      onChange={() => {
        setMessage(null);
        setReceipt(null);
      }}
      onSubmit={submit}
    >
      <div className="space-y-1">
        <p className="type-label">
          Suite revision {suiteRevisionNumber} · {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </p>
        <p className="type-secondary text-muted">
          Both configurations use the same saved task inputs.
        </p>
      </div>
      <fieldset aria-busy={action.isBusy} className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">Comparison options</legend>
        {!options.definitions.length || !options.profiles.length ? (
          <p className="type-secondary text-muted">
            A published factory revision and a qualified execution profile are required.
          </p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <CandidateFields
            label="Baseline"
            axes={axes}
            selection={baseline}
            resolved={baselineResult}
            onChange={setBaseline}
          />
          <CandidateFields
            label="Candidate"
            axes={axes}
            selection={candidate}
            resolved={candidateResult}
            onChange={setCandidate}
          />
        </div>
        {comparesMultipleAxes ? (
          <p aria-live="polite" className="type-secondary text-muted">
            This pair changes several axes. Results describe the combined configuration change.
          </p>
        ) : null}
        <label className="block min-w-0 space-y-1">
          <span className="type-label">Replay policy revision</span>
          <select
            aria-describedby={policyHelpId}
            className="ui-input min-w-0"
            onChange={(event) => setPolicyRevisionId(event.target.value)}
            required
            value={policyRevisionId}
          >
            <option value="">
              {options.policies.length ? "Select a replay policy" : "No published replay policies"}
            </option>
            {options.policies.map(({ id, profile, revisionNumber }) => (
              <option key={id} value={id}>
                Revision {revisionNumber} · {policyLabels[profile]}
              </option>
            ))}
          </select>
        </label>
        <p className="type-secondary text-muted" id={policyHelpId}>
          Freezing saves a trial plan. The replay policy controls execution.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block min-w-0 space-y-1">
            <span className="type-label">Repetitions</span>
            <input
              className="ui-input"
              defaultValue={3}
              min={1}
              max={100}
              name="repetitions"
              required
              type="number"
            />
          </label>
          <label className="block min-w-0 space-y-1">
            <span className="type-label">Seed</span>
            <input
              className="ui-input"
              defaultValue={0}
              min={0}
              max={2147483647}
              name="seed"
              required
              type="number"
            />
          </label>
          <label className="block min-w-0 space-y-1">
            <span className="type-label">Timeout (seconds)</span>
            <input
              className="ui-input"
              defaultValue={120}
              min={1}
              max={1800}
              name="timeoutSeconds"
              required
              type="number"
            />
          </label>
        </div>
        <InlineActionMessage message={message} />
        {sameConfiguration ? (
          <p aria-live="polite" className="type-secondary text-danger">
            Choose a different configuration for the candidate.
          </p>
        ) : null}
        {receipt ? (
          <div
            className="space-y-1 rounded-md border border-success/20 bg-success-soft px-3 py-2 [overflow-wrap:anywhere]"
            role="status"
          >
            <p className="type-label text-success">Comparison frozen</p>
            <p className="type-secondary">
              {receipt.materializedTrialCount} planned · {receipt.eligibleTrialCount} eligible ·{" "}
              {receipt.ineligibleTrialCount} ineligible
            </p>
            <p className="type-secondary text-muted">
              Experiment <span className="font-mono">{receipt.experimentId}</span>
            </p>
          </div>
        ) : null}
        <button className="ui-button ui-button-primary" disabled={!canFreeze} type="submit">
          <ActionButtonLabel
            idle="Freeze comparison"
            pending={action.isBusy}
            pendingLabel="Freezing…"
          />
        </button>
      </fieldset>
    </form>
  );
}
