import Link from "next/link";

import {
  BellIcon,
  LogoutIcon,
  WorkspaceGlyph,
} from "@/components/shared/linear-icons";
import type { WorkspaceSummary } from "@/lib/auth";
import { workspaceIssuesPath } from "@/lib/routes";

type ShellHeaderProps = {
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
};

export function ShellHeader({ viewerEmail, workspace }: ShellHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-border bg-surface px-5">
      <Link
        href={workspaceIssuesPath(workspace.slug)}
        className="flex min-w-0 items-center gap-2.5"
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-[5px] bg-[#dff3dc] text-[#4d9b57]">
          <WorkspaceGlyph className="h-3.5 w-3.5" />
        </span>
        <span className="truncate text-[13px] font-semibold text-foreground">
          {workspace.name}
        </span>
      </Link>

      <div className="flex items-center gap-2">
        {viewerEmail ? (
          <span className="hidden max-w-[16rem] truncate text-[12px] text-muted lg:block">
            {viewerEmail}
          </span>
        ) : null}

        <button
          type="button"
          className="linear-icon-button"
          aria-label="Notifications Coming Soon"
          disabled
          title="Notifications are not available yet."
        >
          <BellIcon className="h-3.5 w-3.5" />
        </button>

        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="linear-icon-button"
            aria-label="Sign out"
          >
            <LogoutIcon className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </header>
  );
}
