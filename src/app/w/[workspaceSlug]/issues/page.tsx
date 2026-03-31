import { PlaceholderPanel } from "@/components/shared/placeholder-panel";
import { workspaceLabel } from "@/lib/routes";

type IssuesPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function IssuesPage({ params }: IssuesPageProps) {
  const { workspaceSlug } = await params;

  return (
    <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
      <PlaceholderPanel
        eyebrow="Issue List Surface"
        title="Workspace issue list route is wired and waiting for data contracts"
        summary="This page holds the initial surface for server-fetched issue rows, query-param filters, search, sort, and bulk actions once schema and RLS work are ready."
        items={[
          "Reserve URL query params for status, priority, estimate, search, and sort state.",
          "Use server components for the initial list fetch, then patch local caches narrowly with Realtime.",
          "Keep bulk mutations and issue creation aligned with workspace-scoped RLS contracts.",
        ]}
        tone="ready"
      />

      <PlaceholderPanel
        eyebrow="Workspace Context"
        title={workspaceLabel(workspaceSlug)}
        summary="The shared shell already understands the workspace slug and route model, so future issue work can focus on data, filters, and interactive workflows."
        items={[
          `Workspace route prefix: /w/${workspaceSlug}`,
          "This stub intentionally avoids client-side whole-table subscriptions.",
          "GitHub repo assignment, PR state, and Wallie runs belong in later feature waves.",
        ]}
      />
    </div>
  );
}
