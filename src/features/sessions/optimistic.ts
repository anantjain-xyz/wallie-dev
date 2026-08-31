import type { SessionPhaseCompletion, SessionPhaseStatus } from "@/features/sessions/types";

type OptimisticSession = {
  archivedAt: string | null;
  currentArtifactVersion: number | null;
  currentStageId: string;
  currentStageSlug: string;
  phaseCompletions: SessionPhaseCompletion[];
  phaseStatus: SessionPhaseStatus;
  pipeline: {
    stages: Array<{
      id: string;
      name: string;
      position: number;
      slug: string;
    }>;
  };
  rejectionCount?: number;
  title: string;
  updatedAt: string;
};

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

function fractionalSecondNanoseconds(timestamp: string): number {
  const fraction = timestamp.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/)?.[1] ?? "";
  return Number(fraction.slice(0, 9).padEnd(9, "0"));
}

export function compareSessionTimestamps(left: string, right: string): number {
  const leftMilliseconds = Date.parse(left);
  const rightMilliseconds = Date.parse(right);

  if (!Number.isFinite(leftMilliseconds) || !Number.isFinite(rightMilliseconds)) {
    return left.localeCompare(right);
  }

  if (leftMilliseconds !== rightMilliseconds) {
    return leftMilliseconds < rightMilliseconds ? -1 : 1;
  }

  const leftNanoseconds = fractionalSecondNanoseconds(left);
  const rightNanoseconds = fractionalSecondNanoseconds(right);
  return Math.sign(leftNanoseconds - rightNanoseconds);
}

export function applySessionMutationPatch<Session extends OptimisticSession>(
  session: Session,
  patch: SessionMutationPatch,
): Session {
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
          currentStageSlug: currentStage.slug,
          ...(Object.hasOwn(session, "currentStageName")
            ? { currentStageName: currentStage.name }
            : {}),
          ...(Object.hasOwn(session, "currentStagePosition")
            ? { currentStagePosition: currentStage.position }
            : {}),
        }
      : {}),
    ...(patch.phaseStatus !== undefined ? { phaseStatus: patch.phaseStatus } : {}),
    ...(patch.rejectionCount !== undefined ? { rejectionCount: patch.rejectionCount } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
    phaseCompletions,
  } as Session;
}

export function reconcileSessionMutationPatch<Session extends OptimisticSession>(
  session: Session,
  patch: SessionMutationPatch & { updatedAt: string },
): Session {
  const timestampOrder = compareSessionTimestamps(patch.updatedAt, session.updatedAt);

  if (timestampOrder < 0) {
    return session;
  }

  if (timestampOrder === 0 && !advancesSameTimestampState(session, patch)) {
    return session;
  }

  return applySessionMutationPatch(session, patch);
}

function advancesSameTimestampState(
  session: OptimisticSession,
  patch: SessionMutationPatch,
): boolean {
  if (patch.currentStageId && patch.currentStageId !== session.currentStageId) {
    const currentPosition = session.pipeline.stages.find(
      (stage) => stage.id === session.currentStageId,
    )?.position;
    const nextPosition = session.pipeline.stages.find(
      (stage) => stage.id === patch.currentStageId,
    )?.position;

    if (currentPosition !== undefined && nextPosition !== undefined) {
      // Stage position is the primary ordering key. In particular, an older
      // stage can have a larger artifact version than the newly advanced one.
      return nextPosition > currentPosition;
    }
  }

  if (
    patch.currentArtifactVersion !== undefined &&
    patch.currentArtifactVersion !== null &&
    (session.currentArtifactVersion === null ||
      patch.currentArtifactVersion > session.currentArtifactVersion)
  ) {
    return true;
  }

  if (
    patch.rejectionCount !== undefined &&
    session.rejectionCount !== undefined &&
    patch.rejectionCount > session.rejectionCount
  ) {
    return true;
  }

  return patch.archivedAt !== undefined && patch.archivedAt !== null && !session.archivedAt;
}

export function rollbackSessionMutationPatch<Session extends OptimisticSession>(
  session: Session,
  optimisticPatch: SessionMutationPatch,
  previousPatch: SessionMutationPatch,
): Session {
  const rollbackPatch: SessionMutationPatch = {};
  const sessionFields = session as OptimisticSession & Record<string, unknown>;

  for (const key of Object.keys(previousPatch) as (keyof SessionMutationPatch)[]) {
    if (sessionFields[key] === optimisticPatch[key]) {
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
