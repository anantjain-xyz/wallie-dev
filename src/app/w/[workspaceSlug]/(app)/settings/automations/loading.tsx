import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";

export default function AutomationsLoading() {
  return (
    <PageContainer className="max-w-5xl">
      <PageHeader title="Automations" />
      <PageSection title="Rules">
        <p className="ui-sheet p-4 text-sm text-muted sm:p-6" role="status">
          Loading automation rules…
        </p>
      </PageSection>
    </PageContainer>
  );
}
