import { StatusChip } from "@/components/shared/status-chip";
import { workspaceLabel } from "@/lib/routes";

type ShellHeaderProps = {
  workspaceSlug: string;
};

export function ShellHeader({ workspaceSlug }: ShellHeaderProps) {
  return (
    <header className="rounded-[2rem] border border-border/90 bg-surface/95 p-6 shadow-[0_24px_80px_rgba(20,33,61,0.08)] backdrop-blur">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-3">
          <StatusChip tone="ready">Shared Shell Scaffold</StatusChip>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted">
              Workspace Route
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {workspaceLabel(workspaceSlug)}
            </h1>
          </div>
          <p className="max-w-3xl text-sm leading-7 text-muted sm:text-base">
            The workspace layout, navigation chrome, and route placeholders are
            in place so future feature agents can drop in data fetching and
            Supabase-backed mutations without revisiting the core shell.
          </p>
        </div>

        <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/80 px-4 py-4 text-sm leading-6 text-muted">
          <p className="font-semibold uppercase tracking-[0.18em] text-foreground">
            Route Model
          </p>
          <p className="mt-2">`/w/[workspaceSlug]/*`</p>
          <p className="mt-1">
            Query-string driven issue list filters will land on this surface.
          </p>
        </div>
      </div>
    </header>
  );
}
