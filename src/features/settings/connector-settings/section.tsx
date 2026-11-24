import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveGovernanceFactorySelection } from "@/features/factories/factory-selection";
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
  const factories = (options ?? []).filter((factory) => factory.canManage);
  const selection = resolveGovernanceFactorySelection(factories, requestedFactory);

  return (
    <Section
      actions={
        factories.length ? (
          <FactorySelector
            factories={factories}
            selectedValue={selection.kind === "factory" ? selection.factory.id : "unavailable"}
          />
        ) : undefined
      }
      anchorId="connector-resources"
      tagline="Map provider resources and inspect the deliveries associated with this factory."
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
          factoryId={selection.factory.id}
          key={selection.factory.id}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
        />
      ) : (
        <p className="rounded-md border border-border bg-sheet p-4 text-sm text-muted">
          {factories.length
            ? "Choose a factory you manage to view its connector resources."
            : "Factory managers and workspace admins can view connector resources."}
        </p>
      )}
    </Section>
  );
}
