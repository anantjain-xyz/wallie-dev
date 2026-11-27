import Link from "next/link";
import { Suspense } from "react";

import {
  resolveFactorySelection,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import { CreateFactoryDialog } from "@/features/settings/create-factory-dialog";
import type { SettingsInitialData } from "@/features/settings/data";
import { Section } from "@/features/settings/settings-ui";
import { WorkspaceSettingsLoadError } from "@/features/settings/workspace-settings-load-error";
import { WorkspaceFactoryManagement } from "@/features/settings/workspace-factory-management";
import { workspaceSessionsPath, workspaceSettingsPath } from "@/lib/routes";

type WorkspaceFactoriesSectionProps = {
  canManage: boolean;
  factories: Promise<readonly FactorySelectionOption[]>;
  requestedManagement?: string;
  requestedSetup?: string | string[];
  workspace: Pick<SettingsInitialData["workspace"], "id" | "name" | "slug">;
};

async function FactoryList({
  factories,
  requestedManagement,
  requestedSetup,
  workspaceSlug,
}: Pick<WorkspaceFactoriesSectionProps, "factories" | "requestedManagement" | "requestedSetup"> & {
  workspaceSlug: string;
}) {
  const options = await factories.catch(() => null);
  if (options === null) return <WorkspaceSettingsLoadError label="factories" />;

  const selection =
    requestedSetup === undefined
      ? null
      : resolveFactorySelection(
          options.filter(({ isDefault, status }) => !isDefault && status === "active"),
          requestedSetup,
        );
  const setup = selection?.kind === "factory" ? selection.factory : null;

  return (
    <div className="space-y-4">
      {setup ? (
        <Section
          actions={
            <Link
              className="ui-button min-h-11 sm:min-h-9"
              href={workspaceSessionsPath(workspaceSlug, { factory: setup.id })}
            >
              View sessions
            </Link>
          }
          anchorId="factory-setup"
          className="ui-sheet p-4 sm:p-5"
          heading="h3"
          tagline="Each factory needs its own repositories and pipeline to run sessions. Nothing was copied from the workspace default."
          title={`Set up ${setup.name}`}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <h4 className="type-label">Choose repositories</h4>
              <p className="type-secondary text-muted">
                Not available for additional factories. GitHub Settings adds repositories to the
                workspace default.
              </p>
            </div>
            <div className="space-y-1">
              <h4 className="type-label">Set up pipeline</h4>
              <p className="type-secondary text-muted">
                Not available for additional factories. The current editor only changes the
                workspace default’s pipeline.
              </p>
            </div>
          </div>
        </Section>
      ) : selection ? (
        <Section
          anchorId="factory-setup"
          className="ui-sheet p-4"
          heading="h3"
          title="Factory unavailable"
        >
          <p className="type-secondary text-muted">
            This factory is not available for setup in this workspace.
          </p>
        </Section>
      ) : null}
      {options.length > 0 ? (
        <ul aria-label="Factories" className="ui-sheet divide-y divide-border">
          {options.map((factory) => (
            <li
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
              key={factory.id}
            >
              <div className="min-w-0">
                <p className="type-body font-medium [overflow-wrap:anywhere]">{factory.name}</p>
                <code className="type-code text-muted [overflow-wrap:anywhere]" translate="no">
                  {factory.slug}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {factory.isDefault ? (
                  <span className="rounded border border-border px-2 py-0.5 type-label text-muted">
                    Default
                  </span>
                ) : null}
                {factory.status === "archived" ? (
                  <span className="rounded border border-border px-2 py-0.5 type-label text-muted">
                    Archived
                  </span>
                ) : null}
                {factory.canManage ? (
                  <Link
                    aria-current={requestedManagement === factory.id ? "location" : undefined}
                    aria-label={`Manage ${factory.name}`}
                    className="ui-button min-h-11 sm:min-h-9"
                    href={`${workspaceSettingsPath(workspaceSlug, { category: "workspace", manageFactory: factory.id })}#factory-management`}
                    prefetch={false}
                  >
                    Manage
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ui-sheet px-4 py-3 type-secondary text-muted">
          No factories are available to your account.
        </p>
      )}
      {requestedManagement ? (
        <Suspense
          fallback={
            <p className="type-secondary text-muted" role="status">
              Loading factory management…
            </p>
          }
        >
          <WorkspaceFactoryManagement
            factoryId={requestedManagement}
            workspaceSlug={workspaceSlug}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export function WorkspaceFactoriesSection({
  canManage,
  factories,
  requestedManagement,
  requestedSetup,
  workspace,
}: WorkspaceFactoriesSectionProps) {
  return (
    <Section
      actions={
        canManage ? (
          <CreateFactoryDialog
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            workspaceSlug={workspace.slug}
          />
        ) : null
      }
      anchorId="factories"
      tagline={`Factories you can access in ${workspace.name}.`}
      title="Factories"
    >
      <Suspense
        fallback={
          <p
            aria-busy="true"
            className="ui-sheet px-4 py-3 type-secondary text-muted"
            role="status"
          >
            Loading factories…
          </p>
        }
      >
        <FactoryList
          factories={factories}
          requestedManagement={requestedManagement}
          requestedSetup={requestedSetup}
          workspaceSlug={workspace.slug}
        />
      </Suspense>
    </Section>
  );
}
