import type { WorkspaceSummary } from "@/lib/auth";
import { StatusChip } from "@/components/shared/status-chip";

type ShellHeaderProps = {
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
};

export function ShellHeader({ viewerEmail, workspace }: ShellHeaderProps) {
  return (
    <header className="rounded-[2rem] border border-border/90 bg-surface/95 p-6 shadow-[0_24px_80px_rgba(20,33,61,0.08)] backdrop-blur">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-3">
          <StatusChip tone="ready">Workspace Active</StatusChip>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted">
              Workspace Route
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {workspace.name}
            </h1>
          </div>
          <p className="max-w-3xl text-sm leading-7 text-muted sm:text-base">
            This workspace shell now resolves through Supabase Auth and
            membership-backed routing, so later gates can layer issue data and
            integrations on top of a real tenant boundary.
          </p>
        </div>

        <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/80 px-4 py-4 text-sm leading-6 text-muted">
          <p className="font-semibold uppercase tracking-[0.18em] text-foreground">
            Session
          </p>
          <p className="mt-2 font-mono text-foreground">
            {`/w/${workspace.slug}/*`}
          </p>
          <p className="mt-1">{viewerEmail ?? "Authenticated member"}</p>
          <form action="/auth/signout" method="post" className="mt-3">
            <button
              type="submit"
              className="rounded-full border border-border/80 bg-background/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/35 hover:text-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
