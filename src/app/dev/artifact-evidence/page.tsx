import { notFound } from "next/navigation";

import { MarkdownContent } from "@/components/shared/markdown-content";
import { renderMarkdown } from "@/components/shared/markdown-content.server";
import { isProductionDeploy } from "@/env/deploy";
import { ArtifactPanel } from "@/features/sessions/detail/artifact-panel";

const sessionId = "11111111-1111-4111-8111-111111111111";
const artifactId = "33333333-3333-4333-8333-333333333333";
const now = "2026-11-08T15:00:00.000Z";
const markdown = `# Build review

The validation report is retained with this artifact. Temporary evidence from older runs is unavailable.

## Retained evidence

[Review validation report](wallie-evidence:review/report)

## Legacy evidence

[PR description and evidence](/vercel/sandbox/docs/evidence/comments-toggle-pr-description.md)

[Review notes](file:///tmp/wallie/review-notes.md)

## Missing evidence

[Uncaptured report](wallie-evidence:review/missing)

![Screenshot from the old sandbox](/vercel/sandbox/docs/evidence/desktop.png)

## Reference links

[Repository documentation](https://github.com/anantjain-xyz/wallie-dev/blob/714edc93/docs/VALIDATION-EVIDENCE.md) · [Relative document](docs/VALIDATION-EVIDENCE.md) · [Review section](#retained-evidence)
`;

/** Deterministic, non-production preview of the actual artifact review renderer. */
export default function ArtifactEvidencePreview() {
  if (isProductionDeploy()) notFound();
  const evidenceLinks = new Map([
    [
      "wallie-evidence:review/report",
      `/api/sessions/${sessionId}/validation-evidence/assets/55555555-5555-4555-8555-555555555555?artifactId=${artifactId}`,
    ],
  ]);
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
      <p className="mb-2 text-xs uppercase tracking-wide text-muted">Wallie · Review preview</p>
      <h1 className="mb-2 text-xl font-semibold">Artifact evidence</h1>
      <p className="mb-6 text-sm text-muted">
        Synthetic review fixture. Retained, legacy, and missing evidence use the session artifact
        renderer. Downloads require an authorized workspace session.
      </p>
      <section className="rounded-lg border border-border bg-surface p-4 sm:p-6">
        <ArtifactPanel
          readOnlyReason="approved"
          currentArtifactId={artifactId}
          emptyText="No artifact"
          initialFormattedArtifact={
            <MarkdownContent html={renderMarkdown(markdown, true, evidenceLinks).bodyHtml} />
          }
          initialFormattedArtifactKey={`${sessionId}:build:id:${artifactId}`}
          initialNow={now}
          isDrafting={false}
          latestArtifact={{
            id: artifactId,
            createdAt: now,
            payload: markdown,
            stageSlug: "build",
            version: 2,
          }}
          loadLatest
          sessionId={sessionId}
          stageSlug="build"
        />
      </section>
    </main>
  );
}
