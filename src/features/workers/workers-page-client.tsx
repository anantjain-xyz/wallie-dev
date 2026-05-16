"use client";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { StatusBadge } from "@/features/settings/settings-ui";
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

function StatCell({
  label,
  value,
  tone,
}: {
  label: string;
  tone?: string;
  value: number | string;
}) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <span className={`text-[20px] font-semibold tracking-tight ${tone ?? "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

function QueueOverview({ queue }: { queue: QueueStats }) {
  const errorRate =
    queue.totalCount > 0 ? ((queue.errorCount / queue.totalCount) * 100).toFixed(1) : "0.0";

  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface sm:grid-cols-5 sm:divide-y-0">
      <StatCell label="Queued" value={queue.queuedCount} />
      <StatCell label="Running" value={queue.runningCount} tone="text-accent" />
      <StatCell label="Success" value={queue.successCount} tone="text-success" />
      <StatCell label="Error" value={queue.errorCount} tone="text-danger" />
      <StatCell label="Error rate" value={`${errorRate}%`} />
    </div>
  );
}

function WorkerRow({ worker }: { worker: WorkerSummary }) {
  const isActive = worker.status === "active";

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${isActive ? "bg-success" : "bg-danger"}`}
            aria-hidden="true"
          />
          <span className="font-mono text-[13px] font-semibold text-foreground">
            {worker.workerId}
          </span>
          <span className="text-[11px] text-muted">{isActive ? "active" : "stale"}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
          <span>Started {dateTimeFormatter.format(new Date(worker.startedAt))}</span>
          <span>Last heartbeat {relativeTime(worker.lastHeartbeatAt)}</span>
          {worker.activeJobId ? (
            <span className="font-mono">Job: {worker.activeJobId.slice(0, 8)}…</span>
          ) : (
            <span>Idle</span>
          )}
        </div>
      </div>
    </li>
  );
}

function RecentErrorRow({ error }: { error: WorkerHealthPageData["recentErrors"][number] }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
      <div className="min-w-0 flex-1">
        {error.sessionTitle && error.sessionId ? (
          <p className="truncate text-[13px] font-medium text-foreground">{error.sessionTitle}</p>
        ) : (
          <p className="truncate font-mono text-[12px] text-muted">{error.id.slice(0, 12)}…</p>
        )}
        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-danger">
          {error.lastError ?? "Unknown error"}
        </p>
      </div>
      <span className="shrink-0 text-[11px] text-muted">{relativeTime(error.createdAt)}</span>
    </li>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-[10px] border border-dashed border-border bg-surface-strong px-6 py-12 text-center text-[13px] leading-5 text-muted">
      {children}
    </div>
  );
}

export function WorkerHealthPageClient({ initialData }: WorkerHealthPageClientProps) {
  const { queue, recentErrors, workers } = initialData;
  const activeCount = workers.filter((w) => w.status === "active").length;

  return (
    <PageContainer>
      <PageHeader
        title="Workers"
        description="Monitor worker processes, queue depth, and error rates."
      />

      <div className="space-y-16">
        <PageSection
          title="Queue"
          tagline="Aggregate state of in-flight, completed, and failed jobs across all workers."
        >
          <QueueOverview queue={queue} />
        </PageSection>

        <PageSection
          title="Workers"
          tagline="Active worker processes and their last heartbeat."
          statusBadge={
            <StatusBadge tone={activeCount > 0 ? "success" : "neutral"}>
              {activeCount} active · {workers.length} total
            </StatusBadge>
          }
        >
          {workers.length === 0 ? (
            <EmptyState>
              No workers have registered yet. Start a worker process to see it here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface">
              {workers.map((worker) => (
                <WorkerRow key={worker.workerId} worker={worker} />
              ))}
            </ul>
          )}
        </PageSection>

        <PageSection
          title="Recent errors"
          tagline="Failed jobs from the last 24 hours. Investigate by opening the linked session."
        >
          {recentErrors.length === 0 ? (
            <EmptyState>No recent errors.</EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface">
              {recentErrors.map((error) => (
                <RecentErrorRow key={error.id} error={error} />
              ))}
            </ul>
          )}
        </PageSection>
      </div>
    </PageContainer>
  );
}
