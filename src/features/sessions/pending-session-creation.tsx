"use client";

import Image from "next/image";
import { useEffect, useRef, type ReactNode } from "react";

import { ShimmerText } from "@/components/shared/shimmer-text";
import { PageContainer, PageHeader, PAGE_HEADER_TITLE_CLASS } from "@/components/ui/page-shell";

export type SessionCreationPreview = {
  content: ReactNode;
  dismiss: () => void;
};

export type PendingSessionSnapshot = {
  images: { clientId: string; fileName: string; previewUrl: string }[];
  linearIssueUrl: string | null;
  prompt: string;
  repositoryName: string | null;
  stages: { id: string; name: string }[];
  title: string;
};

export function PendingSessionCreation({
  onDismiss,
  snapshot,
}: {
  onDismiss: () => void;
  snapshot: PendingSessionSnapshot;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <PageContainer>
      <section
        className="ui-session-creation-enter"
        aria-label="Creating session"
        data-session-creation
      >
        <PageHeader
          eyebrowAsPlain
          eyebrow={
            <button
              className="cursor-pointer transition-colors hover:text-foreground"
              onClick={() => {
                onDismiss();
                requestAnimationFrame(() => {
                  const heading = document.getElementById("main-content")?.querySelector("h1");
                  if (heading && !heading.closest("[data-session-creation]")) {
                    heading.tabIndex = -1;
                    heading.focus();
                  }
                });
              }}
              type="button"
            >
              ← Back to workspace
            </button>
          }
          titleAsChild
          title={
            <h1
              className={`${PAGE_HEADER_TITLE_CLASS} outline-none`}
              ref={headingRef}
              tabIndex={-1}
            >
              {snapshot.title}
            </h1>
          }
          description={snapshot.repositoryName}
        />
        <div className="mb-5 flex items-center gap-2 text-sm text-muted" role="status">
          <ShimmerText>Creating session…</ShimmerText>
        </div>
        <ol
          aria-label="Selected stages"
          className="mb-6 flex flex-wrap gap-x-6 gap-y-2 border-y border-border py-3"
        >
          {snapshot.stages.map((stage, index) => (
            <li key={stage.id} className="flex items-center gap-2 text-sm text-muted">
              <span className="type-annotation tabular-nums">{index + 1}</span>
              {stage.name}
            </li>
          ))}
        </ol>
        {snapshot.prompt ? (
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold">Prompt</h2>
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{snapshot.prompt}</p>
          </section>
        ) : null}
        {snapshot.images.length ? (
          <ul className="mb-6 flex flex-wrap gap-3" aria-label="Session images">
            {snapshot.images.map((image) => (
              <li key={image.clientId}>
                <Image
                  alt={image.fileName}
                  className="h-20 w-20 rounded-[6px] border border-border object-cover"
                  height={80}
                  width={80}
                  src={image.previewUrl}
                  unoptimized
                />
              </li>
            ))}
          </ul>
        ) : null}
        {snapshot.linearIssueUrl ? (
          <a
            className="text-sm text-primary underline"
            href={snapshot.linearIssueUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open linked Linear issue ↗
          </a>
        ) : null}
        <p className="mt-5 text-sm text-muted">
          Saving your request. You can keep working while Wallie creates the session.
        </p>
      </section>
    </PageContainer>
  );
}
