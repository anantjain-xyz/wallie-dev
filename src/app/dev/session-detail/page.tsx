import { MarkdownContent } from "@/components/shared/markdown-content";
import { renderMarkdown } from "@/components/shared/markdown-content.server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { isProductionDeploy } from "@/env/deploy";
import { SessionDetailPreview } from "./preview-client";

const buildMarkdown =
  "# Focus treatment\n\nThe prompt uses a quieter border at rest, with a visible focus ring for keyboard navigation.\n\n## Changes\n\n- Removed the persistent outline.\n- Kept a clear keyboard focus indicator.\n- Checked the session creation flow.";
const planMarkdown =
  "# Plan\n\nKeep the prompt visually quiet until the user interacts with it.\n\n- Inspect the dialog’s focus behavior.\n- Preserve keyboard accessibility.\n- Verify desktop and mobile layouts.";

/** Exercise the production presentation with deterministic data and no worker mutations. */
export default function SessionDetailPreviewPage() {
  if (isProductionDeploy()) notFound();
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted">Loading session preview…</p>}>
      <AppShell
        workspace={{ id: "preview", name: "Wallie", slug: "preview" }}
        onboarding={null}
        pathnameOverride="/w/preview/sessions/37"
        viewerId="preview-viewer"
        viewerEmail="preview@example.com"
        viewerAvatarUrl={null}
        workspaceAvatarUrl={null}
      >
        <SessionDetailPreview
          initialNow={new Date().toISOString()}
          artifacts={{
            plan: {
              markdown: planMarkdown,
              rendered: <MarkdownContent html={renderMarkdown(planMarkdown).bodyHtml} />,
            },
            build: {
              markdown: buildMarkdown,
              rendered: <MarkdownContent html={renderMarkdown(buildMarkdown).bodyHtml} />,
            },
          }}
        />
      </AppShell>
    </Suspense>
  );
}
