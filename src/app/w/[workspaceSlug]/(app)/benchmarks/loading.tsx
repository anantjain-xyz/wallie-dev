import { PageContainer, PageHeader } from "@/components/ui/page-shell";

export default function LoadingBenchmarks() {
  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader title="Benchmarks" />
      <p className="ui-sheet type-secondary px-4 py-5 text-muted sm:px-5" role="status">
        Loading benchmarks…
      </p>
    </PageContainer>
  );
}
