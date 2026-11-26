"use client";
import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { PageFailure } from "@/components/ui/page-failure";
import { workspaceFailureDestination } from "@/features/workspaces/workspace-failure-destination";
export default function WorkspaceNotFoundPage() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const { href, label } = workspaceFailureDestination(
    workspaceSlug,
    usePathname(),
    useSearchParams().get("returnTo"),
  );
  return (
    <PageFailure
      notFound
      description="The link may be outdated or access may be restricted. Check your account, or ask the person who shared the link for an invitation or an updated link."
      returnHref={href}
      returnLabel={label}
      actions={
        <Link className="ui-button" href="/recovery">
          Get help
        </Link>
      }
    />
  );
}
