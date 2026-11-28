import Link from "next/link";
import { Suspense } from "react";

import {
  resolveFactorySelection,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import { CreateFactoryDialog } from "@/features/settings/create-factory-dialog";
import type { SettingsInitialData } from "@/features/settings/data";
import { FactoryManagementToggle } from "@/features/settings/islands/factory-management-navigation";
import { FACTORY_ROW_ANCHOR_PREFIX } from "@/features/settings/settings-categories";
import { Section } from "@/features/settings/settings-ui";
import { WorkspaceSettingsLoadError } from "@/features/settings/workspace-settings-load-error";
import { WorkspaceFactoryManagement } from "@/features/settings/workspace-factory-management";
import {
  workspaceFactoryDefinitionPath,
  workspaceSessionsPath,
  workspaceSettingsPath,
} from "@/lib/routes";

type WorkspaceFactoriesSectionProps = {
  canManage: boolean;
  factories: Promise<readonly FactorySelectionOption[]>;
  requestedManagement?: string;
  requestedSetup?: string | string[];
  workspace: Pick<SettingsInitialData["workspace"], "id" | "name" | "slug">;
};

async function FactoryList({
  canManage,
  factories,
  requestedManagement,
  requestedSetup,
  workspaceSlug,
}: Pick<
  WorkspaceFactoriesSectionProps,
  "canManage" | "factories" | "requestedManagement" | "requestedSetup"
> & {
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
  const managementId = options.find(
    ({ canManage, id }) => canManage && id === requestedManagement,
  )?.id;

  return (
    <div className="space-y-4">
      {setup ? (
        <Section
          actions={
            <>
              {canManage ? (
                <Link
                  className="ui-button-primary min-h-11 sm:min-h-9"
                  href={`${workspaceFactoryDefinitionPath(workspaceSlug, { factory: setup.id })}#factory-setup`}
                >
                  Configure factory
                </Link>
              ) : null}
              <Link
                className="ui-button min-h-11 sm:min-h-9"
                href={workspaceSessionsPath(workspaceSlug, { factory: setup.id })}
              >
                View sessions
              </Link>
            </>
          }
          anchorId="factory-setup"
          className="ui-sheet p-4 sm:p-5 [&>header]:mb-0"
          heading="h3"
          tagline={
            canManage
              ? "Assign a repository and publish a pipeline before starting sessions."
              : "A workspace owner or admin sets up this factory."
          }
          title={`Set up ${setup.name}`}
        >
          {null}
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
      {requestedManagement && !managementId ? (
        <Section
          actions={
            <Link
              className="ui-button min-h-11 sm:min-h-9"
              href={`${workspaceSettingsPath(workspaceSlug, { category: "workspace", factory: setup?.id })}#factories`}
              prefetch={false}
            >
              Close
            </Link>
          }
          anchorId="factory-management"
          heading="h3"
          title="Factory management unavailable"
        >
          <p className="type-secondary text-muted">You need manager access to this factory.</p>
        </Section>
      ) : null}
      {options.length > 0 ? (
        <ul aria-label="Factories" className="ui-sheet divide-y divide-border">
          {options.map((factory) => {
            const open = managementId === factory.id;
            const panelId = `factory-management-${factory.id}`;
            const nameId = `factory-name-${factory.id}`;
            return (
              <li className="min-w-0" key={factory.id}>
                <div
                  className="grid scroll-mt-4 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3"
                  id={open ? "factory-management" : `${FACTORY_ROW_ANCHOR_PREFIX}${factory.id}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="type-body font-medium [overflow-wrap:anywhere]" id={nameId}>
                        {factory.name}
                      </p>
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
                    </div>
                    {factory.slug ? (
                      <>
                        <span className="sr-only">Factory slug: </span>
                        <code
                          className="type-code text-muted [overflow-wrap:anywhere]"
                          translate="no"
                        >
                          {factory.slug}
                        </code>
                      </>
                    ) : null}
                  </div>
                  {factory.canManage ? (
                    <FactoryManagementToggle
                      factoryId={factory.id}
                      factoryName={factory.name}
                      open={open}
                      panelId={panelId}
                    />
                  ) : null}
                </div>
                {factory.canManage ? (
                  <div
                    aria-labelledby={nameId}
                    className="border-t border-border px-4 py-4 sm:py-5"
                    hidden={!open}
                    id={panelId}
                    role="region"
                  >
                    {open ? (
                      <Suspense
                        fallback={
                          <p className="type-secondary text-muted" role="status">
                            Loading factory management…
                          </p>
                        }
                      >
                        <WorkspaceFactoryManagement
                          factoryId={factory.id}
                          workspaceSlug={workspaceSlug}
                        />
                      </Suspense>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ui-sheet px-4 py-3 type-secondary text-muted">
          No factories are available to your account.
        </p>
      )}
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
          canManage={canManage}
          factories={factories}
          requestedManagement={requestedManagement}
          requestedSetup={requestedSetup}
          workspaceSlug={workspace.slug}
        />
      </Suspense>
    </Section>
  );
}
