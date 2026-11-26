import type { RateLimitDisplay } from "@/features/settings/data";

const limitLabels: Record<
  RateLimitDisplay["scope"],
  { action: string; audience: string; description?: string }
> = {
  agentRuns: { action: "Retry an agent run", audience: "workspace member" },
  improvementProposals: {
    action: "Work on an improvement proposal",
    audience: "workspace member",
    description: "Shared across proposal creation, review, and other proposal actions.",
  },
  maintenance: { action: "Run maintenance", audience: "workspace member" },
  phaseAction: {
    action: "Approve, reject, or act on a session",
    audience: "workspace member",
    description: "Shared across stage decisions and related session actions.",
  },
  sessionAttachments: { action: "Upload a session attachment", audience: "workspace member" },
  workspaceInvites: { action: "Send or resend an invitation", audience: "workspace manager" },
};

const countFormat = new Intl.NumberFormat();

function formatWindow(windowMs: number) {
  if (windowMs === 60_000) return "minute";
  if (windowMs === 1_000) return "second";
  return `${countFormat.format(windowMs / 1_000)} seconds`;
}

export function AdvancedRateLimits({ limits }: { limits: RateLimitDisplay[] }) {
  if (!limits.length) {
    return <p className="ui-sheet px-5 py-4 text-sm text-muted">No configured caps to show.</p>;
  }
  return (
    <ul className="ui-sheet divide-y divide-border">
      {limits.map(({ endpoint, max, scope, windowMs }) => {
        const { action, audience, description } = limitLabels[scope];
        return (
          <li className="space-y-2 px-5 py-4" key={scope}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-sm font-semibold text-foreground">{action}</p>
              <p className="text-sm tabular-nums text-muted">
                {`${countFormat.format(max)} ${max === 1 ? "request" : "requests"} per ${formatWindow(windowMs)} per ${audience}`}
              </p>
            </div>
            {description ? <p className="text-xs text-muted">{description}</p> : null}
            <details className="text-xs text-muted">
              <summary
                aria-label={`API details: ${action}`}
                className="w-fit cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                API details
              </summary>
              <code className="mt-1 block break-all text-foreground" translate="no">
                {endpoint}
              </code>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
