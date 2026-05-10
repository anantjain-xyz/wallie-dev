"use client";

import { useState } from "react";

import type { SlackDisconnectResponse, SlackInstallResponse } from "@/features/slack/contracts";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { ConfigState, dateFormatter, Section } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";

type SlackInstallSectionProps = {
  canManage: boolean;
  setFlashMessage: (message: FlashMessage) => void;
  slack: SettingsPageData["slack"];
  workspaceId: string;
};

export function SlackInstallSection({
  canManage,
  setFlashMessage,
  slack,
  workspaceId,
}: SlackInstallSectionProps) {
  const [slackInstallation, setSlackInstallation] = useState(slack.installation);
  const hasSlackAppConfig = slack.missingAppKeys.length === 0;

  const launchInstall = useApiAction<SlackInstallResponse>({
    call: () =>
      fetch(`/api/slack/install?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "GET",
      }),
    errorText: "Slack install preparation failed.",
    onSuccess: (payload) => {
      window.location.assign(payload.installUrl);
    },
    setFlashMessage,
    successText: null,
  });

  const disconnectSlack = useApiAction<SlackDisconnectResponse, [string]>({
    call: (installationId) =>
      fetch(
        `/api/slack/installations/${encodeURIComponent(installationId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "DELETE",
        },
      ),
    errorText: "Slack disconnect failed.",
    onSuccess: () => {
      setSlackInstallation(null);
    },
    setFlashMessage,
    successText: "Slack workspace disconnected.",
  });

  function handleSlackDisconnect() {
    if (!slackInstallation) {
      return;
    }

    if (!window.confirm("Disconnect this Slack workspace from Wallie?")) {
      return;
    }

    void disconnectSlack.run(slackInstallation.id);
  }

  return (
    <Section title="Slack">
      <div className="space-y-4">
        <ConfigState missingKeys={slack.missingAppKeys} title="Slack install flow disabled" />

        {slackInstallation ? (
          <div className="ui-subpanel space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  Connected to{" "}
                  <span className="font-mono">
                    {slackInstallation.teamName ?? slackInstallation.teamId}
                  </span>
                </p>
                <p className="text-sm text-muted">
                  Installed {dateFormatter.format(new Date(slackInstallation.installedAt))} · Team
                  ID <span className="font-mono">{slackInstallation.teamId}</span>
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  className="ui-button"
                  disabled={!canManage || !hasSlackAppConfig || launchInstall.isBusy}
                  onClick={() => void launchInstall.run()}
                  type="button"
                >
                  {launchInstall.isBusy ? "Preparing…" : "Reinstall"}
                </button>
                <button
                  className="ui-button-danger"
                  disabled={!canManage || disconnectSlack.isBusy}
                  onClick={handleSlackDisconnect}
                  type="button"
                >
                  {disconnectSlack.isBusy ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="ui-subpanel space-y-4 p-4">
            <div className="space-y-2">
              <p className="text-sm leading-7 text-foreground">
                Connect Slack so the Wallie product agent can pick up @mentions on Linear issues,
                draft a spec, and post it back for PM review.
              </p>
              <p className="text-xs leading-6 text-muted">
                Workspace admins only. Wallie requests{" "}
                <span className="font-mono">app_mentions:read</span>,{" "}
                <span className="font-mono">chat:write</span>, and{" "}
                <span className="font-mono">chat:write.public</span> so it can reply in threads
                where it&apos;s mentioned.
              </p>
            </div>
            <button
              className="ui-button-primary"
              disabled={!canManage || !hasSlackAppConfig || launchInstall.isBusy}
              onClick={() => void launchInstall.run()}
              type="button"
            >
              {launchInstall.isBusy ? "Preparing Install…" : "Install Slack App"}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}
