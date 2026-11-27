"use client";

import { useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField } from "@/components/ui/select";
import type { FactorySettingsFormRevision } from "@/features/settings/factory-settings";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import {
  sandboxProviderSchema,
  type SandboxSettingsResponse,
} from "@/lib/sandbox-connections/contracts";
import type { SandboxProvider } from "@/lib/sandbox/types";

const providerLabels: Record<SandboxProvider, string> = {
  vercel: "Vercel Sandbox",
  e2b: "E2B",
  daytona: "Daytona",
};

export function FactorySandboxProviderSettings({
  revision,
  settings,
}: {
  revision: FactorySettingsFormRevision;
  settings: SandboxSettingsResponse;
}) {
  const [provider, setProvider] = useState(revision.snapshot.sandboxProvider);
  const [error, setError] = useState<string | null>(null);
  const options = settings.enabledProviders.map((value) => ({
    value,
    label: providerLabels[value],
  }));
  const dirty = provider !== revision.snapshot.sandboxProvider;

  async function save() {
    setError(null);
    try {
      await revision.save({ kind: "sandbox-provider", provider });
      revision.setDirty(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the factory sandbox provider.",
      );
    }
  }

  return (
    <div className="space-y-3 rounded-[6px] border border-border bg-sheet p-4">
      <p className="text-xs leading-5 text-muted">
        This sets the sandbox for new sessions after you publish the default factory draft. It
        doesn’t change the workspace connection.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          className="min-w-0 flex-1"
          disabled={revision.busy}
          fallbackLabel={providerLabels[provider]}
          label="Factory sandbox provider"
          onValueChange={(value) => {
            const selected = sandboxProviderSchema.safeParse(value);
            if (!selected.success) return;
            setProvider(selected.data);
            setError(null);
            revision.setDirty(selected.data !== revision.snapshot.sandboxProvider);
          }}
          options={options}
          value={provider}
        />
        <button
          className="ui-button-primary"
          disabled={revision.busy || !dirty}
          onClick={() => void save()}
          type="button"
        >
          <ActionButtonLabel
            idle="Save to draft"
            pending={revision.busy && dirty}
            pendingLabel="Saving…"
          />
        </button>
      </div>
      {settings.connections[provider]?.status !== "connected" ? (
        <p className="text-xs leading-5 text-warning">
          Connect {providerLabels[provider]} to verify this configuration.
        </p>
      ) : null}
      <InlineActionMessage message={error ? { kind: "error", text: error } : null} />
    </div>
  );
}
