"use client";

import { memo, type ReactNode, useMemo, useState } from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { ShimmerText } from "@/components/shared/shimmer-text";
import { TimeDisplay } from "@/components/shared/time-display";
import { agentRunStatusValue } from "@/components/ui/status";
import {
  compactActivityText,
  currentOperationLabel,
  connectionStateCopy,
  isConnectionInterrupted,
  runStatusLabel,
  formatMessageSourceLabel,
  groupActivityMessages,
  isRunActivityStalled,
  lastActivityTimestamp,
  messagesEmptyCopy,
  messagesFailedCopy,
  messagesLoadingCopy,
  type WallieRealtimeConnectionState,
} from "@/features/wallie/activity-summary";
import { parseToolUseMessage, summarizeToolUse } from "@/features/wallie/run-message-body";
import type { WallieRun, WallieRunMessage } from "@/features/wallie/types";
import { LiveConnectionNotice } from "./live-connection-notice";
import { cn } from "@/lib/utils";

function formatStageRunLabel(run: WallieRun) {
  if (run.stageName) return `${run.stageName} run`;
  const stage = run.stageSlug
    ?.split(/[-_\s]+/g)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
  return `${stage || "Session"} run`;
}

function formatRequestedBy(run: WallieRun) {
  const member = run.requestedByMember;
  if (member) {
    if (member.fullName?.trim()) return member.fullName.trim();
    if (member.username?.trim()) return member.username.trim();
    if (member.kind === "system") return "Wallie";
    if (member.role === "owner") return "workspace owner";
    if (member.role === "admin") return "workspace admin";
    return "workspace member";
  }
  return run.requestedByMemberId ? "workspace member" : "Wallie";
}

export type WallieRunCardProps = {
  actionPending: boolean;
  branchName: string | null;
  cancelLocked: boolean;
  cancelControl?: ReactNode;
  connectionState: WallieRealtimeConnectionState;
  isExpanded: boolean;
  isPrimary?: boolean;
  messagesLoaded: boolean;
  messagesLoadFailed: boolean;
  nowMs: number;
  onCancel: (runId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
  onToggle: (runId: string) => void;
  onReconnect?: () => void;
  renderNow: string;
  retryLocked: boolean;
  run: WallieRun;
  stallTimeoutMs: number;
};

export const WallieRunCard = memo(function WallieRunCard({
  actionPending,
  branchName,
  cancelLocked,
  cancelControl,
  connectionState,
  isExpanded,
  isPrimary = false,
  messagesLoaded,
  messagesLoadFailed,
  nowMs,
  onCancel,
  onRetry,
  onToggle,
  onReconnect,
  renderNow,
  retryLocked,
  run,
  stallTimeoutMs,
}: WallieRunCardProps) {
  const runDetailsId = `wallie-run-details-${run.id}`;
  const stalled = isRunActivityStalled({
    createdAt: run.createdAt,
    isActive: run.isActive,
    lastActivityAt: run.lastActivityAt,
    nowMs,
    stallTimeoutMs,
    status: run.status,
  });
  const disconnected = isConnectionInterrupted(connectionState);
  const working = run.isActive && (run.status === "running" || run.status === "started");
  const operation = runStatusLabel({ run, stalled });
  const progress = run.messages.findLast(
    (message) => ["text", "progress", "status"].includes(message.kind) && message.messageMd.trim(),
  );
  const latest = run.messages.at(-1);
  const error =
    run.status === "error" ? run.messages.findLast((message) => message.kind === "error") : null;

  const status = (
    <span
      className={cn(
        "font-medium",
        isPrimary && "rounded-full bg-control-muted px-2 py-0.5 text-xs",
        run.status === "error" && "text-danger",
      )}
      data-status={agentRunStatusValue(run.status)}
      role="status"
    >
      <ShimmerText active={working && !stalled && !disconnected}>{operation}</ShimmerText>
    </span>
  );
  const controls = (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {isPrimary && cancelControl !== undefined ? (
        cancelControl
      ) : run.canCancel ? (
        <button
          aria-label="Cancel run"
          className={cn("ui-button", isPrimary && "text-danger")}
          disabled={cancelLocked}
          onClick={() => void onCancel(run.id)}
          type="button"
        >
          {actionPending ? "Stopping…" : isPrimary ? "Stop run" : "Stop"}
        </button>
      ) : null}
      {run.canRetry ? (
        <button
          className="ui-button"
          disabled={retryLocked}
          onClick={() => void onRetry(run.id)}
          type="button"
        >
          {actionPending ? "Retrying…" : "Retry Run"}
        </button>
      ) : null}
    </div>
  );
  const toggle = (
    <button
      aria-controls={runDetailsId}
      aria-expanded={isExpanded}
      aria-label={`${formatStageRunLabel(run)} activity: ${operation}`}
      className={cn(
        "flex min-h-9 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-[4px] py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        isPrimary ? "text-xs text-muted" : "flex-1 text-sm",
      )}
      onClick={() => onToggle(run.id)}
      type="button"
    >
      <ChevronDownIcon
        className={cn(
          "size-3.5 shrink-0 text-muted transition-transform motion-reduce:transition-none",
          !isExpanded && "-rotate-90",
        )}
      />
      {isPrimary ? (
        isExpanded ? (
          "Hide full log"
        ) : (
          "View full log"
        )
      ) : (
        <>
          {status}
          <span className="text-muted">{formatStageRunLabel(run)}</span>
          {run.startedAt ? (
            <span className="type-annotation tabular-nums text-muted">
              ·{" "}
              <TimeDisplay
                active={run.isActive}
                endValue={run.finishedAt}
                initialNow={renderNow}
                value={run.startedAt}
                variant="elapsed"
              />
            </span>
          ) : null}
        </>
      )}
    </button>
  );

  return (
    <article
      aria-label={isPrimary ? "Current Wallie run" : undefined}
      className={cn(
        "min-w-0",
        isPrimary ? "py-1" : "py-3",
        !isPrimary && !isExpanded && !run.isActive && "run-history-group",
      )}
      data-run-id={run.id}
      data-wallie-summary={isPrimary ? "" : undefined}
    >
      {isPrimary ? (
        <>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-base font-semibold text-foreground">
                  {formatStageRunLabel(run)}
                </h2>
                {status}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted">
                <span>Attempt {run.attemptCount}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {run.status === "queued" ? "Queued for " : "Elapsed "}
                  <TimeDisplay
                    active={run.isActive}
                    endValue={run.finishedAt}
                    initialNow={renderNow}
                    value={run.startedAt ?? run.createdAt}
                    variant="elapsed"
                  />
                </span>
                {run.isActive && run.status !== "queued" ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      Last activity{" "}
                      <TimeDisplay
                        active
                        variant="relative"
                        initialNow={renderNow}
                        value={lastActivityTimestamp(run)}
                      />
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            {controls}
          </div>
          {!isExpanded && run.isActive ? (
            <div className="mt-4 min-w-0 space-y-2 rounded-[6px] bg-control-muted p-3 sm:p-4">
              {latest?.kind === "tool_use" && working && !stalled ? (
                <p className="text-xs text-muted">{currentOperationLabel({ run, stalled })}</p>
              ) : progress && run.status !== "queued" ? (
                <p className="text-xs text-muted">Latest update</p>
              ) : null}
              {progress && run.status !== "queued" ? (
                <div className="text-sm leading-6 text-foreground">
                  <ActivityText text={progress.messageMd} />
                </div>
              ) : (
                <p className="text-sm text-foreground">
                  {run.status === "queued"
                    ? "The worker has not started this run yet."
                    : latest
                      ? "Open the full log for activity details."
                      : "Activity will appear here as the run progresses."}
                </p>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex min-w-0 items-start gap-3">
          {toggle}
          {controls}
        </div>
      )}

      {run.status === "error" ? (
        <p
          className={cn(
            "mt-3 break-words rounded-[6px] text-sm text-danger [overflow-wrap:anywhere]",
            isPrimary ? "bg-danger-soft p-3" : "pl-6",
          )}
          role="status"
        >
          {error
            ? compactActivityText(error.messageMd)
            : "This run failed. Expand activity for details."}
        </p>
      ) : null}
      {isPrimary || isExpanded ? (
        <LiveConnectionNotice
          state={connectionState}
          onRetry={onReconnect}
          className={isPrimary ? undefined : "pl-6"}
        />
      ) : null}
      {stalled ? (
        <p className={cn("mt-2 text-sm text-warning", !isPrimary && "pl-6")} role="status">
          This run may be stalled. Cancel it before retrying.
        </p>
      ) : null}

      {isPrimary ? <div className="mt-3">{toggle}</div> : null}
      <div id={runDetailsId} hidden={!isExpanded}>
        {isExpanded ? (
          <div
            className={cn(
              "mt-3 min-w-0 space-y-3 border-t border-border/40 pt-3",
              !isPrimary && "sm:ml-6",
            )}
          >
            <RunMessageTimeline messages={run.messages} renderNow={renderNow} />
            {messagesLoadFailed ? (
              <p className="text-sm text-danger" role="status">
                {messagesFailedCopy()}
              </p>
            ) : !messagesLoaded ? (
              <p className="text-sm text-muted" role="status">
                <ShimmerText>{messagesLoadingCopy()}</ShimmerText>
              </p>
            ) : run.messages.length === 0 ? (
              <p className="text-sm text-muted">
                {run.isActive ? "No activity recorded yet." : messagesEmptyCopy()}
              </p>
            ) : null}
            <details className="min-w-0 border-t border-border/40 pt-2 type-annotation text-muted">
              <summary className="cursor-pointer py-1 focus-visible:outline-accent">
                Run details
              </summary>
              <dl className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
                <div>
                  <dt>Agent</dt>
                  <dd className="break-all text-foreground">
                    {run.modelProvider}/{run.modelName}
                  </dd>
                </div>
                {!isPrimary ? (
                  <div>
                    <dt>Attempt</dt>
                    <dd className="text-foreground">Attempt {run.attemptCount}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Requester</dt>
                  <dd className="text-foreground">Requested by {formatRequestedBy(run)}</dd>
                </div>
                <div>
                  <dt>Connection</dt>
                  <dd className="text-foreground">{connectionStateCopy(connectionState)}</dd>
                </div>
                <div>
                  <dt>{run.startedAt ? "Started" : "Created"}</dt>
                  <dd className="text-foreground">
                    <TimeDisplay initialNow={renderNow} value={run.startedAt ?? run.createdAt} />
                  </dd>
                </div>
                {run.finishedAt ? (
                  <div>
                    <dt>Ended</dt>
                    <dd className="text-foreground">
                      <TimeDisplay initialNow={renderNow} value={run.finishedAt} />
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Last event</dt>
                  <dd className="text-foreground">
                    <TimeDisplay initialNow={renderNow} value={lastActivityTimestamp(run)} />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt>Run ID</dt>
                  <dd className="break-all font-mono text-foreground">{run.id}</dd>
                </div>
                {branchName ? (
                  <div className="min-w-0">
                    <dt>Branch</dt>
                    <dd className="break-all font-mono text-foreground">{branchName}</dd>
                  </div>
                ) : null}
                {run.sandboxId ? (
                  <div className="min-w-0">
                    <dt>Sandbox</dt>
                    <dd className="break-all font-mono text-foreground">
                      {run.sandboxProvider ? `${run.sandboxProvider}/` : ""}
                      {run.sandboxId}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </details>
          </div>
        ) : null}
      </div>
    </article>
  );
});

function ActivityText({ text }: { text: string }) {
  const compact = compactActivityText(text);
  if (text.trim().length <= 180 && !text.includes("\n")) {
    return <p className="break-words [overflow-wrap:anywhere]">{text}</p>;
  }
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer break-words focus-visible:outline-accent [overflow-wrap:anywhere]">
        {compact}
      </summary>
      <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</p>
    </details>
  );
}

const ActivityMessage = memo(function ActivityMessage({
  message,
  renderNow,
}: {
  message: WallieRunMessage;
  renderNow: string;
}) {
  const [open, setOpen] = useState(false);
  const tool = useMemo(
    () => (message.kind === "tool_use" ? summarizeToolUse(message.messageMd) : null),
    [message.kind, message.messageMd],
  );
  const parsed = useMemo(
    () => (open && tool ? parseToolUseMessage(message.messageMd) : null),
    [open, tool, message.messageMd],
  );
  if (["text", "progress", "completion"].includes(message.kind)) {
    return (
      <div className="py-2 text-sm">
        <ActivityText text={message.messageMd} />
      </div>
    );
  }
  if (message.kind === "error") {
    return (
      <p className="whitespace-pre-wrap break-words py-2 text-sm text-danger [overflow-wrap:anywhere]">
        {message.messageMd.replace(/^\*\*Error:\*\*\s*/, "")}
      </p>
    );
  }
  return (
    <details className="min-w-0 text-sm" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-[4px] py-2 text-muted hover:text-foreground focus-visible:outline-accent">
        <span className="text-foreground">
          {tool?.title ?? formatMessageSourceLabel(message.kind)}
        </span>{" "}
        <span className="ml-2 break-words [overflow-wrap:anywhere]">
          {compactActivityText(tool ? tool.target : message.messageMd, 100)}
        </span>
      </summary>
      {open ? (
        <div className="min-w-0 pb-2 pl-4">
          <div className="mb-2 flex flex-wrap gap-3 type-annotation text-muted">
            <span>
              {tool
                ? `Tool: ${parsed?.tool ?? "Unknown"} · Recorded payload`
                : formatMessageSourceLabel(message.kind)}
            </span>
            <TimeDisplay initialNow={renderNow} value={message.createdAt} />
          </div>
          <pre
            aria-label={tool ? "Tool payload" : "Message details"}
            className="artifact-pre max-h-80 overflow-auto"
            tabIndex={0}
          >
            <code className="artifact-code-block">{parsed?.payload ?? message.messageMd}</code>
          </pre>
        </div>
      ) : null}
    </details>
  );
});

export function RunMessageTimeline({
  messages,
  renderNow,
}: {
  messages: WallieRunMessage[];
  renderNow: string;
}) {
  const groups = useMemo(() => groupActivityMessages(messages), [messages]);
  return (
    <ol aria-label="Run activity" className="min-w-0">
      {groups.map((group) => (
        <li key={group.id} className="min-w-0">
          {group.summary ? (
            <details className="min-w-0 text-sm">
              <summary className="cursor-pointer rounded-[4px] py-2 focus-visible:outline-accent">
                Exploration <span className="ml-2 text-muted">{group.summary}</span>
              </summary>
              <div className="ml-2 min-w-0 border-l border-border/40 pl-3">
                {group.messages.map((message) => (
                  <ActivityMessage key={message.id} message={message} renderNow={renderNow} />
                ))}
              </div>
            </details>
          ) : (
            <ActivityMessage message={group.messages[0]} renderNow={renderNow} />
          )}
        </li>
      ))}
    </ol>
  );
}
