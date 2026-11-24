import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  resolveFactorySelection,
  resolveGovernanceFactorySelection,
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
  const factories = options ?? [];
  const managedDefault = resolveGovernanceFactorySelection(factories, undefined);
  const selection =
    requestedFactory === undefined && managedDefault.kind === "factory"
      ? managedDefault
      : resolveFactorySelection(factories, requestedFactory, { useFirstVisible: true });

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
        selection.kind === "factory" && !selection.factory.canManage
          ? "Manage your Slack account link for this factory."
          : "Map provider resources and inspect the deliveries associated with this factory."
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
      ) : selection.kind === "factory" ? (
        <ConnectorResources
          canManage={selection.factory.canManage === true}
          factoryId={selection.factory.id}
          key={selection.factory.id}
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
