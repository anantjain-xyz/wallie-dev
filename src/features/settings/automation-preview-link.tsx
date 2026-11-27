import Link from "next/link";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveGovernanceFactorySelection } from "@/features/factories/factory-selection";
import { workspaceAutomationPreviewPath } from "@/lib/routes";

export async function AutomationPreviewLink({ workspaceSlug }: { workspaceSlug: string }) {
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug).catch(() => []);
  const selection = resolveGovernanceFactorySelection(
    factories.filter(({ status }) => status === "active"),
    undefined,
  );
  if (selection.kind !== "factory") return null;

  return (
    <p className="type-secondary break-words text-muted">
      <Link
        href={workspaceAutomationPreviewPath(workspaceSlug)}
        className="font-medium text-accent underline"
      >
        Manage automations
      </Link>{" "}
      (opens {selection.factory.name}, independent of the connector selection)
    </p>
  );
}
