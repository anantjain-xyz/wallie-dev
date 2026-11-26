"use client";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { PageFailure } from "@/components/ui/page-failure";
import { workspaceFailureDestination } from "@/features/workspaces/workspace-failure-destination";
export default function WorkspaceErrorPage({ reset }: { reset: () => void }) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const { href, label } = workspaceFailureDestination(
    workspaceSlug,
    usePathname(),
    useSearchParams().get("returnTo"),
  );
  return <PageFailure reset={reset} returnHref={href} returnLabel={label} />;
}
