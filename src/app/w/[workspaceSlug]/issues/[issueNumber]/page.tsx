import { PlaceholderPanel } from "@/components/shared/placeholder-panel";

type IssueDetailPageProps = {
  params: Promise<{
    issueNumber: string;
    workspaceSlug: string;
  }>;
};

export default async function IssueDetailPage({
  params,
}: IssueDetailPageProps) {
  const { issueNumber, workspaceSlug } = await params;

  return (
    <div className="grid gap-6">
      <PlaceholderPanel
        eyebrow="Issue Detail Surface"
        title={`Issue #${issueNumber}`}
        summary="This route reserves the detail workspace for title and description editing, plan and design fields, comments, issue links, GitHub PR state, and Wallie run history."
        items={[
          "Use issue number in the URL and keep any ABC-123 identifier display-only.",
          "Model comments, sub-issues, and relationship rows as explicit workspace-scoped records.",
          "Attach GitHub branch and PR status as separate records instead of overloading the core issue row.",
        ]}
        tone="planned"
      >
        <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/80 px-4 py-4 text-sm leading-7 text-muted">
          Future implementations on this route should hydrate by workspace slug and
          issue number, then keep live updates narrow to the specific records
          under `workspace_id`.
          <br />
          <br />
          Current route: <span className="font-mono text-foreground">/w/{workspaceSlug}/issues/{issueNumber}</span>
        </div>
      </PlaceholderPanel>
    </div>
  );
}
