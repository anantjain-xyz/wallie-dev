"use client";

import { useState } from "react";

import { SandboxProviderSection } from "@/features/settings/sandbox-provider-section";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import type { SandboxSettingsResponse } from "@/lib/sandbox-connections/contracts";

import type { OnboardingStepProps } from "./types";

function updateSandboxSettingsInData(
  currentData: WorkspaceOnboardingData,
  settings: SandboxSettingsResponse,
): WorkspaceOnboardingData {
  const active = settings.connections[settings.activeProvider];
  const vercel = settings.connections.vercel;
  const activeProviderEnabled = settings.enabledProviders.includes(settings.activeProvider);
  const providerLabel =
    settings.activeProvider === "vercel"
      ? "Vercel Sandbox"
      : settings.activeProvider === "e2b"
        ? "E2B"
        : "Daytona";
  return {
    ...currentData,
    sandboxSettings: settings,
    vercelSandboxConnection: vercel,
    setupHealth: {
      ...currentData.setupHealth,
      sandboxConnection: {
        connected: activeProviderEnabled && active?.status === "connected",
        connectionRevision: active ? String(active.connectionRevision) : null,
        displayName:
          settings.activeProvider === "vercel"
            ? (vercel?.projectName ?? vercel?.projectId ?? null)
            : settings.activeProvider === "e2b"
              ? (settings.connections.e2b?.apiKeyPreview ?? null)
              : (settings.connections.daytona?.target ??
                settings.connections.daytona?.apiUrl ??
                null),
        lastValidationError: activeProviderEnabled
          ? (active?.lastValidationError ?? null)
          : `${providerLabel} is disabled in this Wallie deployment. Switch to an enabled sandbox provider.`,
        provider: settings.activeProvider,
        providerLabel,
        status: activeProviderEnabled ? (active?.status ?? "missing") : "error",
        updatedAt: active?.updatedAt ?? null,
      },
      vercelSandboxConnection: vercel
        ? {
            connected: vercel.status === "connected",
            lastValidationError: vercel.lastValidationError,
            projectId: vercel.projectId,
            projectName: vercel.projectName,
            status: vercel.status,
            teamId: vercel.teamId,
            updatedAt: vercel.updatedAt,
          }
        : {
            connected: false,
            lastValidationError: null,
            projectId: null,
            projectName: null,
            status: "missing",
            teamId: null,
            updatedAt: null,
          },
    },
  };
}

export default function SandboxStep({ data, isSaving, onDataChange }: OnboardingStepProps) {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      {error ? (
        <div
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {message ? (
        <div
          className="rounded-[6px] border border-success/20 bg-success-soft px-3 py-2 text-[13px] text-success"
          role="status"
        >
          {message}
        </div>
      ) : null}

      <SandboxProviderSection
        canManage={data.canManage && !isSaving}
        onSettingsChange={(settings) =>
          onDataChange((current) => updateSandboxSettingsInData(current, settings))
        }
        setFlashMessage={(flash) => {
          setError(flash.kind === "error" ? flash.text : null);
          setMessage(flash.kind === "error" ? null : flash.text);
        }}
        settings={data.sandboxSettings}
        variant="onboarding"
        vercelConnection={data.vercelSandboxConnection}
        workspaceId={data.workspace.id}
      />
    </div>
  );
}
