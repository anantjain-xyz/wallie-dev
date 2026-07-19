import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import { SessionLedgerRow } from "@/features/sessions/list/session-ledger-row";
import { SessionsCommandBar } from "@/features/sessions/list/sessions-command-bar";
import { SessionsLedger } from "@/features/sessions/list/session-row-actions";
import { SessionsZeroState } from "@/features/sessions/components/sessions-zero-state";
import type { SessionListItem } from "@/features/sessions/types";

const ROW_COUNT = 50;
const INITIAL_NOW = "2026-07-18T12:00:00.000Z";

function makeSession(index: number): SessionListItem {
  const padded = String(index).padStart(3, "0");
  const awaiting = index % 3 === 0;
  return {
    archivedAt: null,
    createdAt: "2026-07-18T10:00:00.000Z",
    currentArtifactVersion: 1,
    currentStageId: "stage-plan",
    currentStageName: index % 2 === 0 ? "Plan" : "Build",
    currentStagePosition: index % 2 === 0 ? 0 : 1,
    currentStageSlug: index % 2 === 0 ? "plan" : "build",
    id: `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee${padded}`,
    linearIssueId: index % 7 === 0 ? `OP-${index}` : null,
    linearIssueUrl: index % 7 === 0 ? `https://linear.app/issue/OP-${index}` : null,
    number: index,
    phaseStatus: awaiting ? "awaiting_review" : "agent_generating",
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
    repositoryFullName: index % 4 === 0 ? "acme/wallie" : index % 5 === 0 ? "example/repo" : null,
    title: `Seeded ledger session ${index}`,
    updatedAt: "2026-07-18T11:30:00.000Z",
    workspaceId: "workspace-fixture",
  };
}

/**
 * Non-production fixture: command bar + 50 real ledger rows for hydration /
 * responsive / screenshot checks of the Sessions operational ledger.
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
      <h1 className="type-page-title">Sessions</h1>
      <p className="mt-2 type-body text-muted">
        Fixture: labelled Search / Status / Stage / Sort / Clear command bar and column ledger.
      </p>

      <div className="mt-8">
        <SessionsCommandBar
          queryState={{
            cursor: null,
            query: "",
            scope: "active",
            sort: "updated",
            stageSlug: null,
          }}
          stageFacets={[
            { count: 25, name: "Plan", position: 0, slug: "plan" },
            { count: 25, name: "Build", position: 1, slug: "build" },
          ]}
          workspaceSlug="fixture"
        />

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

      <section className="mt-12 space-y-4" data-sessions-ledger-fixture="empty">
        <h2 className="text-sm font-semibold text-foreground">Empty states</h2>
        <SessionsZeroState
          newSessionHref="/w/fixture/sessions?create=1"
          onboarding={null}
          workspaceSlug="fixture"
        />
        <div className="ui-sheet flex flex-col items-center border-dashed px-6 py-16 text-center">
          <p className="text-[14px] font-semibold text-foreground">
            No sessions match these filters
          </p>
          <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted">
            Adjust Status, Stage, Sort, or Search to see more sessions.
          </p>
        </div>
      </section>
    </main>
  );
}
