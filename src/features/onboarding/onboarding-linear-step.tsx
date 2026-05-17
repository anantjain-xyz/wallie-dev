"use client";

import { useRef, useState } from "react";

import type { SessionPipeline } from "@/features/sessions/types";
import { LinearKeyControls } from "@/features/settings/linear-key-controls";
import { LinearRoutingControls } from "@/features/settings/linear-routing-editor";
import type { FlashMessage } from "@/features/settings/settings-types";
import type { LinearRoutingConfig } from "@/lib/linear-routing/contracts";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";

type OnboardingLinearStepProps = {
  canManage: boolean;
  linearKeyConfigured: boolean;
  linearRouting: LinearRoutingConfig;
  linearSecret: WorkspaceSecretPreview | null;
  onCompleted: (action: string) => Promise<void>;
  onRefresh: (action: string) => Promise<void>;
  pipeline: SessionPipeline | null;
  workspaceId: string;
};

export function OnboardingLinearStep({
  canManage,
  linearKeyConfigured,
  linearRouting,
  linearSecret,
  onCompleted,
  onRefresh,
  pipeline,
  workspaceId,
}: OnboardingLinearStepProps) {
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [keySavedInSession, setKeySavedInSession] = useState(false);
  const [routingSavedSignature, setRoutingSavedSignature] = useState<string | null>(null);
  const [testPassed, setTestPassed] = useState(false);
  const completedRef = useRef(false);
  const stages = pipeline?.stages ?? [];
  const stageSignature = stages.map((stage) => stage.slug).join("\u0000");
  const keyPresent = linearKeyConfigured || Boolean(linearSecret) || keySavedInSession;
  const routingSaved = routingSavedSignature === stageSignature;

  async function completeIfReady(next: {
    keyPresent: boolean;
    routingSaved: boolean;
    testPassed: boolean;
  }) {
    if (completedRef.current || !next.keyPresent || !next.routingSaved || !next.testPassed) {
      return;
    }

    completedRef.current = true;
    try {
      await onCompleted("linear:complete");
    } catch (error) {
      completedRef.current = false;
      throw error;
    }
  }

  return (
    <div className="space-y-5">
      {message ? (
        <div
          aria-live="polite"
          role={message.kind === "error" ? "alert" : "status"}
          className={`rounded-[6px] border px-3 py-2 text-[13px] ${
            message.kind === "error"
              ? "border-danger/20 bg-danger-soft text-danger"
              : "border-success/20 bg-success-soft text-success"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <div className="rounded-[6px] border border-border bg-background p-4">
        <h3 className="text-[14px] font-semibold text-foreground">Linear key</h3>
        <div className="mt-3">
          <LinearKeyControls
            allowDelete={false}
            allowReplace
            canManage={canManage}
            linearSecret={linearSecret}
            onSecretSaved={async () => {
              setKeySavedInSession(true);
              setTestPassed(false);
              await onRefresh("linear:key");
            }}
            onTestSucceeded={async () => {
              setTestPassed(true);
              await completeIfReady({ keyPresent, routingSaved, testPassed: true });
            }}
            setFlashMessage={setMessage}
            workspaceId={workspaceId}
          />
        </div>
      </div>

      <div className="rounded-[6px] border border-border bg-background p-4">
        <h3 className="text-[14px] font-semibold text-foreground">Linear routing</h3>
        <div className="mt-4">
          <LinearRoutingControls
            canManage={canManage}
            onSaved={async () => {
              setRoutingSavedSignature(stageSignature);
              await onRefresh("linear:routing");
              await completeIfReady({ keyPresent, routingSaved: true, testPassed });
            }}
            routing={linearRouting}
            setFlashMessage={setMessage}
            stages={stages}
            workspaceId={workspaceId}
          />
        </div>
      </div>
    </div>
  );
}
