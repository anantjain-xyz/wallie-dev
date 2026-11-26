import { z } from "zod";

import { workspaceSessionDetailPath } from "@/lib/routes";
import { parseSessionBrowseReturn } from "./browse-return";

type SearchParams = Record<string, string | string[] | undefined>;

const reviewQueryKeys = [
  "artifactStage",
  "artifactId",
  "artifactVersion",
  "reviewStageId",
  "reviewRevision",
  "clarificationId",
] as const;

const requestedTargetSchema = z.object({
  stageId: z.string().uuid().optional(),
  stageSlug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  artifactId: z.string().uuid(),
  artifactVersion: z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/)
    .transform(Number)
    .pipe(z.number().int().positive().max(2_147_483_647)),
  reviewRevision: z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,15})$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe()),
  clarificationId: z.string().uuid().optional(),
});

export type RequestedSessionReviewTarget = Omit<
  z.output<typeof requestedTargetSchema>,
  "clarificationId"
> & { clarificationId: string | null };

export type ExactSessionReviewTarget = RequestedSessionReviewTarget & { stageId: string };

export function parseSessionReviewTarget(params: SearchParams) {
  if (
    params.reviewStageId === undefined &&
    params.reviewRevision === undefined &&
    params.clarificationId === undefined
  ) {
    return { kind: "ordinary" } as const;
  }
  const parsed = requestedTargetSchema.safeParse({
    stageId: params.reviewStageId,
    stageSlug: params.artifactStage,
    artifactId: params.artifactId,
    artifactVersion: params.artifactVersion,
    reviewRevision: params.reviewRevision,
    clarificationId: params.clarificationId,
  });
  if (!parsed.success) return { kind: "invalid" } as const;
  return {
    kind: "exact",
    target: {
      ...parsed.data,
      stageId: parsed.data.stageId?.toLowerCase(),
      artifactId: parsed.data.artifactId.toLowerCase(),
      clarificationId: parsed.data.clarificationId?.toLowerCase() ?? null,
    },
  } as const;
}

export function sessionReviewQuery(target: RequestedSessionReviewTarget) {
  return {
    artifactStage: target.stageSlug,
    artifactId: target.artifactId,
    artifactVersion: target.artifactVersion,
    reviewStageId: target.stageId,
    reviewRevision: target.reviewRevision,
    clarificationId: target.clarificationId ?? undefined,
  };
}

export function exactSessionReviewHref(
  workspaceSlug: string,
  sessionNumber: number | string,
  target: ExactSessionReviewTarget,
) {
  return workspaceSessionDetailPath(workspaceSlug, sessionNumber, sessionReviewQuery(target));
}

export function sessionReviewReturnPath(
  url: Pick<URL, "pathname" | "searchParams">,
  expectedWorkspaceSlug?: string,
) {
  const match = /^\/w\/([a-z0-9-]+)\/sessions\/([1-9][0-9]{0,9})\/?$/.exec(url.pathname);
  if (!match || (expectedWorkspaceSlug !== undefined && match[1] !== expectedWorkspaceSlug)) {
    return undefined;
  }
  const workspaceSlug = match[1]!;
  const sessionNumber = Number(match[2]);
  if (sessionNumber > 2_147_483_647) return undefined;

  const query = Object.fromEntries(
    reviewQueryKeys.map((key) => {
      const values = url.searchParams.getAll(key);
      return [key, values.length > 1 ? values : values[0]];
    }),
  );
  const parsed = parseSessionReviewTarget(query);
  const [rawReturn, duplicateReturn] = url.searchParams.getAll("returnTo");
  const returnTo =
    duplicateReturn === undefined
      ? parseSessionBrowseReturn(workspaceSlug, rawReturn)?.href
      : undefined;
  return parsed.kind === "exact"
    ? workspaceSessionDetailPath(workspaceSlug, sessionNumber, {
        ...sessionReviewQuery(parsed.target),
        returnTo,
      })
    : parsed.kind === "ordinary" && returnTo
      ? workspaceSessionDetailPath(workspaceSlug, sessionNumber, { returnTo })
      : undefined;
}
