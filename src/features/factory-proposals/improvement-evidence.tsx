import "server-only";

import Link from "next/link";
import type { z } from "zod/v4";

import { PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { runAttemptHref } from "@/features/factory-scorers/run-evaluation-governance";
import { browserEvidencePath } from "@/features/wallie/browser-evidence-contracts";
import {
  diagnosisReceiptSchema,
  type diagnosisMemberSchema,
} from "@/lib/factory-diagnosis/contracts";
import {
  workspaceAgentDetailPath,
  workspaceFailureGroupPath,
  workspaceRunDetailPath,
} from "@/lib/routes";

type Diagnosis = z.infer<typeof diagnosisReceiptSchema>;
type DiagnosisMember = z.infer<typeof diagnosisMemberSchema>;
type EvidenceScope = { workspaceSlug: string; workspaceId: string; factoryId: string };

function ExactEvidence({
  member,
  workspaceSlug,
}: {
  member: DiagnosisMember;
  workspaceSlug: string;
}) {
  const evidenceLink =
    member.source_kind === "scorer" && member.evaluation_attempt_id
      ? {
          href: runAttemptHref(workspaceSlug, member.run_id, member.evaluation_attempt_id),
          label: "Open evaluation",
        }
      : member.source_kind === "validation"
        ? {
            href: browserEvidencePath(member.session_id, { runId: member.run_id }),
            label: "Open validation receipt",
          }
        : null;

  return (
    <li id={`evidence-${member.member_id}`} className="min-w-0 space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className="type-label font-semibold underline-offset-4 hover:underline"
          href={workspaceRunDetailPath(workspaceSlug, member.run_id, {
            attempt: member.run_attempt_count,
          })}
          prefetch={false}
        >
          Run {member.run_id.slice(0, 8)}
        </Link>
        <span className="type-annotation text-muted">Attempt {member.run_attempt_count}</span>
      </div>
      {member.validation_record_key ? (
        <p className="type-secondary text-muted [overflow-wrap:anywhere]">
          {member.validation_record_key}
        </p>
      ) : null}
      {evidenceLink ? (
        <Link className="ui-button" href={evidenceLink.href} prefetch={false}>
          {evidenceLink.label}
        </Link>
      ) : null}
    </li>
  );
}

export function ImprovementEvidence({
  diagnosis,
  diagnosisId,
  cohortId,
  scope,
}: {
  diagnosis: Diagnosis | null;
  diagnosisId: string;
  cohortId: string | null;
  scope: EvidenceScope;
}) {
  const { workspaceSlug, workspaceId, factoryId } = scope;
  const visible = diagnosis?.evidence_state === "available";
  const claims = visible ? (diagnosis.result?.claims ?? []) : [];
  const citedIds = new Set(claims.flatMap(({ member_ids }) => member_ids));
  const evidence = visible
    ? (diagnosis.evidence ?? []).filter((member) => citedIds.has(member.member_id))
    : [];

  return (
    <PageSection anchorId="evidence" title="Evidence and attribution">
      <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {cohortId ? (
            <Link
              className="ui-button"
              href={workspaceFailureGroupPath(workspaceSlug, cohortId, { factory: factoryId })}
              prefetch={false}
            >
              Open failure group
            </Link>
          ) : null}
          {diagnosis ? (
            <Link
              className="ui-button"
              href={`/api/workspaces/${workspaceId}/factories/${factoryId}/diagnoses/${diagnosisId}`}
              prefetch={false}
            >
              Open diagnosis receipt
            </Link>
          ) : null}
        </div>
        {diagnosis ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <dt className="type-annotation text-muted">Diagnosis agent</dt>
              <dd>
                <Link
                  className="underline underline-offset-4 [overflow-wrap:anywhere]"
                  href={workspaceAgentDetailPath(workspaceSlug, diagnosis.agent_id, {
                    factory: factoryId,
                    revision: diagnosis.prompt_revision_id,
                  })}
                  prefetch={false}
                >
                  Agent {diagnosis.agent_id.slice(0, 8)} · Prompt{" "}
                  {diagnosis.prompt_revision_id.slice(0, 8)}
                </Link>
              </dd>
            </div>
            <div className="min-w-0 space-y-1">
              <dt className="type-annotation text-muted">Diagnosis model</dt>
              <dd className="[overflow-wrap:anywhere]">{diagnosis.model_id}</dd>
            </div>
          </dl>
        ) : null}
        {!visible ? (
          <div className="space-y-2">
            <Status compact value="blocked" label="Evidence unavailable" />
            <p className="type-secondary text-muted">
              The saved proposal and its discussion remain available.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Status
                compact
                value={
                  diagnosis.support_count < diagnosis.minimum_support
                    ? "needs_attention"
                    : "complete"
                }
                label={
                  diagnosis.support_count < diagnosis.minimum_support
                    ? "Inconclusive evidence"
                    : "Retained evidence"
                }
              />
              <p className="type-secondary text-muted">
                {diagnosis.support_count} of {diagnosis.minimum_support} independent sessions needed
                for qualified support
              </p>
            </div>
            {diagnosis.result ? (
              <div className="space-y-1">
                <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {diagnosis.result.summary}
                </p>
                <p className="type-secondary whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
                  {diagnosis.result.uncertainty}
                </p>
              </div>
            ) : null}
            {claims.length ? (
              <ul
                className="divide-y divide-border rounded-md border border-border"
                aria-label="Cited hypotheses"
              >
                {claims.map((claim, index) => (
                  <li key={index} className="min-w-0 space-y-1 p-3">
                    <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {claim.inferred_cause}
                    </p>
                    <p className="type-secondary whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
                      {claim.uncertainty}
                    </p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {evidence
                        .filter((member) => claim.member_ids.includes(member.member_id))
                        .map((member) => (
                          <a
                            key={member.member_id}
                            className="type-annotation text-accent underline underline-offset-4"
                            href={`#evidence-${member.member_id}`}
                          >
                            Run {member.run_id.slice(0, 8)} · Attempt {member.run_attempt_count}
                          </a>
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {evidence.length ? (
              <ul
                aria-label="Cited run evidence"
                className="divide-y divide-border rounded-md border border-border"
              >
                {evidence.map((member) => (
                  <ExactEvidence
                    key={member.member_id}
                    member={member}
                    workspaceSlug={workspaceSlug}
                  />
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </PageSection>
  );
}
