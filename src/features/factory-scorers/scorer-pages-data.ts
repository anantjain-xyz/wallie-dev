import "server-only";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveFactorySelection } from "@/features/factories/factory-selection";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import { FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION } from "@/lib/factory-definitions/schema";
import {
  selectCurrentFactoryActivation,
  selectStoredFactoryDefinition,
} from "@/lib/factory-definitions/storage";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import {
  listFactoryScorerRevisions,
  readFactoryScorer,
  readFactoryScorerRevision,
} from "@/lib/factory-scorers/service";

export async function loadScorerPageScope(workspaceSlug: string, factoryQuery?: string | string[]) {
  const [{ currentMember, supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const selected = resolveFactorySelection(
    factories,
    factoryQuery ?? factories.find(({ isDefault }) => isDefault)?.id ?? factories[0]?.id,
  );
  if (selected.kind !== "factory") return null;
  const { factory } = selected;
  return {
    factories,
    factory,
    workspaceId: workspace.id,
    supabase,
    canEdit: factory.status === "active" && factory.canManage === true,
    canBind: factory.status === "active" && isWorkspaceOperator(currentMember),
  };
}

type Scope = NonNullable<Awaited<ReturnType<typeof loadScorerPageScope>>>;

export async function readScorerRevisionOwner(
  { supabase, workspaceId, factory }: Scope,
  revisionId: string,
) {
  const { data, error } = await supabase
    .from("factory_scorer_revisions")
    .select("scorer_id")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factory.id)
    .eq("id", revisionId)
    .maybeSingle();
  if (error) throw error;
  return data?.scorer_id ?? null;
}

async function readActiveScorerPins({ supabase, workspaceId, factory }: Scope) {
  const activation = await selectCurrentFactoryActivation(supabase, workspaceId, factory.id);
  if (activation.error) throw activation.error;
  if (!activation.data) return [];
  const revision = await selectStoredFactoryDefinition(supabase, workspaceId, factory.id, {
    kind: "revision",
    id: activation.data.revision_id,
  });
  if (revision.error) throw revision.error;
  if (!revision.data) return [];
  const bundle = readVerifiedFactoryDefinition(
    revision.data.definition_json,
    revision.data.canonical_digest,
  );
  if (!bundle) throw new Error("The active factory definition is invalid.");
  return bundle.schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
    ? bundle.scorerRevisionIds
    : [];
}

export async function loadScorerDetail(
  scope: Scope,
  { scorerId, revisionId, before }: { scorerId: string; revisionId?: string; before?: number },
) {
  const { supabase, workspaceId, factory } = scope;
  const key = { workspaceId, factoryId: factory.id, scorerId };
  const [scorer, page, firstPage, exactRevision, activePins] = await Promise.all([
    readFactoryScorer(supabase, key),
    listFactoryScorerRevisions(supabase, { ...key, beforeRevisionNumber: before, limit: 20 }),
    before ? listFactoryScorerRevisions(supabase, { ...key, limit: 1 }) : null,
    revisionId ? readFactoryScorerRevision(supabase, { ...key, revisionId }) : null,
    readActiveScorerPins(scope),
  ]);
  const latest = (firstPage ?? page).revisions[0];
  if (!scorer || !latest) return null;
  const selected = revisionId
    ? exactRevision
    : await readFactoryScorerRevision(supabase, { ...key, revisionId: latest.id });
  if (!selected) return null;
  return { scorer, ...page, latest, selected, activePins };
}
