import type { ReactNode } from "react";

import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import type { ExecutionRequirements } from "@/lib/execution-policy/contracts";

export type GovernancePolicy = {
  id: string;
  label: string;
  requirements: ExecutionRequirements | null;
};

export function PolicyLimits({ policy }: { policy?: GovernancePolicy }) {
  if (!policy) return null;
  const requirements = policy.requirements;
  return (
    <p className="type-secondary mt-1 text-muted">
      {requirements ? (
        <>
          Repairs: {requirements.maxRepairAttempts} · Time: {requirements.maxExecutionMs / 1000} s ·
          Tokens: {requirements.maxTotalTokens ?? "No cap"} · Spend:{" "}
          {requirements.maxCostUsd === null ? "No cap" : `$${requirements.maxCostUsd} USD`}
        </>
      ) : (
        "Policy limits are unavailable."
      )}
    </p>
  );
}

export function GrantScopeSummary({
  commands,
  expires,
  payer,
  policy,
  principal,
  readOnly,
  tools,
  writable,
}: {
  commands: string[];
  expires: ReactNode;
  payer: ReactNode;
  policy?: GovernancePolicy;
  principal: ReactNode;
  readOnly: string[];
  tools: string[];
  writable: ReactNode;
}) {
  return (
    <MetadataList>
      <MetadataItem label="Service principal" value={principal} />
      <MetadataItem label="Writable repository" value={writable} />
      <MetadataItem label="Read-only repositories" value={readOnly.join(", ") || "None"} />
      <MetadataItem label="Tool operations" value={tools.join(", ") || "None"} />
      <MetadataItem label="Machine command scopes" value={commands.join(", ") || "None"} />
      <MetadataItem
        label="Execution policy"
        value={
          policy ? (
            <>
              {policy.label}
              <PolicyLimits policy={policy} />
            </>
          ) : (
            "Policy revision unavailable or not selected"
          )
        }
      />
      <MetadataItem label="Budget payer" value={payer} />
      <MetadataItem label="Expires at" value={expires} />
    </MetadataList>
  );
}
