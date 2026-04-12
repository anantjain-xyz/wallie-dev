"use client";

import Link from "next/link";
import { type ReactNode } from "react";

import { buildSlackThreadHref } from "@/features/sessions/slack";
import type { SessionPullRequest } from "@/features/sessions/types";
import { cn } from "@/lib/utils";

type SessionConnectionsProps = {
  compact?: boolean;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  onRequestLinkLinear?: () => void;
  pullRequestCount: number;
  pullRequests?: SessionPullRequest[];
  slackChannelId: string | null;
  slackThreadTs: string | null;
};

type BadgeState = "linked" | "empty";

function mergedPullRequestState(pullRequests: SessionPullRequest[]): {
  label: string;
  mergedCount: number;
  openCount: number;
} {
  let mergedCount = 0;
  let openCount = 0;
  for (const pr of pullRequests) {
    const state = (pr.pullRequestState ?? "").toLowerCase();
    if (state === "merged") mergedCount += 1;
    else openCount += 1;
  }
  const parts: string[] = [];
  parts.push(`${pullRequests.length} PR${pullRequests.length === 1 ? "" : "s"}`);
  if (mergedCount > 0) parts.push(`${mergedCount} merged`);
  else if (openCount > 0 && pullRequests.length > 0) parts.push("open");
  return { label: parts.join(" · "), mergedCount, openCount };
}

export function SessionConnections({
  compact = false,
  linearIssueId,
  linearIssueUrl,
  onRequestLinkLinear,
  pullRequestCount,
  pullRequests,
  slackChannelId,
  slackThreadTs,
}: SessionConnectionsProps) {
  const slackHref = buildSlackThreadHref(slackChannelId, slackThreadTs);
  const linearState: BadgeState = linearIssueId || linearIssueUrl ? "linked" : "empty";
  const prState: BadgeState = pullRequestCount > 0 ? "linked" : "empty";
  const slackState: BadgeState = slackHref ? "linked" : "empty";

  const prDetails = pullRequests ? mergedPullRequestState(pullRequests) : null;
  const prLabel = prDetails
    ? prDetails.label
    : `${pullRequestCount} PR${pullRequestCount === 1 ? "" : "s"}`;

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", compact ? "text-[11px]" : "text-[12px]")}
    >
      {linearState === "linked" && linearIssueUrl ? (
        <ConnectionBadge
          compact={compact}
          href={linearIssueUrl}
          icon={<LinearGlyph />}
          label={linearIssueId ?? "Linear"}
          tone="linked"
        />
      ) : linearState === "linked" ? (
        <ConnectionBadge
          compact={compact}
          icon={<LinearGlyph />}
          label={linearIssueId ?? "Linear"}
          tone="linked"
        />
      ) : onRequestLinkLinear ? (
        <ConnectionBadge
          compact={compact}
          icon={<LinearGlyph />}
          label="Link Linear…"
          onClick={onRequestLinkLinear}
          tone="empty"
        />
      ) : (
        <ConnectionBadge compact={compact} icon={<LinearGlyph />} label="Linear" tone="empty" />
      )}

      <ConnectionBadge
        compact={compact}
        icon={<GithubGlyph />}
        label={prState === "linked" ? prLabel : "No PRs"}
        tone={prState}
      />

      {slackState === "linked" && slackHref ? (
        <ConnectionBadge
          compact={compact}
          href={slackHref}
          icon={<SlackGlyph />}
          label="Slack thread"
          tone="linked"
        />
      ) : (
        <ConnectionBadge compact={compact} icon={<SlackGlyph />} label="Not linked" tone="empty" />
      )}
    </div>
  );
}

type ConnectionBadgeProps = {
  compact: boolean;
  href?: string;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  tone: "empty" | "linked";
};

function ConnectionBadge({ compact, href, icon, label, onClick, tone }: ConnectionBadgeProps) {
  const classes = cn(
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-medium transition-colors",
    compact ? "h-5 text-[11px]" : "h-6 text-[12px]",
    tone === "linked"
      ? "border-border bg-surface text-foreground hover:bg-surface-muted"
      : "border-dashed border-border bg-transparent text-muted hover:text-foreground",
  );

  if (href) {
    return (
      <Link
        href={href}
        target={href.startsWith("http") ? "_blank" : undefined}
        rel={href.startsWith("http") ? "noreferrer" : undefined}
        className={classes}
      >
        <span className="h-3 w-3 text-current">{icon}</span>
        <span className="truncate">{label}</span>
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        <span className="h-3 w-3 text-current">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
    );
  }

  return (
    <span className={classes}>
      <span className="h-3 w-3 text-current">{icon}</span>
      <span className="truncate">{label}</span>
    </span>
  );
}

function LinearGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 9.5c.3 2.6 2.3 4.7 4.9 5L1.5 9.5zM1.5 7.2l7.3 7.3c.6-.1 1.2-.3 1.8-.5L2 5.4c-.2.6-.4 1.2-.5 1.8zM2.9 3.5l9.7 9.7c.5-.3 1-.7 1.4-1.1L4 2.1c-.4.4-.8.9-1.1 1.4zM5.5 1.3c-.6.3-1.1.7-1.6 1.1l9.7 9.7c.4-.5.8-1 1.1-1.6L5.5 1.3zM14.5 6.2C13.9 3.2 11.3 1 8.1 1c-.1 0-.3 0-.4 0l6.8 6.9c0-.2 0-.4 0-.6 0-.4 0-.7 0-1.1z" />
    </svg>
  );
}

function GithubGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 .2a8 8 0 0 0-2.53 15.59c.4.08.55-.17.55-.39v-1.36c-2.23.48-2.7-1.08-2.7-1.08-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.89.87 2.35.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.97 0-.88.31-1.6.83-2.16-.08-.2-.36-1.02.08-2.13 0 0 .67-.22 2.2.83a7.63 7.63 0 0 1 4 0c1.53-1.05 2.2-.83 2.2-.83.44 1.11.16 1.93.08 2.13.52.56.83 1.28.83 2.16 0 3.08-1.86 3.76-3.64 3.97.29.25.54.73.54 1.48v2.19c0 .22.15.47.55.39A8 8 0 0 0 8 .2z" />
    </svg>
  );
}

function SlackGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.4 10.1a1.6 1.6 0 1 1-1.6-1.6h1.6v1.6zm.8 0a1.6 1.6 0 0 1 3.2 0v4a1.6 1.6 0 0 1-3.2 0v-4zM5.8 3.5A1.6 1.6 0 1 1 7.4 1.9v1.6H5.8zm0 .8a1.6 1.6 0 1 1 0 3.2h-4a1.6 1.6 0 1 1 0-3.2h4zm6.6 1.6a1.6 1.6 0 1 1 1.6 1.6h-1.6V5.9zm-.8 0a1.6 1.6 0 0 1-3.2 0v-4a1.6 1.6 0 0 1 3.2 0v4zm-1.6 6.6a1.6 1.6 0 1 1-1.6 1.6v-1.6h1.6zm0-.8a1.6 1.6 0 1 1 0-3.2h4a1.6 1.6 0 1 1 0 3.2h-4z" />
    </svg>
  );
}
