import type { RoutingQualificationStatus } from "@/lib/model-routing/qualification-status";

const reasonLabels: Record<string, string> = {
  missing_proposal: "Apply a qualified benchmark finding to this routing draft.",
  candidate_unavailable: "The exact benchmark candidate is unavailable.",
  definition_changed: "The definition differs from the qualified revision.",
  model_changed: "The configured model differs from the benchmarked model.",
  harness_changed: "The configured harness differs from the benchmarked harness.",
  runtime_changed: "The configured worker runtime differs from the benchmarked runtime.",
  qualification_changed: "The execution qualification differs from the frozen benchmark.",
  capability_unavailable: "The benchmarked execution capability is unavailable.",
  sandbox_connection_changed: "The sandbox connection differs from the benchmarked connection.",
  toolchain_changed: "The toolchain differs from the benchmarked toolchain.",
  suite_revision_changed: "The benchmark suite has a newer revision.",
  scorer_revision_changed: "The scoring rubric has a newer revision.",
  scorer_unavailable: "The frozen scoring rubric is unavailable.",
  replay_policy_revoked: "The benchmark replay policy or a fixture was revoked.",
};

export function RoutingQualificationNotice({
  status,
  subject,
}: {
  status?: RoutingQualificationStatus;
  subject: "Draft" | "Published" | "Selected";
}) {
  if (status?.status !== "stale") return null;
  const reasons = new Set([
    ...status.reasons,
    ...status.targets.flatMap((target) => target.reasons),
  ]);
  return (
    <div className="type-secondary rounded-[6px] border border-border bg-control-muted p-3">
      <p className="font-medium text-foreground">{subject} routing needs requalification</p>
      {reasons.size ? (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
          {[...reasons].map((reason) => (
            <li key={reason}>
              {reasonLabels[reason] ?? "A routing input differs from its qualified evidence."}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
