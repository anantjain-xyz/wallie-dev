import { Status, type StatusValue } from "@/components/ui/status";

const dispositions = {
  open: { value: "awaiting_review", label: "Open" },
  investigate: { value: "needs_attention", label: "Investigate" },
  revise: { value: "rejected", label: "Revision requested" },
  dismissed: { value: "archived", label: "Dismissed" },
} satisfies Record<string, { value: StatusValue; label: string }>;

const reviewActions = {
  comment: "Commented",
  investigate: "Requested investigation",
  revise: "Requested revision",
  dismiss: "Dismissed",
};

const date = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function ImprovementTime({ instant }: { instant: string }) {
  return (
    <time className="type-annotation text-muted" dateTime={instant}>
      {date.format(new Date(instant))} UTC
    </time>
  );
}

export function ImprovementStatus({
  status,
  disposition,
  baseCurrent,
}: {
  status: "compiled" | "invalid";
  disposition: keyof typeof dispositions;
  baseCurrent: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Status
        compact
        value={status === "compiled" ? "complete" : "blocked"}
        label={status === "compiled" ? "Compiled" : "Invalid candidate"}
      />
      {!baseCurrent ? <Status compact value="needs_attention" label="Stale base" /> : null}
      <Status compact {...dispositions[disposition]} />
    </div>
  );
}

export function ReviewEventLabel({ action }: { action: keyof typeof reviewActions }) {
  return <span className="type-label text-foreground">{reviewActions[action]}</span>;
}
