"use client";

import { Spinner } from "@/components/shared/spinner";
import { cn } from "@/lib/utils";
import {
  connectionStateCopy,
  isConnectionInterrupted,
  type WallieRealtimeConnectionState,
} from "./activity-summary";

export function LiveConnectionNotice({
  state,
  onRetry,
  className,
}: {
  state: WallieRealtimeConnectionState;
  onRetry?: () => void;
  className?: string;
}) {
  if (!isConnectionInterrupted(state) && state !== "recovered") return null;
  return (
    <div className={cn("mt-2 flex flex-wrap items-center gap-2 text-sm text-warning", className)}>
      <p className="flex items-center gap-2" role="status">
        {state === "reconnecting" ? <Spinner className="size-3" /> : null}
        {connectionStateCopy(state)}
      </p>
      {onRetry && isConnectionInterrupted(state) && state !== "offline" ? (
        <button className="ui-button" type="button" onClick={onRetry}>
          Retry now
        </button>
      ) : null}
    </div>
  );
}
