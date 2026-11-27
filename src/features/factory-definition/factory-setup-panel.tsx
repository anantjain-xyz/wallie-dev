"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { fetchFactoryEditor } from "@/features/factory-definition/editor-requests";
import type { FactoryEditorSnapshot } from "@/lib/factory-definitions/editor-contracts";
import {
  factorySetupRepositoryOptionsSchema,
  type FactorySetupAction,
  type FactorySetupSnapshot,
} from "@/lib/factory-definitions/setup-contracts";
import { serialFactorySetupBlockers } from "@/lib/factory-definitions/setup-readiness";
import { workspaceSettingsPath } from "@/lib/routes";
import type { SandboxProvider } from "@/lib/sandbox/types";

const providerLabels = {
  daytona: "Daytona",
  e2b: "E2B",
  vercel: "Vercel Sandbox",
} satisfies Record<SandboxProvider, string>;

export function FactorySetupPanel({
  api,
  snapshot,
  setup,
  busy,
  pending,
  refresh,
  dirty,
  onProvision,
  workspaceSlug,
}: {
  api: string;
  snapshot: FactoryEditorSnapshot;
  setup: FactorySetupSnapshot;
  busy: boolean;
  pending: boolean;
  refresh: number;
  dirty: boolean;
  onProvision: (action: FactorySetupAction) => Promise<void>;
  workspaceSlug: string;
}) {
  const { repositories, hasPipeline, pipelineAvailable, enabledSandboxProviders } = setup;
  const { published, draft, baseline, readySandboxProviders } = snapshot;
  const scopedRepo = (id: string | undefined) => repositories.find((repo) => repo.id === id);
  const configuredRepositoryId =
    published?.bundle.repositoryId ?? draft?.bundle.repositoryId ?? baseline?.source.repository;
  const displayedRepository = configuredRepositoryId
    ? scopedRepo(configuredRepositoryId)
    : repositories.length === 1
      ? repositories[0]
      : undefined;
  const edition = draft?.source ?? baseline?.source;
  const runtimeProvider = (draft?.source ?? published?.source ?? baseline?.source)?.sandboxProvider;
  const blockers = serialFactorySetupBlockers({
    definition: published?.bundle ?? null,
    repositoryIds: repositories.map(({ id }) => id),
    pipelineAvailable,
    connectedSandboxProviders: readySandboxProviders,
  });
  const needsRepository = repositories.length === 0;
  const needsPipeline = !hasPipeline && !needsRepository;
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const settings = workspaceSettingsPath(workspaceSlug, { category: "integrations" });
  const sandboxUnready = runtimeProvider && !readySandboxProviders.includes(runtimeProvider);

  return (
    <section aria-labelledby="factory-setup" className="ui-sheet mb-6 min-w-0 space-y-4 p-4 sm:p-5">
      <h2 className="type-section-title scroll-mt-8" id="factory-setup" tabIndex={-1}>
        Setup
      </h2>
      <dl className="grid max-w-lg grid-cols-2 gap-3 text-sm">
        <div className="min-w-0">
          <dt className="type-annotation text-muted">Repository</dt>
          <dd className="break-words font-medium">
            {displayedRepository?.fullName ??
              (published || draft
                ? "Unavailable"
                : needsRepository
                  ? "Not assigned"
                  : "Choose in the editor")}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="type-annotation text-muted">Serial pipeline</dt>
          <dd className="font-medium">
            {!pipelineAvailable
              ? published || draft
                ? "Unavailable"
                : "Not created"
              : published
                ? `Published #${snapshot.activationNumber}`
                : "Not published"}
          </dd>
        </div>
      </dl>
      {published && blockers.includes("repository_unavailable") ? (
        <p className="type-secondary text-warning">
          The published repository is no longer connected to this factory. Choose a connected
          repository and publish a new draft.
        </p>
      ) : draft && !scopedRepo(draft.bundle.repositoryId) ? (
        <p className="type-secondary text-warning">
          The draft repository is no longer connected to this factory. Choose a connected repository
          before saving again.
        </p>
      ) : null}
      {!pipelineAvailable && (published || draft) ? (
        <p className="type-secondary text-warning">
          The configured pipeline is unavailable.
          {hasPipeline ? " Choose an existing pipeline under References in advanced settings." : ""}
        </p>
      ) : null}
      {sandboxUnready ? (
        <p className="type-secondary text-warning">
          {enabledSandboxProviders.includes(runtimeProvider) ? (
            <>
              <Link className="underline underline-offset-2" href={`${settings}#sandbox`}>
                Connect {providerLabels[runtimeProvider]}
              </Link>{" "}
              or choose a connected sandbox in Runtime and advanced settings.
            </>
          ) : (
            <>
              {providerLabels[runtimeProvider]} is disabled. Choose an available sandbox in Runtime.
            </>
          )}
        </p>
      ) : published && blockers.includes("sandbox_unavailable") ? (
        <p className="type-secondary text-warning">
          The published sandbox is unavailable. Restore its connection or publish a draft using a
          connected sandbox.
        </p>
      ) : null}
      {needsRepository ? (
        <RepositoryAssignment
          api={api}
          busy={busy || dirty}
          key={refresh}
          onAssign={(repositoryId) => onProvision({ action: "assign-repository", repositoryId })}
          pending={pending}
          settings={settings}
        />
      ) : needsPipeline ? (
        <div className="space-y-2">
          <p className="type-secondary text-muted">
            Create a serial pipeline to add this factory’s stages.
          </p>
          <button
            className="ui-button-primary"
            disabled={busy || dirty}
            onClick={() => void onProvision({ action: "create-pipeline" })}
            type="button"
          >
            <ActionButtonLabel idle="Create pipeline" pending={pending} pendingLabel="Creating…" />
          </button>
        </div>
      ) : (
        <>
          {!published && pipelineAvailable && edition?.stages.length ? (
            <p className="type-secondary text-muted">
              Publish a tested draft before starting sessions in this factory.
            </p>
          ) : null}
          <details onToggle={(event) => setAssignmentOpen(event.currentTarget.open)}>
            <summary className="w-fit cursor-pointer py-1 text-sm font-medium">
              Assign another repository
            </summary>
            {assignmentOpen ? (
              <RepositoryAssignment
                api={api}
                busy={busy || dirty}
                key={`${repositories.length}:${refresh}`}
                onAssign={(repositoryId) =>
                  onProvision({ action: "assign-repository", repositoryId })
                }
                pending={pending}
                settings={settings}
              />
            ) : null}
          </details>
        </>
      )}
      {(needsRepository || needsPipeline || assignmentOpen) && dirty ? (
        <p className="type-secondary text-muted">
          Save or discard your edits before changing setup.
        </p>
      ) : null}
    </section>
  );
}

function RepositoryAssignment({
  api,
  busy,
  onAssign,
  pending,
  settings,
}: {
  api: string;
  busy: boolean;
  onAssign: (repositoryId: string) => Promise<void>;
  pending: boolean;
  settings: string;
}) {
  const selectId = useId();
  const [selected, setSelected] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<
    { repositories: { id: string; fullName: string }[] } | { error: string } | null
  >(null);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void fetchFactoryEditor(`${api}/setup`, factorySetupRepositoryOptionsSchema, { signal }).then(
      (options) => {
        if (!signal.aborted) setResult(options);
      },
      (error: unknown) => {
        if (!signal.aborted)
          setResult({
            error: error instanceof Error ? error.message : "Could not load repositories.",
          });
      },
    );
    return () => controller.abort();
  }, [api, attempt]);

  if (!result)
    return (
      <p className="type-secondary text-muted" role="status">
        Loading connected repositories…
      </p>
    );
  if ("error" in result) {
    return (
      <div className="space-y-2">
        <p className="type-secondary text-danger" role="alert">
          {result.error}
        </p>
        <button
          type="button"
          className="ui-button"
          onClick={() => {
            setResult(null);
            setAttempt((current) => current + 1);
          }}
        >
          Retry repository lookup
        </button>
      </div>
    );
  }
  if (!result.repositories.length) {
    return (
      <p className="type-secondary text-muted">
        No unused repositories are available.{" "}
        <Link className="text-accent underline underline-offset-2" href={`${settings}#github`}>
          Connect another repository
        </Link>{" "}
        in Workspace Settings.
      </p>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected && !busy) void onAssign(selected);
      }}
    >
      <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-end">
        <div className="min-w-0 flex-1 space-y-1 sm:max-w-96">
          <label className="block text-sm font-medium" htmlFor={selectId}>
            Connected repository
          </label>
          <select
            aria-describedby={`${selectId}-effect`}
            className="ui-input w-full"
            disabled={busy}
            id={selectId}
            onChange={(event) => setSelected(event.target.value)}
            value={selected}
          >
            <option value="">Choose an unused repository</option>
            {result.repositories.map(({ id, fullName }) => (
              <option key={id} value={id}>
                {fullName}
              </option>
            ))}
          </select>
        </div>
        <button className="ui-button-primary w-fit" disabled={!selected || busy} type="submit">
          <ActionButtonLabel idle="Assign repository" pending={pending} pendingLabel="Assigning…" />
        </button>
      </div>
      <p className="type-secondary text-muted" id={`${selectId}-effect`}>
        Moves the repository to this factory. Repositories already in use stay where they are.
      </p>
    </form>
  );
}
