import type { HTMLAttributes } from "react";

import {
  formatSessionPhaseStatus,
  sessionPhaseStatusTone,
  type SessionPhaseStatus,
} from "@/features/sessions/types";
import { cn } from "@/lib/utils";

const phaseStatusTextClasses: Record<ReturnType<typeof sessionPhaseStatusTone>, string> = {
  blocked: "text-danger",
  planned: "text-muted",
  ready: "text-accent",
};

type SessionPhaseStatusLabelProps = {
  status: SessionPhaseStatus;
} & HTMLAttributes<HTMLSpanElement>;

export function SessionPhaseStatusLabel({
  className,
  status,
  ...props
}: SessionPhaseStatusLabelProps) {
  return (
    <span
      className={cn(phaseStatusTextClasses[sessionPhaseStatusTone(status)], className)}
      {...props}
    >
      {formatSessionPhaseStatus(status)}
    </span>
  );
}
