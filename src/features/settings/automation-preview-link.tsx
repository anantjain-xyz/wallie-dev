import Link from "next/link";

import { PageSection } from "@/components/ui/page-shell";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { workspaceAutomationPreviewPath } from "@/lib/routes";

export async function AutomationPreviewLink({ workspaceSlug }: { workspaceSlug: string }) {
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
  if (!factories.some(({ canManage, status }) => canManage && status === "active")) return null;

  return (
    <PageSection title="Automations" tagline="Check how a saved rule would respond to an event.">
      <Link href={workspaceAutomationPreviewPath(workspaceSlug)} className="ui-button">
        Preview automations
      </Link>
    </PageSection>
  );
}
