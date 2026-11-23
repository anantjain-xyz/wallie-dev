import type { ReactNode } from "react";

import type { WorkflowInspection } from "@/lib/factory-workflows/inspection-contracts";

const count = new Intl.NumberFormat("en-US");
const seconds = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});
const elapsed = (milliseconds: number) => `${seconds.format(milliseconds / 1000)} s`;

function shown(value: number | null | undefined, format: (value: number) => string) {
  return value == null ? "Unavailable" : format(value);
}

function reported(
  value: number | null | undefined,
  unavailable: boolean | null | undefined,
  unreported: boolean | null | undefined,
  format: (value: number) => string,
) {
  if (unavailable || unreported) {
    const missing = unavailable ? "Usage unavailable" : "Awaiting usage";
    return value ? `${format(value)} reported · ${missing.toLowerCase()}` : missing;
  }
  return shown(value, format);
}

function BudgetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-border py-2 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="break-words text-right tabular-nums">{children}</dd>
    </div>
  );
}

function limit(value: number | null | undefined, format: (value: number) => string) {
  return value == null ? "" : ` / ${format(value)}`;
}

export function WorkflowInspectionBudget({
  budget: { session, graph },
}: {
  budget: NonNullable<WorkflowInspection["budget"]>;
}) {
  const { limits, usage } = session;
  return (
    <details className="rounded-md border border-border bg-control-muted px-3 py-2">
      <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-accent">
        Execution budget
      </summary>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <h3 className="font-medium">Root session usage</h3>
          {session.exhaustionCode ? (
            <p className="mt-1 break-words text-danger">
              Budget exhausted · {session.exhaustionCode.replaceAll("_", " ")}
            </p>
          ) : null}
          <dl className="text-xs">
            <BudgetRow label="Elapsed time">
              {shown(usage.elapsedMs, elapsed)}
              {limit(limits?.maxExecutionMs, elapsed)}
            </BudgetRow>
            <BudgetRow label="Remaining time">
              {shown(usage.remainingExecutionMs, elapsed)}
            </BudgetRow>
            <BudgetRow label="Repairs">
              {shown(usage.repairAttempts, count.format)}
              {limit(limits?.maxRepairAttempts, count.format)}
            </BudgetRow>
            <BudgetRow label="Tokens">
              {reported(
                usage.totalTokens,
                usage.tokensUnavailable,
                usage.tokensUnreported,
                count.format,
              )}
              {limit(limits?.maxTotalTokens, count.format)}
            </BudgetRow>
            <BudgetRow label="Spend">
              {reported(
                usage.totalCostUsd,
                usage.costUnavailable,
                usage.costUnreported,
                currency.format,
              )}
              {limit(limits?.maxCostUsd, currency.format)}
            </BudgetRow>
          </dl>
        </div>
        {graph ? (
          <div className="min-w-0">
            <h3 className="font-medium">Shared workflow budget</h3>
            <p className="mt-1 text-xs text-muted">Totals include reserved attempts and usage.</p>
            <dl className="text-xs">
              <BudgetRow label="Attempts">
                {count.format(graph.accountedAttempts)}
                {limit(graph.limits.maxAttempts, count.format)}
              </BudgetRow>
              <BudgetRow label="Active children">
                {count.format(graph.activeChildren)}
                {limit(graph.limits.maxConcurrentChildren, count.format)}
              </BudgetRow>
              <BudgetRow label="Total child limit">
                {count.format(graph.limits.maxChildren)}
              </BudgetRow>
              <BudgetRow label="Accounted tokens">
                {count.format(graph.accountedTokens)}
                {limit(graph.limits.maxTotalTokens, count.format)}
              </BudgetRow>
              <BudgetRow label="Accounted spend">
                {currency.format(graph.accountedSpendUsd)}
                {limit(graph.limits.maxCostUsd, currency.format)}
              </BudgetRow>
            </dl>
          </div>
        ) : null}
      </div>
    </details>
  );
}
