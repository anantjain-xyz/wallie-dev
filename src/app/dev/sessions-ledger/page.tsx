import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import { SessionLedgerRow } from "@/features/sessions/list/session-ledger-row";
import { SessionsLedger } from "@/features/sessions/list/session-row-actions";
import type { SessionListItem } from "@/features/sessions/types";

const ROW_COUNT = 50;
const INITIAL_NOW = "2026-07-18T12:00:00.000Z";

function makeSession(index: number): SessionListItem {
  const padded = String(index).padStart(3, "0");
  return {
    archivedAt: null,
    createdAt: "2026-07-18T10:00:00.000Z",
    currentArtifactVersion: 1,
    currentStageId: "stage-plan",
    currentStageName: "Plan",
    currentStagePosition: 0,
    currentStageSlug: "plan",
    id: `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee${padded}`,
    linearIssueId: index % 7 === 0 ? `OP-${index}` : null,
    linearIssueUrl: index % 7 === 0 ? `https://linear.app/issue/OP-${index}` : null,
    number: index,
    phaseStatus: "awaiting_review",
    pipelineId: "pipeline-1",
    pullRequestCount: index % 5 === 0 ? 1 : 0,
    pullRequests:
      index % 5 === 0
        ? [
            {
              branchName: `feat/session-${index}`,
              id: `pr-${index}`,
              isDraft: false,
              pullRequestNumber: 1000 + index,
              pullRequestState: "open",
              pullRequestUrl: `https://github.com/example/repo/pull/${1000 + index}`,
              repositoryFullName: "example/repo",
              repositoryHtmlUrl: "https://github.com/example/repo",
              updatedAt: "2026-07-18T11:00:00.000Z",
            },
          ]
        : [],
    rejectionCount: 0,
    title: `Seeded ledger session ${index}`,
    updatedAt: "2026-07-18T11:30:00.000Z",
    workspaceId: "workspace-fixture",
  };
}

/**
 * Non-production fixture: 50 real ledger rows for hydration / responsive checks.
 */
export default function SessionsLedgerFixturePage() {
  if (isProductionDeploy()) notFound();

  const sessions = Array.from({ length: ROW_COUNT }, (_, index) => makeSession(index + 1));

  return (
    <main
      id="main-content"
      className="mx-auto max-w-[1080px] px-4 py-8 sm:px-8"
      data-sessions-ledger-fixture="50"
    >
      <h1 className="type-page-title">Sessions ledger fixture</h1>
      <p className="mt-2 type-body text-muted">
        Fifty seeded rows using the production SessionLedgerRow / island split.
      </p>

      <div className="mt-8">
        <SessionsLedger>
          {sessions.map((session) => (
            <SessionLedgerRow
              key={session.id}
              initialNow={INITIAL_NOW}
              scope="all"
              session={session}
              workspaceSlug="fixture"
            />
          ))}
        </SessionsLedger>
      </div>
    </main>
  );
}
