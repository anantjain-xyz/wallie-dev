"use client";

import { useEffect, useState } from "react";

import { ExecutionProfileFields } from "@/components/shared/execution-profile-fields";
import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { fetchFactoryEditor } from "@/features/factory-definition/editor-requests";
import type { FactoryEditorDocument } from "@/lib/factory-definitions/editor-contracts";
import {
  factoryEditorExecutionProfileResponseSchema,
  type FactoryEditorExecutionProfileResponse,
} from "@/lib/factory-definitions/execution-profile-contracts";

type Result = { kind: "ready"; value: FactoryEditorExecutionProfileResponse } | { kind: "failed" };

export function FactoryExecutionProfilePanel({
  api,
  target,
  refresh,
}: {
  api: string;
  target: Pick<FactoryEditorDocument, "id" | "kind" | "digest">;
  refresh: number;
}) {
  const { id, kind, digest } = target;
  const [result, setResult] = useState<{ key: string; data: Result } | null>(null);
  const query = `${api}/execution-profile?${kind}Id=${id}`;
  const key = `${query}:${digest}:${refresh}`;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void fetchFactoryEditor(query, factoryEditorExecutionProfileResponseSchema, { signal })
      .then((value) => {
        if (!signal.aborted) setResult({ key, data: { kind: "ready", value } });
      })
      .catch(() => {
        if (!signal.aborted) setResult({ key, data: { kind: "failed" } });
      });
    return () => controller.abort();
  }, [key, query]);

  const current = result?.key === key ? result.data : null;
  return (
    <PageSection
      anchorId="execution-profile"
      title="Effective execution profile"
      tagline={`${kind === "draft" ? "Saved draft" : "Saved revision"} · ${digest.slice(0, 12)}`}
    >
      <div className="ui-sheet min-w-0 p-4 sm:p-5">
        {current?.kind === "ready" ? (
          <FactoryProfileMetadata
            profile={current.value.profile}
            readiness={current.value.readiness}
          />
        ) : (
          <p className="type-secondary text-muted" role="status">
            {current?.kind === "failed"
              ? "Execution profile unavailable. Reload the definition to retry."
              : "Checking execution profile…"}
          </p>
        )}
      </div>
    </PageSection>
  );
}

function FactoryProfileMetadata({ profile, readiness }: FactoryEditorExecutionProfileResponse) {
  const authority = profile.credentialAuthority;
  return (
    <>
      <MetadataList>
        <ExecutionProfileFields profile={profile} />
        <MetadataItem
          label="Credential authority"
          value={authority.kind === "human" ? "Session creator" : "Service principal"}
        />
        {authority.kind === "service" && (
          <>
            <MetadataItem
              label="Execution grant"
              value={
                <span className="[overflow-wrap:anywhere]">
                  {authority.grantId} · v{authority.grantVersion}
                </span>
              }
            />
            <MetadataItem
              label="Credential binding"
              value={
                authority.bindingId ? (
                  <span className="[overflow-wrap:anywhere]">{authority.bindingId}</span>
                ) : (
                  "Missing"
                )
              }
            />
          </>
        )}
        {readiness.status === "checked" && (
          <>
            <MetadataItem
              label={authority.kind === "human" ? "Your credential" : "Service credential"}
              value={
                readiness.credential.status === "ready" ? "Ready" : readiness.credential.reason
              }
            />
            <MetadataItem
              label="Primary repository capability"
              value={readiness.sandbox.status === "ready" ? "Ready" : readiness.sandbox.reason}
            />
          </>
        )}
      </MetadataList>
      {readiness.status === "unavailable" && (
        <p className="type-secondary mt-4 text-muted" role="status">
          {readiness.reason}
        </p>
      )}
    </>
  );
}
