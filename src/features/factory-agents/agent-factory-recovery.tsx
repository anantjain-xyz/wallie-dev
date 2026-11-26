import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { workspaceAgentsPath } from "@/lib/routes";

export function AgentFactoryRecovery({
  choose,
  factories,
  workspaceSlug,
}: {
  choose: boolean;
  factories: readonly FactorySelectionOption[];
  workspaceSlug: string;
}) {
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader title="Agents" />
      <section className="ui-sheet space-y-3 p-4 sm:p-5">
        <h2 className="font-semibold text-foreground">
          {choose ? "Choose a factory to view its agents" : "Factory unavailable"}
        </h2>
        {factories.length ? (
          <>
            {!choose && (
              <p className="type-secondary text-muted">Choose a factory you can access.</p>
            )}
            <ul className="flex flex-wrap gap-2">
              {factories.map((factory) => (
                <li className="min-w-0 max-w-full" key={factory.id}>
                  <Link
                    className="ui-button whitespace-normal [overflow-wrap:anywhere]"
                    href={workspaceAgentsPath(workspaceSlug, { factory: factory.id })}
                  >
                    {factory.name}
                    {factory.status === "archived" ? " (archived)" : ""}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="type-secondary text-muted">
            Ask a workspace operator for access to a factory.
          </p>
        )}
      </section>
    </PageContainer>
  );
}
