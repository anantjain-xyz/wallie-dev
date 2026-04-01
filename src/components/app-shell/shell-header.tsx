import type { WorkspaceSummary } from "@/lib/auth";

type ShellHeaderProps = {
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
};

export function ShellHeader({ viewerEmail, workspace }: ShellHeaderProps) {
  return (
    <header className="ui-panel flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-muted">Workspace</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-foreground">
            {workspace.name}
          </h1>
          <span className="ui-pill font-mono">/w/{workspace.slug}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-pill max-w-full truncate">
          {viewerEmail ?? "Authenticated member"}
        </span>
        <form action="/auth/signout" method="post">
          <button type="submit" className="ui-button">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
