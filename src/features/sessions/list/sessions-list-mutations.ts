import type {
  SessionFilterKey,
  SessionListItem,
  SessionListQueryState,
} from "@/features/sessions/types";

export function buildSessionsListHref(
  base: string,
  state: Pick<SessionListQueryState, "cursor" | "stageSlug" | "query" | "scope">,
): string {
  const params = new URLSearchParams();
  if (state.stageSlug) params.set("stage", state.stageSlug);
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.scope !== "all") params.set("scope", state.scope);
  if (state.cursor) params.set("cursor", state.cursor);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export type ListCommittedMutation =
  | {
      kind: "archive";
      result: {
        archivedAt: string | null;
        id: string;
        phaseStatus: SessionListItem["phaseStatus"];
        updatedAt: string;
      };
    }
  | { kind: "title"; result: { id: string; title: string; updatedAt: string } };

export function commitListTitle(
  sessions: readonly SessionListItem[],
  result: { id: string; title: string; updatedAt: string },
) {
  return sessions
    .map((session) =>
      session.id === result.id && result.updatedAt >= session.updatedAt
        ? { ...session, title: result.title, updatedAt: result.updatedAt }
        : session,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function commitListArchive(
  sessions: readonly SessionListItem[],
  scope: SessionFilterKey,
  result: {
    archivedAt: string | null;
    id: string;
    phaseStatus: SessionListItem["phaseStatus"];
    updatedAt: string;
  },
) {
  return sessions
    .map((session) =>
      session.id === result.id && result.updatedAt >= session.updatedAt
        ? {
            ...session,
            archivedAt: result.archivedAt,
            phaseStatus: result.phaseStatus,
            updatedAt: result.updatedAt,
          }
        : session,
    )
    .filter(
      (session) =>
        (scope !== "active" || !session.archivedAt) &&
        (scope !== "archived" || Boolean(session.archivedAt)),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function reconcileListMutations(
  sessions: readonly SessionListItem[],
  scope: SessionFilterKey,
  mutations: readonly ListCommittedMutation[],
) {
  return [...mutations]
    .sort((left, right) => left.result.updatedAt.localeCompare(right.result.updatedAt))
    .reduce<
      SessionListItem[]
    >((current, mutation) => (mutation.kind === "title" ? commitListTitle(current, mutation.result) : commitListArchive(current, scope, mutation.result)), [...sessions]);
}

export type TitleOverride = {
  authoritativeTitle: string;
  authoritativeUpdatedAt: string;
  title: string;
};

export function resolveOptimisticTitle(
  session: Pick<SessionListItem, "title" | "updatedAt">,
  override: TitleOverride | null,
) {
  if (
    override &&
    override.authoritativeTitle === session.title &&
    override.authoritativeUpdatedAt === session.updatedAt
  ) {
    return override.title;
  }
  return session.title;
}

export type ArchiveOverride = {
  authoritativeArchivedAt: string | null;
  authoritativeUpdatedAt: string;
  archivedAt: string | null;
  phaseStatus: SessionListItem["phaseStatus"];
};

/** Prefer the override only while props still match the snapshot it was keyed to. */
export function resolveOptimisticArchive(
  session: Pick<SessionListItem, "archivedAt" | "phaseStatus" | "updatedAt">,
  override: ArchiveOverride | null,
): Pick<SessionListItem, "archivedAt" | "phaseStatus"> {
  if (
    override &&
    override.authoritativeArchivedAt === session.archivedAt &&
    override.authoritativeUpdatedAt === session.updatedAt
  ) {
    return {
      archivedAt: override.archivedAt,
      phaseStatus: override.phaseStatus,
    };
  }
  return {
    archivedAt: session.archivedAt,
    phaseStatus: session.phaseStatus,
  };
}
