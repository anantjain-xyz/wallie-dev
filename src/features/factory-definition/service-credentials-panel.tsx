"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { SelectField } from "@/components/ui/select";
import {
  factoryEditorPost,
  fetchFactoryEditor,
} from "@/features/factory-definition/editor-requests";
import { dateFormatter } from "@/features/settings/settings-ui";
import {
  factorySecretBindingMutationResponseSchema,
  factorySecretBindingResponseSchema,
  type FactorySecretBindingCommand,
  type FactorySecretBindingMetadata,
  type FactorySecretBindingResponse,
  type FactorySecretBindingScope,
} from "@/lib/factory-secret-bindings/contracts";
import { workspaceSettingsPath } from "@/lib/routes";

const statusLabels = {
  ready: "Ready",
  missing: "Saved secret unavailable",
  revoked: "Revoked",
  grant_unavailable: "Grant unavailable",
} satisfies Record<FactorySecretBindingMetadata["status"], string>;

export function ServiceCredentialsPanel({
  endpoint,
  scope,
  workspaceSlug,
  canUseBinding,
  onChanged,
  onUseBinding,
}: {
  endpoint: string;
  scope: FactorySecretBindingScope;
  workspaceSlug: string;
  canUseBinding: boolean;
  onChanged?: () => void;
  onUseBinding: (id: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<FactorySecretBindingResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [secretId, setSecretId] = useState("");
  const [pending, setPending] = useState<FactorySecretBindingCommand["action"] | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const { agentId, bindingId, grantId, grantVersion, provider } = scope;
  const query = new URLSearchParams({
    agentId,
    grantId,
    grantVersion: String(grantVersion),
    provider,
  });
  if (bindingId) query.set("bindingId", bindingId);
  if (scope.provider === "opencode") query.set("openCodeProviderId", scope.openCodeProviderId);
  const url = `${endpoint}?${query}`;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void fetchFactoryEditor(url, factorySecretBindingResponseSchema, { signal })
      .then((result) => {
        if (signal.aborted) return;
        setSnapshot(result);
        setLoadError(false);
      })
      .catch(() => {
        if (!signal.aborted) setLoadError(true);
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, url]);

  function reload() {
    setLoading(true);
    setLoadError(false);
    setRefresh((previous) => previous + 1);
  }

  async function mutate(command: FactorySecretBindingCommand) {
    if (loading || pending) return;
    setPending(command.action);
    setError(null);
    setNotice(null);
    try {
      await fetchFactoryEditor(
        endpoint,
        factorySecretBindingMutationResponseSchema,
        factoryEditorPost(command),
      );
      setRevokeOpen(false);
      setSecretId("");
      setNotice(command.action === "attach" ? "Saved secret attached." : "Binding revoked.");
      onChanged?.();
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the credential binding.");
    } finally {
      setPending(null);
    }
  }

  function attachSecret(workspaceSecretId: string) {
    const input = { action: "attach" as const, grantId, grantVersion, agentId, workspaceSecretId };
    void mutate(
      scope.provider === "opencode"
        ? { ...input, provider: scope.provider, openCodeProviderId: scope.openCodeProviderId }
        : { ...input, provider: scope.provider },
    );
  }

  const { binding, availableBinding, eligibleSecrets, grantMatches } = snapshot ?? {};
  const active = availableBinding ?? (binding?.status !== "revoked" ? binding : null);
  const usable = active?.status === "ready" && active.id !== bindingId ? active : null;
  const validSecret = eligibleSecrets?.some((secret) => secret.id === secretId) ? secretId : "";
  const busy = loading || pending !== null;
  const settingsHref = `${workspaceSettingsPath(workspaceSlug)}#runtime`;
  const revokeLabel = availableBinding ? "Revoke available binding" : "Revoke binding";

  return (
    <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="type-secondary text-foreground" role="status">
          {loading
            ? "Checking service credential…"
            : loadError
              ? "Could not load service credentials."
              : binding
                ? !bindingId && binding.status === "ready"
                  ? "Ready to use"
                  : statusLabels[binding.status]
                : !grantMatches
                  ? "Grant unavailable"
                  : bindingId
                    ? "Binding unavailable"
                    : "No service credential attached"}
        </p>
        <button
          className="ui-button"
          disabled={busy}
          onClick={reload}
          ref={refreshButton}
          type="button"
        >
          Refresh status
        </button>
      </div>
      {scope.provider === "opencode" ? (
        <p className="text-xs text-muted">
          OpenCode provider <code className="break-all">{scope.openCodeProviderId}</code>
        </p>
      ) : null}
      {!loadError && binding?.materialRevision ? (
        <p className="text-xs text-muted">
          {binding.secretKey ? (
            <>
              <code className="break-all">{binding.secretKey}</code>
              {" · "}
            </>
          ) : null}
          Material revision {binding.materialRevision}
          {binding.rotatedAt ? (
            <>
              {" · Updated "}
              <time dateTime={binding.rotatedAt}>
                {dateFormatter.format(new Date(binding.rotatedAt))}
              </time>
            </>
          ) : null}
        </p>
      ) : null}
      {!busy && !loadError && availableBinding?.status === "ready" ? (
        <p className="text-sm text-muted">A replacement binding is ready to use.</p>
      ) : null}
      {notice ? (
        <p className="text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error && !revokeOpen ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {!loadError && grantMatches && !active ? (
        eligibleSecrets?.length ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (validSecret) attachSecret(validSecret);
            }}
          >
            <SelectField
              className="flex-1"
              disabled={busy}
              emptyOption={{ label: "Choose a saved secret", value: "" }}
              label="Saved workspace secret"
              onValueChange={setSecretId}
              options={eligibleSecrets.map((secret) => ({ label: secret.key, value: secret.id }))}
              value={validSecret}
              wrap
            />
            <button className="ui-button" disabled={busy || !validSecret} type="submit">
              <ActionButtonLabel
                idle="Attach secret"
                pending={pending === "attach"}
                pendingLabel="Attaching…"
              />
            </button>
          </form>
        ) : (
          <p className="text-sm text-muted">Save a workspace secret to attach it to this grant.</p>
        )
      ) : null}
      {loadError ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {usable && canUseBinding ? (
            <button
              className="ui-button"
              disabled={busy}
              onClick={() => onUseBinding(usable.id)}
              type="button"
            >
              Use in working definition
            </button>
          ) : null}
          {active ? (
            <DestructiveConfirmationDialog
              actionLabel={revokeLabel}
              description="Future runs using this binding will stop before accessing the saved secret."
              errorMessage={error}
              onConfirm={() =>
                void mutate({
                  action: "revoke",
                  bindingId: active.id,
                  expectedVersion: active.version,
                })
              }
              onOpenChange={(open) => {
                setError(null);
                setRevokeOpen(open);
              }}
              open={revokeOpen}
              pending={pending === "revoke"}
              pendingLabel="Revoking…"
              restoreFocusRef={refreshButton}
              title="Revoke this credential binding?"
              trigger={
                <button className="ui-button-danger" disabled={busy} type="button">
                  {revokeLabel}
                </button>
              }
            />
          ) : null}
          <Link className="text-sm text-accent underline underline-offset-2" href={settingsHref}>
            {active?.status === "ready" ? "Rotate in workspace secrets" : "Open workspace secrets"}
          </Link>
        </div>
      )}
    </div>
  );
}
