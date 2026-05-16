import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { workspaceLabel } from "@/lib/routes";

type WorkspaceOnboardingPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceOnboardingPage({ params }: WorkspaceOnboardingPageProps) {
  const { workspaceSlug } = await params;

  return (
    <PageContainer>
      <PageHeader
        title="Workspace setup"
        description={`${workspaceLabel(workspaceSlug)} onboarding state is ready for setup checks.`}
      />
      <section className="rounded-[8px] border border-border bg-background p-6 shadow-sm">
        <h2 className="text-[16px] font-semibold text-foreground">Setup status</h2>
        <p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted">
          The workspace onboarding route is available. The full guided setup flow will build on the
          API contracts added in this change.
        </p>
      </section>
    </PageContainer>
  );
}
