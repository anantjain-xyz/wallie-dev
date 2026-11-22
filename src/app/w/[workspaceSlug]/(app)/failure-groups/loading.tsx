import { PageContainer } from "@/components/ui/page-shell";
import { SkeletonBlock } from "@/components/ui/skeleton";

export default function FailureGroupsLoading() {
  return (
    <PageContainer className="space-y-5">
      <p className="sr-only" role="status">
        Loading failure groups
      </p>
      <SkeletonBlock className="h-9 w-44" />
      <div className="ui-sheet space-y-4 p-5">
        <SkeletonBlock className="h-9 w-full max-w-xl" />
        <SkeletonBlock className="h-5 w-full max-w-96" />
        <SkeletonBlock className="h-5 w-full max-w-72" />
      </div>
    </PageContainer>
  );
}
