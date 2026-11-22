import "server-only";

import Link from "next/link";

import { PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { ImprovementAdoptionAction } from "@/features/factory-proposals/improvement-adoption-action";
import { ImprovementOutcomes } from "@/features/factory-proposals/improvement-outcomes";
import type { loadImprovementScope } from "@/features/factory-proposals/improvement-scope";
import { ImprovementTime } from "@/features/factory-proposals/improvement-status";
import { readFactoryImprovementAdoption } from "@/lib/factory-proposals/adoption-server";
import { readFactoryImprovementPublication } from "@/lib/factory-proposals/publication-server";
import { workspaceBenchmarkComparisonPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Scope = NonNullable<Awaited<ReturnType<typeof loadImprovementScope>>>;

async function loadAdoptionReceipts(scope: Scope, proposalId: string, proposalRevisionId: string) {
  const privilegedScope = {
    client: createSupabaseAdminClient(),
    workspaceId: scope.workspaceId,
    factoryId: scope.factoryId,
    actorUserId: scope.actorUserId,
    proposalId,
    proposalRevisionId,
    signal: AbortSignal.timeout(10_000),
  };
  const [publication, adoption] = await Promise.allSettled([
    readFactoryImprovementPublication(privilegedScope),
    readFactoryImprovementAdoption(privilegedScope),
  ]);
  return {
    publication: publication.status === "fulfilled" ? publication.value : null,
    adoption: adoption.status === "fulfilled" ? adoption.value : null,
    missing: publication.status === "rejected" || adoption.status === "rejected",
  };
}

function pullRequestLink(number: number, url: string) {
  const expected = new RegExp(
    `^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/${number}$`,
  );
  return expected.test(url) ? { number, url } : null;
}

function DefinitionDigest({ label, digest }: { label: string; digest: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="type-annotation text-muted">{label}</dt>
      <dd className="font-mono text-xs [overflow-wrap:anywhere]">{digest}</dd>
    </div>
  );
}

export async function ImprovementAdoption({
  scope,
  workspaceSlug,
  proposalId,
  proposalRevisionId,
  historical,
}: {
  scope: Scope;
  workspaceSlug: string;
  proposalId: string;
  proposalRevisionId: string;
  historical: boolean;
}) {
  if (!scope.factory.canManage) return null;
  const { publication, adoption, missing } = await loadAdoptionReceipts(
    scope,
    proposalId,
    proposalRevisionId,
  );
  const evidence = adoption
    ? {
        baseline: adoption.baseline,
        candidate: adoption.adopted,
        comparisons: adoption.comparisons,
      }
    : publication
      ? {
          baseline: publication.base,
          candidate: publication.candidate,
          comparisons: publication.comparisons,
        }
      : null;
  if (!evidence) {
    return (
      <PageSection anchorId="adoption" title="Adoption">
        <p className="ui-sheet type-secondary p-4 text-muted sm:p-5">
          {missing
            ? "Could not load the adoption receipts. Reload to retry."
            : "This revision has no GitHub publication."}
        </p>
      </PageSection>
    );
  }

  const {
    baseline,
    candidate,
    comparisons: { targeted, holdout },
  } = evidence;
  const [{ data: suites }, { data: head }] = await Promise.all([
    scope.supabase
      .from("factory_benchmark_suite_revisions")
      .select("id, suite_id")
      .eq("workspace_id", scope.workspaceId)
      .eq("factory_id", scope.factoryId)
      .in("id", [targeted.suiteRevisionId, holdout.suiteRevisionId]),
    scope.supabase
      .from("factory_definition_activations")
      .select(
        "activation_number, revision_id, factory_definition_revisions!factory_definition_activation_workspace_id_factory_id_revi_fkey(canonical_digest)",
      )
      .eq("workspace_id", scope.workspaceId)
      .eq("factory_id", scope.factoryId)
      .order("activation_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const activeDigest = head?.factory_definition_revisions?.canonical_digest;
  const activeBase =
    head?.activation_number === baseline.activationNumber &&
    head.revision_id === baseline.revisionId &&
    activeDigest === baseline.digest;
  const sameHead = publication?.headCommitSha;
  const pull = adoption
    ? pullRequestLink(adoption.review.pullNumber, adoption.review.pullUrl)
    : publication?.pullRequest
      ? pullRequestLink(publication.pullRequest.number, publication.pullRequest.url)
      : null;
  const command =
    !missing &&
    !adoption &&
    publication?.current &&
    !historical &&
    activeBase &&
    scope.workspaceOperator &&
    pull &&
    sameHead
      ? {
          publicationId: publication.id,
          expectedActivationNumber: baseline.activationNumber,
          candidateDigest: candidate.digest,
          headCommitSha: sameHead,
        }
      : null;
  const comparisons = [
    { label: "Targeted comparison", comparison: targeted },
    { label: "Held-out comparison", comparison: holdout },
  ];

  const adoptionPanel = (
    <PageSection anchorId="adoption" title="Adoption">
      <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {adoption ? <Status compact label="Adopted" value="complete" /> : null}
          {pull ? (
            <a className="ui-button" href={pull.url}>
              GitHub pull request #{pull.number}
            </a>
          ) : null}
          {comparisons.map(({ label, comparison }) => {
            const suite = suites?.find(({ id }) => id === comparison.suiteRevisionId);
            return suite ? (
              <Link
                className="ui-button"
                href={workspaceBenchmarkComparisonPath(
                  workspaceSlug,
                  suite.suite_id,
                  comparison.experimentId,
                  { factory: scope.factoryId },
                )}
                key={label}
                prefetch={false}
              >
                {label}
              </Link>
            ) : (
              <span className="type-secondary text-muted" key={label}>
                {label} unavailable
              </span>
            );
          })}
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <DefinitionDigest
            label={`${activeBase ? "Active base" : "Recorded base"} · Activation ${baseline.activationNumber}`}
            digest={baseline.digest}
          />
          <DefinitionDigest
            label={
              adoption
                ? `Adopted configuration · Activation ${adoption.adopted.activationNumber}`
                : "Candidate configuration"
            }
            digest={candidate.digest}
          />
          {head &&
          activeDigest &&
          !activeBase &&
          head.activation_number !== adoption?.adopted.activationNumber ? (
            <DefinitionDigest
              label={`Current active configuration · Activation ${head.activation_number}`}
              digest={activeDigest}
            />
          ) : null}
          {adoption ? (
            <>
              <DefinitionDigest
                label="Reviewed head commit"
                digest={adoption.review.headCommitSha}
              />
              <DefinitionDigest
                label="GitHub merge commit"
                digest={adoption.review.mergeCommitSha}
              />
            </>
          ) : null}
        </dl>
        {adoption ? (
          <p className="type-secondary text-muted">
            Approved on GitHub by {adoption.review.reviewerLogin}. Adopted{" "}
            <ImprovementTime instant={adoption.createdAt} />.
          </p>
        ) : missing ? (
          <p className="type-secondary text-muted">
            Could not load all adoption receipts. Reload to retry.
          </p>
        ) : historical ? (
          <p className="type-secondary text-muted">Publication for an earlier revision.</p>
        ) : pull && (!publication?.current || !activeBase) ? (
          <p className="type-secondary text-muted">
            The recorded base or proposal changed after publication.
          </p>
        ) : command ? (
          <>
            <p className="type-secondary text-muted">
              Adopt after a human approves and merges this pull request on GitHub.
            </p>
            <ImprovementAdoptionAction
              endpoint={`/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}/adoption`}
              command={command}
            />
          </>
        ) : pull ? (
          <p className="type-secondary text-muted">
            A workspace owner or admin can adopt the reviewed merge.
          </p>
        ) : (
          <p className="type-secondary text-muted">Awaiting a verified GitHub pull request.</p>
        )}
      </div>
    </PageSection>
  );
  return (
    <>
      {adoptionPanel}
      {adoption ? (
        <ImprovementOutcomes scope={scope} workspaceSlug={workspaceSlug} adoption={adoption} />
      ) : null}
    </>
  );
}
