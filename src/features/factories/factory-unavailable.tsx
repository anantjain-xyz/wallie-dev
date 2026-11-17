import { PageContainer, PageHeader } from "@/components/ui/page-shell";

export function FactoryUnavailable({ title }: { title: string }) {
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader title={title} />
      <section className="ui-sheet px-6 py-12 text-center">
        <h2 className="text-sm font-semibold text-foreground">Factory unavailable</h2>
        <p className="mt-2 text-sm text-muted">Choose a factory you can access.</p>
      </section>
    </PageContainer>
  );
}
