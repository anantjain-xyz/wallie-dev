"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import type { GovernanceData } from "@/features/factory-governance/governance-data";
import { GovernanceTime } from "@/features/factory-governance/governance-resource-link";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  factoryCommandLabels,
  factoryMachineTokenCommandSchema,
  type FactoryMachineTokenCommand,
} from "@/lib/factory-machine-tokens/contracts";

type Grant = Pick<
  GovernanceData["grantList"]["entries"][number],
  "id" | "version" | "command_scopes" | "expires_at" | "revoked_at"
>;
type Token = GovernanceData["tokenList"]["entries"][number];

function post(endpoint: string, command: FactoryMachineTokenCommand) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

function CreateMachineToken({ endpoint, grant }: { endpoint: string; grant: Grant }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const dismissed = useRef(false);
  const action = useApiAction<{ credential: string }, [FactoryMachineTokenCommand]>({
    call: (command) => post(endpoint, command),
    errorText: "Could not create the machine token.",
    onSuccess: ({ credential }) => {
      setCredential(credential);
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });

  useEffect(() => {
    if (credential) copyButton.current?.focus();
    else if (dismissed.current) {
      dismissed.current = false;
      name.current?.focus();
    }
  }, [credential]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const date = fields.get("expiresAt");
    const expiry = typeof date === "string" && date ? new Date(date) : null;
    if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())) {
      setFeedback({ kind: "error", text: "Choose a future expiry." });
      return;
    }
    const request = factoryMachineTokenCommandSchema.safeParse({
      action: "create",
      grantVersion: grant.version,
      name: fields.get("name"),
      scopes: fields.getAll("scope"),
      expiresAt: expiry?.toISOString(),
    });
    if (!request.success) {
      setFeedback({ kind: "error", text: "Enter a name and select at least one command scope." });
      return;
    }
    setFeedback(null);
    void action.run(request.data);
  }

  async function copyCredential() {
    if (!credential) return;
    try {
      await navigator.clipboard.writeText(credential);
      setFeedback({ kind: "success", text: "Token copied." });
    } catch {
      setFeedback({ kind: "error", text: "Select the token text and copy it manually." });
    }
  }

  if (credential) {
    return (
      <div className="ui-sheet min-w-0 space-y-3 p-4 sm:p-5">
        <p className="type-secondary text-foreground" role="status">
          Machine token created. Copy it now. The token is shown only once.
        </p>
        <code className="block rounded-md border border-border bg-background p-3 text-sm [overflow-wrap:anywhere] select-all">
          {credential}
        </code>
        <InlineActionMessage message={feedback} />
        <div className="flex flex-wrap gap-2">
          <button
            className="ui-button ui-button-primary"
            onClick={() => void copyCredential()}
            ref={copyButton}
            type="button"
          >
            Copy token
          </button>
          <button
            className="ui-button"
            onClick={() => {
              dismissed.current = true;
              setCredential(null);
              setFeedback(null);
            }}
            type="button"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5" onSubmit={submit}>
      <InlineActionMessage message={feedback} />
      <fieldset className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">New machine token</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label text-foreground">Token name</span>
            <input
              autoComplete="off"
              className="ui-input"
              maxLength={120}
              name="name"
              ref={name}
              required
            />
          </label>
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label text-foreground">Expires at (optional)</span>
            <input className="ui-input" name="expiresAt" type="datetime-local" />
          </label>
        </div>
        <fieldset className="min-w-0 space-y-2">
          <legend className="type-label text-foreground">Command scopes</legend>
          {grant.command_scopes.map((scope) => (
            <label className="flex items-center gap-2 text-sm text-foreground" key={scope}>
              <input name="scope" type="checkbox" value={scope} />
              {factoryCommandLabels[scope]}
            </label>
          ))}
        </fieldset>
        <p className="type-secondary text-muted">
          Access ends when this grant expires, changes, or is revoked.
        </p>
        <button className="ui-button ui-button-primary" type="submit">
          <ActionButtonLabel
            idle="Create machine token"
            pending={action.isBusy}
            pendingLabel="Creating…"
          />
        </button>
      </fieldset>
    </form>
  );
}

function RevokeMachineToken({ endpoint, token }: { endpoint: string; token: Token }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const action = useApiAction<unknown, [FactoryMachineTokenCommand]>({
    call: (command) => post(endpoint, command),
    errorText: "Could not revoke the machine token.",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });

  return (
    <DestructiveConfirmationDialog
      actionLabel="Revoke token"
      description="Requests using this token will lose access immediately."
      errorMessage={feedback?.text}
      onConfirm={() => void action.run({ action: "revoke", tokenId: token.id })}
      onOpenChange={(value) => {
        setOpen(value);
        setFeedback(null);
      }}
      open={open}
      pending={action.isBusy}
      pendingLabel="Revoking…"
      title={`Revoke ${token.name}?`}
      trigger={
        <button className="ui-button-danger" type="button">
          Revoke token
        </button>
      }
    />
  );
}

function tokenStatus(token: Token, grant: Grant, factoryActive: boolean, asOf: number) {
  if (token.revoked_at) return "Revoked";
  if (!factoryActive) return "Factory archived";
  if (grant.revoked_at || token.execution_grant_version !== grant.version)
    return "Grant unavailable";
  if (Date.parse(token.expires_at ?? grant.expires_at) <= asOf) return "Expired";
  return "Active";
}

export function GrantMachineTokens({
  asOf,
  factoryActive,
  factoryId,
  grant,
  tokens,
  workspaceId,
}: {
  asOf: number;
  factoryActive: boolean;
  factoryId: string;
  grant: Grant;
  tokens: Token[];
  workspaceId: string;
}) {
  const endpoint = `/api/workspaces/${workspaceId}/factories/${factoryId}/execution-grants/${grant.id}/machine-tokens`;
  const canIssue =
    factoryActive &&
    !grant.revoked_at &&
    Date.parse(grant.expires_at) > asOf &&
    grant.command_scopes.length > 0;

  return (
    <div className="space-y-4">
      {canIssue && <CreateMachineToken endpoint={endpoint} grant={grant} />}
      {!grant.command_scopes.length && (
        <p className="type-secondary text-muted">This grant has no machine command scopes.</p>
      )}
      {tokens.length ? (
        <div className="ui-sheet divide-y divide-border">
          {tokens.map((token) => (
            <article className="min-w-0 space-y-3 p-4 sm:p-5" key={token.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 font-semibold text-foreground [overflow-wrap:anywhere]">
                  {token.name}
                </h3>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="type-label text-muted">
                    {tokenStatus(token, grant, factoryActive, asOf)}
                  </span>
                  {!token.revoked_at && <RevokeMachineToken endpoint={endpoint} token={token} />}
                </div>
              </div>
              <MetadataList>
                <MetadataItem
                  label="Token ID"
                  monospace
                  value={<span className="[overflow-wrap:anywhere]">{token.id}</span>}
                />
                <MetadataItem
                  label="Scopes"
                  value={token.scopes.map((scope) => factoryCommandLabels[scope]).join(", ")}
                />
                <MetadataItem label="Created" value={<GovernanceTime value={token.created_at} />} />
                <MetadataItem
                  label="Expires"
                  value={
                    token.expires_at ? <GovernanceTime value={token.expires_at} /> : "With grant"
                  }
                />
                <MetadataItem
                  label="Last used"
                  value={
                    token.last_used_at ? <GovernanceTime value={token.last_used_at} /> : "Never"
                  }
                />
                {token.last_used_scope && (
                  <MetadataItem
                    label="Last command"
                    value={factoryCommandLabels[token.last_used_scope]}
                  />
                )}
              </MetadataList>
            </article>
          ))}
        </div>
      ) : (
        <p className="type-secondary text-muted">No machine tokens on this page.</p>
      )}
    </div>
  );
}
