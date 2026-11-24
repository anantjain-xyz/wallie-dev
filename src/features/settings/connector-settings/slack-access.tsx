"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { z } from "zod/v4";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  slackConnectorSetupCommandSchema,
  slackConnectorSetupResultSchema,
  slackConnectorSetupSchema,
  slackTeamIdSchema,
} from "@/lib/connectors/slack/contracts";

import { connectorCommand, readConnectorResponse } from "./request";
import { ConnectorSelect } from "./select";

type SlackSetup = z.output<typeof slackConnectorSetupSchema>;
type SlackCommand = z.input<typeof slackConnectorSetupCommandSchema>;
type RevokeCommand = Extract<SlackCommand, { action: "revoke" }>;

function oauthReturnMessage(result: string | null): FlashMessage | null {
  switch (result) {
    case "installed":
      return { kind: "success", text: "Slack authorization saved." };
    case "linked":
      return { kind: "success", text: "Your Slack identity is linked." };
    case "error":
      return { kind: "error", text: "Slack authorization could not be completed. Try again." };
    default:
      return null;
  }
}

export function SlackConnectorAccess({
  canManage = false,
  endpoint,
  installationId,
  result,
}: {
  canManage?: boolean;
  endpoint: string;
  installationId?: string;
  result: string | null;
}) {
  const [setup, setSetup] = useState<SlackSetup | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [enteredTeamId, setEnteredTeamId] = useState<string>();
  const [message, setMessage] = useState<FlashMessage | null>(() => oauthReturnMessage(result));
  const [revocation, setRevocation] = useState<RevokeCommand | null>(null);
  const accessHeading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef<HTMLElement>(null);
  const slackEndpoint = `${endpoint}/slack`;

  useEffect(() => {
    const abort = new AbortController();
    void fetch(slackEndpoint, { signal: abort.signal })
      .then((response) => readConnectorResponse(response, slackConnectorSetupSchema))
      .then((data) => {
        if (abort.signal.aborted) return;
        setSetup(data);
        setLoadFailed(false);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setSetup(null);
        setLoadFailed(true);
      });
    return () => abort.abort();
  }, [reload, slackEndpoint]);

  const action = useApiAction<unknown, [SlackCommand], true>({
    call: (command) =>
      fetch(slackEndpoint, connectorCommand(slackConnectorSetupCommandSchema.parse(command))),
    errorText: "Could not update Slack access.",
    onSuccess: (payload, [command]) => {
      const response = slackConnectorSetupResultSchema.parse(payload);
      if (command.action === "revoke" && "revoked" in response) {
        setReload((value) => value + 1);
        return true;
      }
      if (command.action !== "revoke" && "authorizationUrl" in response) {
        window.location.assign(response.authorizationUrl);
        return true;
      }
      throw new Error("Slack setup returned an unexpected result. Try again.");
    },
    setFlashMessage: setMessage,
    successText: (_payload, [command]) =>
      command.action === "revoke" ? "Your Slack identity link was removed." : null,
  });

  const installations = setup?.installations ?? [];
  const installation = installationId
    ? installations.find(({ id }) => id === installationId)
    : (installations.find(({ id }) => id === selectedId) ??
      installations.find(({ status }) => status === "connected") ??
      installations[0]);
  const teamId = enteredTeamId ?? installation?.teamId ?? "";
  const installTarget = installations.find((item) => item.teamId === teamId.trim());
  const validTeam = slackTeamIdSchema.safeParse(teamId.trim()).success;
  const link = installation?.linkedActor;
  const canLink = setup?.configured && installation?.status === "connected";

  function startInstallation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validTeam) return;
    setMessage(null);
    void action.run({
      action: "install",
      teamId: teamId.trim(),
      expectedGeneration: installTarget?.generation ?? 0,
    });
  }

  async function revokeIdentity() {
    if (!revocation) return;
    if (await action.run(revocation)) {
      restoreFocus.current = accessHeading.current;
      setRevocation(null);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground" ref={accessHeading} tabIndex={-1}>
        Slack access
      </h3>
      {loadFailed ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-danger" role="alert">
            Slack setup is unavailable.
          </p>
          <button
            className="ui-button"
            onClick={() => {
              setLoadFailed(false);
              setReload((value) => value + 1);
            }}
            type="button"
          >
            Reload Slack setup
          </button>
        </div>
      ) : !setup ? (
        <p className="text-sm text-muted" role="status">
          Loading Slack access…
        </p>
      ) : (
        <>
          {!setup.configured ? (
            <p className="text-sm text-muted">
              Slack authorization is unavailable on this deployment.
            </p>
          ) : null}
          {!installationId && installations.length > 1 ? (
            <ConnectorSelect
              label="Slack workspace"
              disabled={action.isBusy}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setEnteredTeamId(undefined);
                setMessage(null);
              }}
              value={installation?.id ?? ""}
            >
              {installations.map(({ id, teamName, teamId }) => (
                <option key={id} value={id}>
                  {teamName} · {teamId}
                </option>
              ))}
            </ConnectorSelect>
          ) : null}
          {installation ? (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm text-muted">
                <strong className="font-medium text-foreground">{installation.teamName}</strong>
                {link ? ` · Linked as ${link.userId}` : null}
              </p>
              {installation.status === "disconnected" ? (
                <p className="text-sm text-muted">Slack workspace disconnected.</p>
              ) : installation.status === "credential_unavailable" ? (
                <p className="text-sm text-muted">Slack workspace access unavailable.</p>
              ) : null}
              {(canManage || setup.canConfigure) && installation.grantedScopes.length ? (
                <p className="break-words text-xs text-muted">
                  Granted Slack permissions {installation.grantedScopes.join(", ")}
                </p>
              ) : null}
              {installation.missingScopes.length ? (
                <p className="break-words text-sm text-muted">
                  Missing Slack permissions {installation.missingScopes.join(", ")}
                </p>
              ) : null}
              {link ? (
                <button
                  className="ui-button"
                  disabled={action.isBusy}
                  onClick={(event) => {
                    setMessage(null);
                    restoreFocus.current = event.currentTarget;
                    setRevocation({
                      action: "revoke",
                      installationId: installation.id,
                      linkId: link.id,
                    });
                  }}
                  type="button"
                >
                  Remove Slack identity link
                </button>
              ) : canLink ? (
                <button
                  className="ui-button"
                  disabled={action.isBusy}
                  onClick={() => {
                    setMessage(null);
                    void action.run({
                      action: "link",
                      installationId: installation.id,
                      expectedGeneration: installation.generation,
                    });
                  }}
                  type="button"
                >
                  Link my Slack account
                </button>
              ) : null}
            </div>
          ) : !setup.canConfigure ? (
            <p className="text-sm text-muted">A workspace admin can connect Slack here.</p>
          ) : null}
          {setup.configured && setup.canConfigure ? (
            <form className="space-y-2" onSubmit={startInstallation}>
              <label className="block max-w-xs space-y-1.5 text-sm font-medium text-foreground">
                <span className="block">Slack workspace ID</span>
                <input
                  autoComplete="off"
                  className="ui-input"
                  disabled={action.isBusy}
                  maxLength={32}
                  onChange={(event) => setEnteredTeamId(event.target.value)}
                  placeholder="T0123456789"
                  required
                  spellCheck={false}
                  value={teamId}
                />
              </label>
              <p className="text-xs text-muted">
                Use the workspace ID after /client/ in the Slack web address.
              </p>
              <button
                className="ui-button-primary"
                disabled={!validTeam || action.isBusy}
                type="submit"
              >
                {installTarget ? "Reconnect Slack" : "Connect Slack"}
              </button>
            </form>
          ) : null}
        </>
      )}
      <DestructiveConfirmationDialog
        actionLabel="Remove identity link"
        description="Your Slack account will lose its linked Wallie identity. You can link it again later."
        errorMessage={message?.kind === "error" ? message.text : null}
        onConfirm={() => void revokeIdentity()}
        onOpenChange={(open) => {
          if (!open) setRevocation(null);
        }}
        open={revocation !== null}
        pending={action.isBusy}
        pendingLabel="Removing…"
        restoreFocusRef={restoreFocus}
        title="Remove your Slack identity link?"
      />
      {revocation === null ? <InlineActionMessage message={message} /> : null}
    </div>
  );
}
