"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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

import { ResourceIdDetails } from "./catalog";
import { connectorCommand, readConnectorResponse } from "./request";
import { ConnectorSelect } from "./select";

type SlackSetup = z.output<typeof slackConnectorSetupSchema>;
type SlackCommand = z.input<typeof slackConnectorSetupCommandSchema>;
type RevokeCommand = Extract<SlackCommand, { action: "revoke" }>;
type SlackInstallation = SlackSetup["installations"][number];

const statusLabel = {
  connected: "Connected",
  disconnected: "Disconnected",
  credential_unavailable: "Access unavailable",
};

export function slackWorkspaceName(
  installation: Pick<SlackInstallation, "teamId" | "teamName"> | undefined,
) {
  const name = installation?.teamName.trim();
  return name && name !== installation?.teamId ? name : "Workspace name unavailable";
}

export function slackWorkspaceOption(installation: SlackInstallation) {
  return [
    slackWorkspaceName(installation),
    installation.teamDomain,
    statusLabel[installation.status],
  ]
    .filter(Boolean)
    .join(" · ");
}

function readSlackWorkspaceTarget(value: string) {
  const trimmed = value.trim();
  if (slackTeamIdSchema.safeParse(trimmed).success) return trimmed;
  try {
    const url = new URL(trimmed);
    const [, prefix, teamId] = url.pathname.split("/");
    if (
      url.origin === "https://app.slack.com" &&
      !url.username &&
      !url.password &&
      prefix === "client" &&
      slackTeamIdSchema.safeParse(teamId).success
    )
      return teamId;
  } catch {
    return undefined;
  }
  return undefined;
}

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

export function useSlackConnectorSetup(endpoint: string | null, installationScope = "") {
  const [loaded, setLoaded] = useState<{ key: string; data: SlackSetup | null } | null>(null);
  const [reload, setReload] = useState(0);
  const key = JSON.stringify([endpoint, installationScope, reload]);
  const current = loaded?.key === key ? loaded : null;

  useEffect(() => {
    if (!endpoint) return;
    const abort = new AbortController();
    void fetch(`${endpoint}/slack`, { signal: abort.signal })
      .then((response) => readConnectorResponse(response, slackConnectorSetupSchema))
      .then((data) => {
        if (abort.signal.aborted) return;
        setLoaded({ key, data });
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setLoaded({ key, data: null });
      });
    return () => abort.abort();
  }, [endpoint, key]);
  return {
    setup: current?.data ?? null,
    loadFailed: current?.data === null,
    refresh: () => setReload((value) => value + 1),
  };
}

export function SlackConnectorAccess({
  canManage = false,
  endpoint,
  installationId,
  result,
  setupState,
}: {
  canManage?: boolean;
  endpoint: string;
  installationId?: string;
  result: string | null;
  setupState?: ReturnType<typeof useSlackConnectorSetup>;
}) {
  const localSetup = useSlackConnectorSetup(setupState ? null : endpoint);
  const { setup, loadFailed, refresh } = setupState ?? localSetup;
  const [selectedId, setSelectedId] = useState("");
  const [workspaceInput, setWorkspaceInput] = useState("");
  const [message, setMessage] = useState<FlashMessage | null>(() => oauthReturnMessage(result));
  const [revocation, setRevocation] = useState<RevokeCommand | null>(null);
  const workspaceInputHelpId = useId();
  const accessHeading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef<HTMLElement>(null);
  const slackEndpoint = `${endpoint}/slack`;

  const action = useApiAction<unknown, [SlackCommand], true>({
    call: (command) =>
      fetch(slackEndpoint, connectorCommand(slackConnectorSetupCommandSchema.parse(command))),
    errorText: "Could not update Slack access.",
    onSuccess: (payload, [command]) => {
      const response = slackConnectorSetupResultSchema.parse(payload);
      if (command.action === "revoke" && "revoked" in response) {
        refresh();
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
  const teamId = readSlackWorkspaceTarget(workspaceInput);
  const installTarget = installations.find((item) => item.teamId === teamId);
  const link = installation?.linkedActor;
  const canLink = setup?.configured && installation?.status === "connected";

  function authorizeTeam(teamId: string, expectedGeneration: number) {
    setMessage(null);
    void action.run({ action: "install", teamId, expectedGeneration });
  }

  function startInstallation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (teamId) authorizeTeam(teamId, installTarget?.generation ?? 0);
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
          <button className="ui-button" onClick={refresh} type="button">
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
                setWorkspaceInput("");
                setMessage(null);
              }}
              value={installation?.id ?? ""}
            >
              {installations.map((item) => (
                <option key={item.id} value={item.id}>
                  {slackWorkspaceOption(item)}
                </option>
              ))}
            </ConnectorSelect>
          ) : null}
          {installation ? (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm text-muted">
                <strong className="font-medium text-foreground">
                  {slackWorkspaceName(installation)}
                </strong>
                {installation.teamDomain ? ` · ${installation.teamDomain}` : null}
              </p>
              <ResourceIdDetails ids={[installation.teamId]} label="Slack workspace ID" />
              {link ? (
                <>
                  <p className="text-sm text-muted">
                    {link.displayName ? `Linked as ${link.displayName}` : "Slack account linked"}
                  </p>
                  <ResourceIdDetails ids={[link.userId]} label="Slack account ID" />
                </>
              ) : null}
              {installation.status === "disconnected" ? (
                <p className="text-sm text-muted">Slack workspace disconnected.</p>
              ) : installation.status === "credential_unavailable" ? (
                <p className="text-sm text-muted">Slack workspace access unavailable.</p>
              ) : null}
              {setup.configured && setup.canConfigure ? (
                <button
                  className="ui-button"
                  disabled={action.isBusy}
                  onClick={() => authorizeTeam(installation.teamId, installation.generation)}
                  type="button"
                >
                  Reconnect Slack
                </button>
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
              <label className="block max-w-xl space-y-1.5 text-sm font-medium text-foreground">
                <span className="block">Slack workspace URL or ID</span>
                <input
                  aria-describedby={workspaceInputHelpId}
                  autoComplete="off"
                  className="ui-input"
                  disabled={action.isBusy}
                  maxLength={512}
                  onChange={(event) => setWorkspaceInput(event.target.value)}
                  placeholder="https://app.slack.com/client/T0123456789"
                  required
                  spellCheck={false}
                  value={workspaceInput}
                />
              </label>
              <p className="text-xs text-muted" id={workspaceInputHelpId}>
                Paste a Slack web app link with /client/ in the address, or enter the workspace ID
                that follows it.
              </p>
              {teamId ? (
                <p className="text-xs text-muted" role="status">
                  {installTarget
                    ? `Selected workspace: ${slackWorkspaceName(installTarget)}.`
                    : `Slack will confirm the name for workspace ${teamId}.`}
                </p>
              ) : workspaceInput.trim() ? (
                <p className="text-xs text-danger">
                  Use an app.slack.com/client address or a workspace ID starting with T.
                </p>
              ) : null}
              <button
                className="ui-button-primary"
                disabled={!teamId || action.isBusy}
                type="submit"
              >
                {installTarget ? "Continue to reconnect in Slack" : "Connect Slack"}
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
