import { z } from "zod";

import {
  runArtifactAvailabilitySchema,
  runArtifactKindSchema,
  runArtifactScopeSchema,
  type RunArtifactKind,
} from "./run-artifacts-contracts";
import type { findRunArtifact } from "./run-artifacts";

export type ArtifactEvidenceSource =
  | { kind: "run"; workspaceId: string; runId: string; artifactId?: string | null }
  | { kind: "review"; sessionId: string; artifactId: string };

export type ArtifactScope = { workspaceId: string; runId: string; workspaceSlug?: string };
export type ArtifactTarget = { id: string; kind: RunArtifactKind };
export type InspectedArtifact = NonNullable<Awaited<ReturnType<typeof findRunArtifact>>>;

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const inspectedArtifactSchema = z.object({
  id: uuid,
  kind: runArtifactKindSchema,
  label: z.string(),
  digest: z
    .discriminatedUnion("algorithm", [
      z.object({ algorithm: z.literal("git_sha1"), value: sha }),
      z.object({ algorithm: z.literal("sha256"), value: z.string().regex(/^[a-f0-9]{64}$/) }),
    ])
    .nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  availability: runArtifactAvailabilitySchema,
  downloadable: z.boolean(),
  producer: z.object({ runId: uuid, sessionId: uuid, attemptCount: z.number().int().positive() }),
  checkpoint: z.object({ runId: uuid, commitSha: sha }).nullable(),
  validation: z.object({ runId: uuid, commitSha: sha, treeSha: sha }).nullable(),
  recordedAt: z.string().datetime({ offset: true }),
}) satisfies z.ZodType<InspectedArtifact>;

const catalogSchema = z.object({
  items: z.array(inspectedArtifactSchema).max(50),
  nextCursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(512)
    .nullable(),
});

const reviewProvenanceSchema = runArtifactScopeSchema.extend({
  runId: uuid.nullable(),
  workspaceSlug: z.string().min(1),
});

const availabilityResponseSchema = z.object({ availability: runArtifactAvailabilitySchema });

export type ArtifactPage = z.infer<typeof catalogSchema>;

export class ArtifactEvidenceRequestError extends Error {
  constructor(readonly status: number) {
    super("Artifact evidence request failed.");
  }
}

async function loadJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, cache: "no-store" });
  if (!response.ok) throw new ArtifactEvidenceRequestError(response.status);
  return response.json();
}

export async function resolveArtifactScope(source: ArtifactEvidenceSource, signal: AbortSignal) {
  if (source.kind === "run") return runArtifactScopeSchema.parse(source);
  const { workspaceId, runId, workspaceSlug } = reviewProvenanceSchema.parse(
    await loadJson(
      `/api/sessions/${encodeURIComponent(source.sessionId)}/artifacts/${encodeURIComponent(source.artifactId)}/provenance`,
      signal,
    ),
  );
  return runId ? { workspaceId, runId, workspaceSlug } : null;
}

function catalogPath({ workspaceId, runId }: ArtifactScope) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/artifacts`;
}

function itemPath(scope: ArtifactScope, target: ArtifactTarget) {
  return `${catalogPath(scope)}/${target.kind}/${encodeURIComponent(target.id)}`;
}

export async function loadArtifactPage(
  scope: ArtifactScope,
  signal: AbortSignal,
  cursor?: string,
): Promise<ArtifactPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const page = catalogSchema.parse(await loadJson(`${catalogPath(scope)}${query}`, signal));
  if (page.items.some((artifact) => artifact.producer.runId !== scope.runId)) {
    throw new Error("Artifact belongs to a different run.");
  }
  return page;
}

export async function inspectArtifact(
  scope: ArtifactScope,
  target: ArtifactTarget,
  signal: AbortSignal,
): Promise<InspectedArtifact> {
  const { artifact } = z
    .object({ artifact: inspectedArtifactSchema })
    .parse(await loadJson(itemPath(scope, target), signal));
  if (
    artifact.id !== target.id ||
    artifact.kind !== target.kind ||
    artifact.producer.runId !== scope.runId
  ) {
    throw new Error("Artifact identity does not match the selection.");
  }
  return artifact;
}

export async function fetchPrivateArtifact(
  scope: ArtifactScope,
  target: ArtifactTarget,
  signal: AbortSignal,
) {
  const response = await fetch(`${itemPath(scope, target)}?download=1`, {
    signal,
    cache: "no-store",
  });
  if (response.ok) return { kind: "bytes", blob: await response.blob() } as const;
  try {
    const { availability } = availabilityResponseSchema.parse(await response.json());
    return { kind: "blocked", availability } as const;
  } catch {
    throw new ArtifactEvidenceRequestError(response.status);
  }
}
