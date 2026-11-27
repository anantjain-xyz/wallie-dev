import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  resolveFactorySelection,
  resolveGovernanceFactorySelection,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { Section } from "@/features/settings/settings-ui";

import { ConnectorResources } from "./resources";

export async function ConnectorSettingsSection({
  requestedFactory,
  workspaceId,
  workspaceSlug,
}: {
  requestedFactory?: string | string[];
  workspaceId: string;
  workspaceSlug: string;
}) {
  const options = await loadWorkspaceFactoryOptions(workspaceSlug).catch(() => null);
  return (
    <ConnectorSettingsPanel
      options={options}
      requestedFactory={requestedFactory}
      workspaceId={workspaceId}
      workspaceSlug={workspaceSlug}
    />
  );
}

export function ConnectorSettingsPanel({
  options,
  requestedFactory,
  workspaceId,
  workspaceSlug,
}: {
  options: FactorySelectionOption[] | null;
  requestedFactory?: string | string[];
  workspaceId: string;
  workspaceSlug: string;
}) {
  const factories = options ?? [];
  const managedDefault = resolveGovernanceFactorySelection(factories, undefined);
  const selection =
    requestedFactory === undefined && managedDefault.kind === "factory"
      ? managedDefault
      : resolveFactorySelection(factories, requestedFactory, { useFirstVisible: true });
  const factory = selection.kind === "factory" ? selection.factory : null;

  return (
    <Section
      actions={
        factories.length ? (
          <FactorySelector
            factories={factories}
            resetParams={["slackResult"]}
            selectedValue={selection.kind === "factory" ? selection.factory.id : "unavailable"}
          />
        ) : undefined
      }
      anchorId="connector-resources"
      tagline={
        factory ? (
          <>
            <strong className="font-medium text-foreground">
              Selected factory: {factory.name}
              {factory.status === "archived" ? " (archived)" : ""}.
            </strong>{" "}
            {factory.canManage
              ? "Mappings and deliveries here are separate from workspace connections."
              : "Your Slack account link is the only connector setting you can manage here."}
          </>
        ) : (
          "Choose a factory to see its connector settings."
        )
      }
      title="Connector resources"
    >
      {options === null ? (
        <p
          className="rounded-md border border-border bg-sheet p-4 text-sm text-danger"
          role="alert"
        >
          Connector resources are unavailable. Refresh the page to try again.
        </p>
      ) : factory ? (
        <ConnectorResources
          archived={factory.status === "archived"}
          canManage={factory.canManage === true}
          factoryId={factory.id}
          key={factory.id}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
        />
      ) : (
        <p className="rounded-md border border-border bg-sheet p-4 text-sm text-muted">
          {factories.length
            ? "Choose a factory to view its connector settings."
            : "No factories are available for connector setup."}
        </p>
      )}
    </Section>
  );
}
