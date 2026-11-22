import type { ReactNode } from "react";
import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { workspaceSessionsPath } from "@/lib/routes";

export function FactoryUnavailable({
  actions,
  title,
  workspaceSlug,
}: {
  actions?: ReactNode;
  title: string;
  workspaceSlug: string;
}) {
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader actions={actions} actionsRightOnDesktop title={title} />
      <section className="ui-sheet px-6 py-12 text-center">
        <h2 className="text-sm font-semibold text-foreground">Factory unavailable</h2>
        <p className="mt-2 text-sm text-muted">
          Return to sessions to choose a factory you can access.
        </p>
        <Link
          className="ui-button mt-4"
          href={workspaceSessionsPath(workspaceSlug, { factory: "all" })}
        >
          View accessible sessions
        </Link>
      </section>
    </PageContainer>
  );
}
