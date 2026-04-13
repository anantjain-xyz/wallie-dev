"use client";

import type { WorkerHealthPageData, WorkerSummary, QueueStats } from "@/features/workers/data";

type WorkerHealthPageClientProps = {
  initialData: WorkerHealthPageData;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  second: "2-digit",
});

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  tone?: string;
  value: number | string;
}) {
  return (
    <div className="ui-subpanel p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function QueueOverview({ queue }: { queue: QueueStats }) {
  const errorRate =
    queue.totalCount > 0 ? ((queue.errorCount / queue.totalCount) * 100).toFixed(1) : "0.0";

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold tracking-tight text-foreground">Queue</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Queued" value={queue.queuedCount} />
        <StatCard label="Running" value={queue.runningCount} tone="text-accent" />
        <StatCard label="Success" value={queue.successCount} tone="text-success" />
        <StatCard label="Error" value={queue.errorCount} tone="text-danger" />
        <StatCard label="Error Rate" value={`${errorRate}%`} />
      </div>
    </div>
  );
}

function WorkerRow({ worker }: { worker: WorkerSummary }) {
  const isActive = worker.status === "active";

  return (
    <div className="ui-subpanel flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${isActive ? "bg-success" : "bg-danger"}`}
            aria-hidden="true"
          />
          <span className="font-mono text-sm font-semibold text-foreground">{worker.workerId}</span>
          <span className="text-xs text-muted">{isActive ? "active" : "stale"}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
          <span>Started {dateTimeFormatter.format(new Date(worker.startedAt))}</span>
          <span>Last heartbeat {relativeTime(worker.lastHeartbeatAt)}</span>
          {worker.activeJobId ? (
            <span className="font-mono">Job: {worker.activeJobId.slice(0, 8)}…</span>
          ) : (
            <span>Idle</span>
          )}
        </div>
      </div>
    </div>
  );
}

function RecentErrorRow({ error }: { error: WorkerHealthPageData["recentErrors"][number] }) {
  return (
    <div className="ui-subpanel p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {error.sessionTitle && error.sessionId ? (
            <p className="text-sm font-semibold text-foreground truncate">{error.sessionTitle}</p>
          ) : (
            <p className="text-sm font-mono text-muted">{error.id.slice(0, 12)}…</p>
          )}
          <p className="mt-1 text-xs text-danger line-clamp-2">
            {error.lastError ?? "Unknown error"}
          </p>
        </div>
        <span className="shrink-0 text-[10px] text-muted">{relativeTime(error.createdAt)}</span>
      </div>
    </div>
  );
}

export function WorkerHealthPageClient({ initialData }: WorkerHealthPageClientProps) {
  const { queue, recentErrors, workers, workspace } = initialData;
  const activeCount = workers.filter((w) => w.status === "active").length;

  return (
    <div className="min-h-full bg-[#f6f5f2] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="rounded-[24px] bg-surface px-6 py-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_14px_32px_rgba(16,24,40,0.06)] sm:px-8 sm:py-8">
          <p className="ui-label">Worker Infrastructure</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-foreground">
            Workers
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
            Monitor worker processes, queue depth, and error rates for{" "}
            <span className="font-semibold text-foreground">{workspace.name}</span>.
          </p>
        </header>

        <section className="rounded-[20px] bg-surface px-5 py-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_28px_rgba(16,24,40,0.05)] sm:px-6 sm:py-6">
          <QueueOverview queue={queue} />
        </section>

        <section className="rounded-[20px] bg-surface px-5 py-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_28px_rgba(16,24,40,0.05)] sm:px-6 sm:py-6">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Workers ({activeCount} active, {workers.length} total)
          </h2>
          <div className="mt-5 space-y-3">
            {workers.length === 0 ? (
              <div className="ui-subpanel p-5 text-center text-sm text-muted">
                No workers have registered yet. Start a worker process to see it here.
              </div>
            ) : (
              workers.map((worker) => <WorkerRow key={worker.workerId} worker={worker} />)
            )}
          </div>
        </section>

        <section className="rounded-[20px] bg-surface px-5 py-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_28px_rgba(16,24,40,0.05)] sm:px-6 sm:py-6">
          <h2 className="text-base font-semibold tracking-tight text-foreground">Recent Errors</h2>
          <div className="mt-5 space-y-3">
            {recentErrors.length === 0 ? (
              <div className="ui-subpanel p-5 text-center text-sm text-muted">
                No recent errors.
              </div>
            ) : (
              recentErrors.map((error) => <RecentErrorRow key={error.id} error={error} />)
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
