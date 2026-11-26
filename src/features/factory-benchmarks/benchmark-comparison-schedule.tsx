import type { BenchmarkComparison } from "@/lib/factory-benchmarks/comparison-contracts";

export type BenchmarkScheduleHandoff =
  | { kind: "resume" | "fixture"; endpoint: string }
  | { kind: "live"; endpoint: string; connectionRevision: string }
  | { kind: "blocked"; reason: string };

export function comparisonScheduleHandoff({
  canConfigure,
  comparison,
  endpoint,
  policyProfile,
  pins,
}: {
  canConfigure: boolean;
  comparison: Pick<BenchmarkComparison, "scheduleState" | "candidateCount"> & {
    counts: Pick<BenchmarkComparison["counts"], "eligible">;
  };
  endpoint: string;
  policyProfile?: string;
  pins?: readonly {
    qualification_id: string | null;
    live_inference_connection_revision: string | null;
    sandbox_connection_revision: string | null;
    worker_runtime: string;
  }[];
}): BenchmarkScheduleHandoff | undefined {
  if (comparison.scheduleState !== "unconfigured" && comparison.scheduleState !== "paused") return;
  if (!canConfigure) return { kind: "blocked", reason: "This comparison is read-only." };
  if (comparison.scheduleState === "paused") return { kind: "resume", endpoint };
  if (!comparison.counts.eligible) {
    return {
      kind: "blocked",
      reason:
        "No trials in this revision are eligible to schedule. Review the excluded trials and prepare a new suite revision.",
    };
  }
  if (!pins?.length || pins.length !== comparison.candidateCount || !policyProfile) {
    return {
      kind: "blocked",
      reason:
        "The frozen scheduling inputs are unavailable. Ask a factory manager to verify the historical pins.",
    };
  }
  if (
    (policyProfile === "recorded_fixtures" || policyProfile === "isolated_test") &&
    pins.every((pin) => !pin.qualification_id)
  )
    return { kind: "fixture", endpoint };
  const connectionRevision = pins[0].live_inference_connection_revision;
  const sandboxRevision = pins[0].sandbox_connection_revision;
  if (
    policyProfile === "blocked" &&
    connectionRevision &&
    sandboxRevision &&
    pins.every(
      (pin) =>
        pin.qualification_id &&
        pin.worker_runtime === "workerd" &&
        pin.live_inference_connection_revision === connectionRevision &&
        pin.sandbox_connection_revision === sandboxRevision,
    )
  ) {
    return { kind: "live", endpoint, connectionRevision };
  }
  return {
    kind: "blocked",
    reason:
      "No existing runner can use this combination of frozen qualifications, runtime, connection and replay policy. To run trials, prepare a new comparison with supported exact pins.",
  };
}

const scheduleDocs =
  "https://github.com/anantjain-xyz/wallie-dev/blob/main/docs/architecture/benchmark-suites.md#schedule-a-frozen-experiment";

export function BenchmarkComparisonSchedule({
  state,
  handoff,
}: {
  state: BenchmarkComparison["scheduleState"];
  handoff?: BenchmarkScheduleHandoff;
}) {
  const status = {
    unconfigured: {
      title: "Trials haven’t started",
      detail:
        "This comparison is frozen, but no schedule exists. Planned trials won’t start on their own.",
    },
    paused: {
      title: "Schedule paused",
      detail:
        "No new trials are admitted or claimed while paused. Already claimed trials can finish.",
    },
    active: {
      title: "Schedule active",
      detail:
        "The worker admits eligible trials within the schedule’s limits. Active does not mean every trial is running.",
    },
    canceled: {
      title: "Schedule canceled",
      detail: "This schedule can’t be resumed.",
    },
  }[state];

  return (
    <div className="space-y-2 px-4 py-4 sm:px-5">
      <h3 className="type-label">{status.title}</h3>
      <p className="text-muted">{status.detail}</p>
      {handoff?.kind === "blocked" ? <p>{handoff.reason}</p> : null}
      {handoff && handoff.kind !== "blocked" ? (
        <>
          <p>
            A factory manager with an authenticated session can{" "}
            {handoff.kind === "resume" ? "resume" : "configure"} this comparison through the{" "}
            <a className="underline underline-offset-4 hover:text-accent" href={scheduleDocs}>
              benchmark schedule API runbook
            </a>
            . Review the exact pins, trial limit, concurrency and budget before submitting anything.
            The budget limits admission based on reserves and known costs; it is not a hard cap on
            provider charges. Do not proceed if you need a guaranteed spend ceiling.
          </p>
          <details className="space-y-2 [overflow-wrap:anywhere]">
            <summary className="type-label w-fit cursor-pointer">Schedule API details</summary>
            <p>Check the current schedule with GET, then POST JSON to the same endpoint:</p>
            <code className="type-annotation">{handoff.endpoint}</code>
            {handoff.kind === "resume" ? (
              <p>
                Send <code>{'{"action":"resume"}'}</code> only after reviewing the frozen pins and
                the schedule limits returned by GET.
              </p>
            ) : (
              <>
                <p>
                  A 404 on GET can mean the schedule is not configured. Use{" "}
                  <code>action: configure</code> with{" "}
                  {handoff.kind === "live" ? (
                    <>
                      runner <code>openai-responses-v1</code> and exact{" "}
                      <code>inferenceConnectionRevision</code>{" "}
                      <code>{handoff.connectionRevision}</code>. Confirm the pinned connection and
                      worker deployment are still available; never choose a newer revision in its
                      place.
                    </>
                  ) : (
                    <>
                      runner <code>recorded-fixture-v1</code>, an approved connected Vercel revision
                      and one approved <code>tool_read</code> fixture key for each eligible frozen
                      task revision. This runner replays recorded fixtures, not live configurations.
                    </>
                  )}
                </p>
                <p>
                  Set <code>maxAdmittedTrials</code>, <code>factoryConcurrencyLimit</code>,{" "}
                  <code>budgetLimitUsd</code>, <code>executionReserveUsd</code> and{" "}
                  <code>evaluationReserveUsd</code> explicitly. A successful configure activates the
                  schedule. Use GET afterward to check admission, reservations and unavailable
                  costs.
                </p>
              </>
            )}
          </details>
        </>
      ) : null}
    </div>
  );
}
