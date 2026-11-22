import { PageContainer } from "@/components/ui/page-shell";
import { SkeletonBlock } from "@/components/ui/skeleton";

export default function ImprovementsLoading() {
  return (
    <PageContainer className="space-y-5">
      <p className="sr-only" role="status">
        Loading improvements
      </p>
      <SkeletonBlock className="h-9 w-44" />
      <div className="ui-sheet space-y-4 p-5">
        <SkeletonBlock className="h-6 w-full max-w-xl" />
        <SkeletonBlock className="h-5 w-full max-w-96" />
      </div>
    </PageContainer>
  );
}
