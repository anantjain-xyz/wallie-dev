import type { ReactNode } from "react";

import { Status } from "@/components/ui/page-shell";
import { formatSentenceCaseLabel } from "@/lib/labels";

const statusTones = { blocked: "danger", planned: "neutral", ready: "accent" } as const;

type StatusChipProps = {
  children: ReactNode;
  tone?: keyof typeof statusTones;
};

export function StatusChip({ children, tone = "planned" }: StatusChipProps) {
  return (
    <Status tone={statusTones[tone]} withDot={false}>
      {typeof children === "string" ? formatSentenceCaseLabel(children) : children}
    </Status>
  );
}
