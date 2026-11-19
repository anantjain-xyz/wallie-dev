import { PageContainer } from "@/components/ui/page-shell";
import { SkeletonBlock } from "@/components/ui/skeleton";

export default function ScorersLoading() {
  return (
    <PageContainer className="space-y-5 pt-5 sm:pt-10">
      <p className="sr-only" role="status">
        Loading scorers
      </p>
      <SkeletonBlock className="h-9 w-40" />
      <div className="ui-sheet space-y-4 p-4 sm:p-5">
        <SkeletonBlock className="h-6 w-44" />
        <SkeletonBlock className="h-4 w-full max-w-80" />
      </div>
    </PageContainer>
  );
}
