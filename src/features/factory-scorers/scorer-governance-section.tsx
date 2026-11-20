import "server-only";

import Link from "next/link";
import { z } from "zod";

import { PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import type { ScoreMetrics } from "@/lib/factory-evaluations/score-trend-contracts";
import { workspaceScorerDetailPath } from "@/lib/routes";
import type {
  ScorerCalibration,
  ScorerPauseHistory,
} from "@/lib/factory-evaluations/scorer-governance-contracts";
import {
  readScorerCalibration,
  readScorerPause,
  type ScorerGovernanceScope,
} from "@/lib/factory-evaluations/scorer-governance";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

import { CalibrationForm, ScorerPauseControl } from "./scorer-governance-controls";
import { runAttemptHref } from "./run-evaluation-governance";
import { scoreNumber } from "./score-outcome";

const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revisionParameter = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(2_147_483_647));
const format = z
  .object({
    calibrationSet: id.optional(),
    beforeCalibrationRevision: revisionParameter.optional(),
    beforeCalibrationSetAt: z.string().datetime({ offset: true }).optional(),
    beforeCalibrationSetId: id.optional(),
  })
  .refine(
    (query) =>
      (query.beforeCalibrationSetAt === undefined) ===
        (query.beforeCalibrationSetId === undefined) &&
      (query.calibrationSet
        ? query.beforeCalibrationSetId === undefined
        : query.beforeCalibrationRevision === undefined),
  );
type CalibrationQuery = z.output<typeof format>;
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const pauseTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

function coverage(numerator: number, denominator: number) {
  return `${scoreNumber.format(numerator)} / ${scoreNumber.format(denominator)}${denominator ? ` (${percent.format(numerator / denominator)})` : ""}`;
}

function PauseHistory({
  state,
  beforeRevision,
  path,
}: {
  state: ScorerPauseHistory;
  beforeRevision?: number;
  path: string;
}) {
  function href(before?: number) {
    const url = new URL(path, "https://wallie.invalid");
    if (before) url.searchParams.set("beforePauseRevision", String(before));
    else url.searchParams.delete("beforePauseRevision");
    return `${url.pathname}${url.search}#scorer-health`;
  }
  return (
    <details className="border-t border-border pt-3" open={beforeRevision ? true : undefined}>
      <summary className="type-label cursor-pointer">Pause history</summary>
      {state.history.length ? (
        <ul aria-label="Pause history" className="mt-2 divide-y divide-border">
          {state.history.map((entry) => (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" key={entry.revision}>
              <Status
                compact
                label={entry.paused ? "Paused" : "Resumed"}
                value={entry.paused ? "blocked" : "healthy"}
              />
              <span className="type-secondary text-muted">Pause revision {entry.revision}</span>
              <span className="type-secondary min-w-0 break-words">
                {entry.actor_name ?? "Actor unavailable"}
              </span>
              <time className="type-secondary text-muted" dateTime={entry.created_at}>
                {pauseTime.format(new Date(entry.created_at))} UTC
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-secondary mt-2 text-muted">No pause changes on this page.</p>
      )}
      {beforeRevision || state.next_before_pause_revision ? (
        <nav aria-label="Pause history pages" className="mt-2 flex flex-wrap gap-2">
          {beforeRevision ? (
            <Link className="ui-button" href={href()} prefetch={false}>
              Latest pause changes
            </Link>
          ) : null}
          {state.next_before_pause_revision ? (
            <Link
              className="ui-button"
              href={href(state.next_before_pause_revision)}
              prefetch={false}
            >
              Older pause changes
            </Link>
          ) : null}
        </nav>
      ) : null}
    </details>
  );
}

function ScorerHealth({
  pause,
  stats,
  endpoint,
  canEdit,
  beforePauseRevision,
  historyPath,
}: {
  pause: ScorerPauseHistory | null;
  stats?: ScoreMetrics;
  endpoint: string;
  canEdit: boolean;
  beforePauseRevision?: number;
  historyPath: string;
}) {
  const settled = stats
    ? stats.pass_count +
      stats.fail_count +
      stats.inconclusive_count +
      stats.skipped_count +
      stats.error_count
    : 0;
  return (
    <PageSection
      anchorId="scorer-health"
      title="Scorer health"
      statusBadge={
        pause ? (
          <Status
            label={pause.paused ? "Paused" : "Admitting evaluations"}
            value={pause.paused ? "blocked" : "healthy"}
          />
        ) : undefined
      }
    >
      <div className="ui-sheet space-y-4 px-4 py-4 sm:px-5">
        {stats ? (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <dt className="type-secondary text-muted">Evaluator errors / settled</dt>
              <dd className="font-semibold tabular-nums">{coverage(stats.error_count, settled)}</dd>
            </div>
            <div>
              <dt className="type-secondary text-muted">Sampled / eligible</dt>
              <dd className="font-semibold tabular-nums">
                {coverage(stats.sampled_count, stats.eligible_count)}
              </dd>
            </div>
            <div>
              <dt className="type-secondary text-muted">Usable / sampled</dt>
              <dd className="font-semibold tabular-nums">
                {coverage(stats.usable_count, stats.sampled_count)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="type-secondary text-muted">
            Select a sampling cohort to see health metrics for this revision.
          </p>
        )}
        {pause ? (
          <>
            <p className="type-secondary text-muted">
              Pausing skips new admissions and holds queued work. Active attempts can finish.
            </p>
            {canEdit ? <ScorerPauseControl endpoint={endpoint} pause={pause} /> : null}
            <PauseHistory state={pause} beforeRevision={beforePauseRevision} path={historyPath} />
          </>
        ) : (
          <p className="type-secondary text-muted">Scorer admission state is unavailable.</p>
        )}
      </div>
    </PageSection>
  );
}

function calibrationHref(path: string, selection: CalibrationQuery = {}) {
  const url = new URL(path, "https://wallie.invalid");
  for (const [key, value] of Object.entries(selection))
    if (value) url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}#scorer-calibration`;
}

function CalibrationSection({
  data,
  selection,
  path,
  endpoint,
  scorerRevisionId,
  workspaceSlug,
  scorerId,
  factoryId,
  canEdit,
}: {
  data: ScorerCalibration | null;
  selection: CalibrationQuery | null;
  path: string;
  endpoint: string;
  scorerRevisionId: string;
  workspaceSlug: string;
  scorerId: string;
  factoryId: string;
  canEdit: boolean;
}) {
  const setId = selection?.calibrationSet;
  const versionPage = Boolean(selection?.beforeCalibrationRevision);
  const setPage = Boolean(selection?.beforeCalibrationSetId);
  const latest = setId && !versionPage ? data?.versions[0] : undefined;
  const edit = canEdit && data && selection && (!setId || Boolean(latest));
  return (
    <PageSection anchorId="scorer-calibration" title="Calibration sets">
      <div className="ui-sheet divide-y divide-border">
        <div className="space-y-3 px-4 py-4 sm:px-5">
          {data && selection ? (
            <>
              {data.versions.length ? (
                <ul
                  aria-label={setId ? "Calibration version history" : "Published calibration sets"}
                  className="divide-y divide-border"
                >
                  {data.versions.map((version) => (
                    <li
                      className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5"
                      key={version.id}
                    >
                      <div className="min-w-0 space-y-1">
                        {setId ? (
                          <p className="break-words font-semibold">{version.name}</p>
                        ) : (
                          <Link
                            className="break-words font-semibold text-accent underline underline-offset-4"
                            href={calibrationHref(path, { calibrationSet: version.set_id })}
                            prefetch={false}
                          >
                            {version.name}
                          </Link>
                        )}
                        <p className="type-secondary text-muted">
                          Version {version.revision} ·{" "}
                          {scoreNumber.format(version.adjudication_ids.length)}{" "}
                          {version.adjudication_ids.length === 1 ? "case" : "cases"}
                        </p>
                        <Link
                          className="type-secondary block text-accent underline underline-offset-4"
                          href={workspaceScorerDetailPath(workspaceSlug, scorerId, {
                            factory: factoryId,
                            revision: version.scorer_revision_id,
                          })}
                          prefetch={false}
                        >
                          Pinned rubric · Revision {version.scorer_revision_number}
                        </Link>
                        <details className="type-secondary text-muted">
                          <summary className="cursor-pointer">Inspect calibration cases</summary>
                          <ul className="mt-2 space-y-1">
                            {version.case_refs.map((reference, index) => (
                              <li key={reference.adjudication_id}>
                                <Link
                                  className="text-accent underline underline-offset-4"
                                  href={runAttemptHref(
                                    workspaceSlug,
                                    reference.run_id,
                                    reference.attempt_id,
                                    undefined,
                                    `adjudication-${reference.adjudication_id}`,
                                    { evaluationAdjudication: reference.adjudication_id },
                                  )}
                                  prefetch={false}
                                >
                                  Open case {index + 1}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </div>
                      <time className="type-secondary text-muted" dateTime={version.created_at}>
                        {dateFormat.format(new Date(version.created_at))}
                      </time>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="type-secondary text-muted">
                  No calibration {setId ? "versions" : "sets"} on this page.
                </p>
              )}
              {setId || setPage || data.next_before_set_id ? (
                <nav aria-label="Calibration history pages" className="flex flex-wrap gap-2">
                  {setId ? (
                    <Link className="ui-button" href={calibrationHref(path)} prefetch={false}>
                      All calibration sets
                    </Link>
                  ) : null}
                  {versionPage || setPage ? (
                    <Link
                      className="ui-button"
                      href={calibrationHref(path, { calibrationSet: setId })}
                      prefetch={false}
                    >
                      Latest {setId ? "versions" : "sets"}
                    </Link>
                  ) : null}
                  {setId && data.next_before_revision ? (
                    <Link
                      className="ui-button"
                      href={calibrationHref(path, {
                        calibrationSet: setId,
                        beforeCalibrationRevision: data.next_before_revision,
                      })}
                      prefetch={false}
                    >
                      Older versions
                    </Link>
                  ) : null}
                  {!setId && data.next_before_set_at && data.next_before_set_id ? (
                    <Link
                      className="ui-button"
                      href={calibrationHref(path, {
                        beforeCalibrationSetAt: data.next_before_set_at,
                        beforeCalibrationSetId: data.next_before_set_id,
                      })}
                      prefetch={false}
                    >
                      Older sets
                    </Link>
                  ) : null}
                </nav>
              ) : null}
            </>
          ) : (
            <p className="type-secondary text-muted">
              Calibration history is unavailable.{" "}
              <Link className="text-accent underline" href={calibrationHref(path)} prefetch={false}>
                View latest sets
              </Link>
            </p>
          )}
        </div>
        {edit ? (
          <div className="space-y-3 px-4 py-4 sm:px-5">
            <h3 className="type-label font-semibold">
              {setId ? "Draft next version" : "New calibration set"}
            </h3>
            <CalibrationForm
              key={latest?.set_id ?? "new"}
              endpoint={endpoint}
              current={latest}
              candidatePage={{
                candidates: data.candidates,
                next_before_candidate_at: data.next_before_candidate_at,
                next_before_candidate_id: data.next_before_candidate_id,
              }}
              scorerRevisionId={scorerRevisionId}
            />
          </div>
        ) : null}
      </div>
    </PageSection>
  );
}

export async function loadScorerGovernanceData(
  client: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  scope: ScorerGovernanceScope,
  scorerId: string,
  search: Record<string, string | string[] | undefined>,
) {
  const parsed = format.safeParse(search);
  const selection = parsed.success ? parsed.data : null;
  const pausePage = revisionParameter.optional().safeParse(search.beforePauseRevision);
  const beforePauseRevision = pausePage.success ? pausePage.data : undefined;
  const [pause, calibration] = await Promise.all([
    readScorerPause(client, scope, scorerId, beforePauseRevision).catch(() => null),
    selection
      ? readScorerCalibration(client, scope, scorerId, {
          setId: selection.calibrationSet,
          beforeRevision: selection.beforeCalibrationRevision,
          beforeSetAt: selection.beforeCalibrationSetAt,
          beforeSetId: selection.beforeCalibrationSetId,
        }).catch(() => null)
      : null,
  ]);
  return { pause, calibration, selection, beforePauseRevision };
}

export function ScorerGovernanceSection({
  scope,
  scorerId,
  scorerRevisionId,
  workspaceSlug,
  canEdit,
  stats,
  path,
  data,
}: {
  scope: ScorerGovernanceScope;
  scorerId: string;
  scorerRevisionId: string;
  workspaceSlug: string;
  canEdit: boolean;
  stats?: ScoreMetrics;
  path: string;
  data: Awaited<ReturnType<typeof loadScorerGovernanceData>>;
}) {
  const { pause, calibration, selection, beforePauseRevision } = data;
  const endpoint = `/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/scorers/${scorerId}/governance`;
  return (
    <>
      <ScorerHealth
        pause={pause}
        stats={stats}
        endpoint={endpoint}
        canEdit={canEdit}
        beforePauseRevision={beforePauseRevision}
        historyPath={calibrationHref(path, selection ?? {})}
      />
      <CalibrationSection
        data={calibration}
        selection={selection}
        path={path}
        endpoint={endpoint}
        scorerRevisionId={scorerRevisionId}
        workspaceSlug={workspaceSlug}
        scorerId={scorerId}
        factoryId={scope.factoryId}
        canEdit={canEdit}
      />
    </>
  );
}
