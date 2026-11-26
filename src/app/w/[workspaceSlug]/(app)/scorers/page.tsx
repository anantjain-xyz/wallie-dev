import Form from "next/form";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { ScorerDraftGuard, ScorerDraftLink } from "@/features/factory-scorers/scorer-draft-guard";
import { scorerEvidenceLabels } from "@/features/factory-scorers/scorer-evidence-labels";
import { scorerFactoryLabel } from "@/features/factory-scorers/scorer-factory-label";
import { ScorerFactorySelector } from "@/features/factory-scorers/scorer-factory-selector";
import { ScorerForm } from "@/features/factory-scorers/scorer-form";
import {
  loadScorerPageScope,
  readScorerRevisionOwner,
} from "@/features/factory-scorers/scorer-pages-data";
import {
  factoryScorerPresetKey,
  factoryScorerPresets,
  readFactoryScorerPreset,
} from "@/lib/factory-scorers/presets";
import { searchFactoryScorers } from "@/lib/factory-scorers/service";
import { workspaceScorerDetailPath, workspaceScorersPath } from "@/lib/routes";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export default async function ScorersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{
    factory?: string | string[];
    after?: string | string[];
    revision?: string | string[];
    preset?: string | string[];
    q?: string | string[];
  }>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const scope = await loadScorerPageScope(workspaceSlug, query.factory);
  if (!scope) {
    const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
    return (
      <FactoryUnavailable
        actions={<ScorerFactorySelector factories={factories} selectedValue="unavailable" />}
        description={
          factories.length
            ? "Choose a factory you can access from the Factory menu, or return to sessions."
            : undefined
        }
        title="Scorers"
        workspaceSlug={workspaceSlug}
      />
    );
  }

  const { factories, factory, canEdit, supabase, workspaceId } = scope;
  const factoryQuery = { factory: factory.id };
  if (query.revision !== undefined) {
    const revision = uuid.safeParse(query.revision);
    if (!revision.success) notFound();
    const scorerId = await readScorerRevisionOwner(scope, revision.data);
    if (!scorerId) notFound();
    redirect(
      workspaceScorerDetailPath(workspaceSlug, scorerId, {
        ...factoryQuery,
        revision: revision.data,
      }),
    );
  }

  const after = uuid.optional().safeParse(query.after);
  if (!after.success) notFound();
  const preset = canEdit ? readFactoryScorerPreset(query.preset) : undefined;
  const presetKey = preset ? factoryScorerPresetKey(preset) : undefined;
  const search =
    typeof query.q === "string" ? query.q.trim().slice(0, 120).replaceAll("\0", "") : "";
  const libraryQuery = { ...factoryQuery, q: search || undefined };
  const draftQuery = { ...libraryQuery, after: after.data };
  const factoryLabel = scorerFactoryLabel(factory, factories);
  const { scorers, nextAfterId } = await searchFactoryScorers(supabase, {
    workspaceId,
    factoryId: factory.id,
    afterId: after.data,
    limit: 30,
    search,
  });

  return (
    <ScorerDraftGuard>
      <PageContainer className="pt-5 sm:pt-10">
        <PageHeader
          actions={
            <>
              <ScorerFactorySelector factories={factories} selectedValue={factory.id} />
              {canEdit ? (
                <Link className="ui-button ui-button-primary" href="#new-scorer">
                  New scorer
                </Link>
              ) : null}
            </>
          }
          actionsRightOnDesktop
          description={
            canEdit
              ? undefined
              : factory.status === "archived"
                ? `${factoryLabel} · Read only — archived factory`
                : `${factoryLabel} · Only factory managers can publish`
          }
          title="Scorers"
        />
        <div className="space-y-8">
          <section aria-label="Factory scorers" className="ui-sheet divide-y divide-border">
            <Form
              action={workspaceScorersPath(workspaceSlug)}
              className="space-y-1.5 px-4 py-4 sm:px-5"
              role="search"
            >
              <input name="factory" type="hidden" value={factory.id} />
              {presetKey ? <input name="preset" type="hidden" value={presetKey} /> : null}
              <label className="type-label block" htmlFor="search-scorers">
                Search this factory’s scorers
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  autoComplete="off"
                  className="ui-input min-w-0 flex-1 basis-48"
                  defaultValue={search}
                  id="search-scorers"
                  key={search}
                  maxLength={120}
                  name="q"
                  placeholder="Name or identifier…"
                  type="search"
                />
                <button className="ui-button" type="submit">
                  Search
                </button>
                {search ? (
                  <Link
                    className="ui-button"
                    href={workspaceScorersPath(workspaceSlug, {
                      ...factoryQuery,
                      preset: presetKey,
                    })}
                  >
                    Clear search
                  </Link>
                ) : null}
              </div>
            </Form>
            {scorers.length ? (
              <ul className="divide-y divide-border">
                {scorers.map((scorer) => (
                  <li className="min-w-0 px-4 py-4 sm:px-5" key={scorer.id}>
                    <ScorerDraftLink
                      className="break-words font-semibold text-foreground underline-offset-4 hover:text-accent hover:underline"
                      href={workspaceScorerDetailPath(workspaceSlug, scorer.id, factoryQuery)}
                    >
                      {scorer.name}
                    </ScorerDraftLink>
                    {scorer.requirements ? (
                      <p className="type-secondary mt-1 break-words text-muted">
                        {scorer.requirements.evidence
                          .map((kind) => scorerEvidenceLabels[kind])
                          .join(", ")}
                        {" · "}
                        {scorer.requirements.scale === "boolean" ? "Boolean" : "Numeric"}
                      </p>
                    ) : null}
                    <p className="type-annotation mt-1 break-words text-muted">{scorer.slug}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-secondary px-4 py-5 text-muted sm:px-5">
                {after.data
                  ? "No scorers on this page."
                  : search
                    ? "No scorers match this search in the selected factory."
                    : "No scorers in this factory yet."}
              </p>
            )}
            {after.data || nextAfterId ? (
              <div className="flex flex-wrap gap-2 px-4 py-3 sm:px-5">
                {after.data ? (
                  <Link
                    className="ui-button"
                    href={workspaceScorersPath(workspaceSlug, {
                      ...libraryQuery,
                      preset: presetKey,
                    })}
                  >
                    First page
                  </Link>
                ) : null}
                {nextAfterId ? (
                  <Link
                    className="ui-button"
                    href={workspaceScorersPath(workspaceSlug, {
                      ...libraryQuery,
                      after: nextAfterId,
                      preset: presetKey,
                    })}
                  >
                    More scorers
                  </Link>
                ) : null}
              </div>
            ) : null}
          </section>
          {canEdit ? (
            <PageSection
              anchorId="new-scorer"
              statusBadge={<Status label="Draft" value="not_started" />}
              title="Draft rubric"
            >
              <div className="ui-sheet mb-4 space-y-3 p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="type-label text-foreground" id="scorer-presets">
                    Scorer presets
                  </h3>
                  {preset ? (
                    <ScorerDraftLink
                      className="type-secondary underline underline-offset-4"
                      href={`${workspaceScorersPath(workspaceSlug, draftQuery)}#new-scorer`}
                    >
                      Start with a blank draft
                    </ScorerDraftLink>
                  ) : null}
                </div>
                <p className="type-secondary text-muted">
                  Presets are editable copies. Runs missing or withholding required evidence are
                  excluded.
                </p>
                <ul aria-labelledby="scorer-presets" className="grid gap-2 sm:grid-cols-2">
                  {Object.values(factoryScorerPresets).map((option) => {
                    const key = factoryScorerPresetKey(option);
                    const selected = presetKey === key;
                    const PresetLink = selected ? Link : ScorerDraftLink;
                    return (
                      <li
                        className={`min-w-0 rounded-md border p-3 ${selected ? "border-accent/60 bg-accent/5" : "border-border"}`}
                        key={key}
                      >
                        <PresetLink
                          aria-current={selected ? "true" : undefined}
                          className="type-secondary font-medium text-foreground underline-offset-4 hover:text-accent hover:underline"
                          href={`${workspaceScorersPath(workspaceSlug, { ...draftQuery, preset: key })}#new-scorer`}
                        >
                          {option.name}
                        </PresetLink>
                        <p className="type-annotation mt-1 text-muted">{option.description}</p>
                        <p className="type-annotation mt-1 break-words text-foreground">
                          Requires{" "}
                          {option.definition.requiredEvidence
                            .map((kind) => scorerEvidenceLabels[kind])
                            .join(", ")}
                        </p>
                      </li>
                    );
                  })}
                </ul>
                {preset ? (
                  <p className="type-secondary text-muted">
                    Editing a copy of {preset.name} · Version {preset.version}
                  </p>
                ) : null}
              </div>
              <ScorerForm
                draft={{ kind: "create", preset }}
                factoryId={factory.id}
                factoryLabel={factoryLabel}
                key={`${factory.id}:${presetKey ?? "blank"}`}
                workspaceId={workspaceId}
                workspaceSlug={workspaceSlug}
              />
            </PageSection>
          ) : null}
        </div>
      </PageContainer>
    </ScorerDraftGuard>
  );
}
