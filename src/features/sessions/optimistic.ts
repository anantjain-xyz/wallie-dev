import type {
  SessionDetail,
  SessionPhaseCompletion,
  SessionPhaseStatus,
} from "@/features/sessions/types";

export type SessionMutationPatch = {
  archivedAt?: string | null;
  currentArtifactVersion?: number | null;
  currentStageId?: string;
  phaseCompletion?: SessionPhaseCompletion;
  phaseCompletions?: SessionPhaseCompletion[];
  phaseStatus?: SessionPhaseStatus;
  rejectionCount?: number;
  title?: string;
  updatedAt?: string;
};

export function applySessionMutationPatch(
  session: SessionDetail,
  patch: SessionMutationPatch,
): SessionDetail {
  const currentStage = patch.currentStageId
    ? session.pipeline.stages.find((stage) => stage.id === patch.currentStageId)
    : null;
  const phaseCompletions =
    patch.phaseCompletions ??
    (patch.phaseCompletion
      ? [
          ...session.phaseCompletions.filter(
            (completion) => completion.stageSlug !== patch.phaseCompletion!.stageSlug,
          ),
          patch.phaseCompletion,
        ]
      : session.phaseCompletions);

  return {
    ...session,
    ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
    ...(patch.currentArtifactVersion !== undefined
      ? { currentArtifactVersion: patch.currentArtifactVersion }
      : {}),
    ...(patch.currentStageId !== undefined ? { currentStageId: patch.currentStageId } : {}),
    ...(currentStage
      ? {
          currentStageName: currentStage.name,
          currentStagePosition: currentStage.position,
          currentStageSlug: currentStage.slug,
        }
      : {}),
    ...(patch.phaseStatus !== undefined ? { phaseStatus: patch.phaseStatus } : {}),
    ...(patch.rejectionCount !== undefined ? { rejectionCount: patch.rejectionCount } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
    phaseCompletions,
  };
}

export function reconcileSessionMutationPatch(
  session: SessionDetail,
  patch: SessionMutationPatch & { updatedAt: string },
): SessionDetail {
  if (Date.parse(patch.updatedAt) <= Date.parse(session.updatedAt)) {
    return session;
  }

  return applySessionMutationPatch(session, patch);
}

export function rollbackSessionMutationPatch(
  session: SessionDetail,
  optimisticPatch: SessionMutationPatch,
  previousPatch: SessionMutationPatch,
): SessionDetail {
  if (previousPatch.updatedAt && session.updatedAt !== previousPatch.updatedAt) {
    return session;
  }

  const rollbackPatch: SessionMutationPatch = {};

  for (const key of Object.keys(previousPatch) as (keyof SessionMutationPatch)[]) {
    if (session[key as keyof SessionDetail] === optimisticPatch[key]) {
      Object.assign(rollbackPatch, { [key]: previousPatch[key] });
    }
  }

  return applySessionMutationPatch(session, rollbackPatch);
}

export async function runOptimisticMutation<Result>(input: {
  commit: (result: Result) => void;
  mutate: () => Promise<Result>;
  optimistic: () => void;
  rollback: () => void;
}): Promise<Result> {
  input.optimistic();

  try {
    const result = await input.mutate();
    input.commit(result);
    return result;
  } catch (error) {
    input.rollback();
    throw error;
  }
}
