"use client";

import { useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Status } from "@/components/ui/status";
import type { SettingsPageData } from "@/features/settings/data";
import {
  publishSettingsFactoryDraft,
  reloadSettingsFactoryDefinition,
  useFactoryDefinitionStore,
} from "@/features/settings/factory-definition-store";
import {
  dispatchSettingsDataChanged,
  dispatchSettingsEvent,
  SETTINGS_PIPELINE_CHANGED,
} from "@/features/settings/settings-island-events";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { canRouteSettingsThroughFactoryDraft } from "@/lib/factory-definitions/settings-contracts";
import {
  projectSettingsDataWithFactoryDefinition,
  shortFactoryDigest,
} from "@/lib/factory-definitions/settings-projection";

export function FactoryDefinitionIsland({ initialData }: { initialData: SettingsPageData }) {
  const workspaceId = initialData.workspace.id;
  const { conflict, dirtySections, state } = useFactoryDefinitionStore(
    workspaceId,
    initialData.factoryDefinition,
  );
  const [busyAction, setBusyAction] = useState<"publish" | "reload" | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);

  if (!state.factoryId) return null;

  const canRoute = canRouteSettingsThroughFactoryDraft(state);
  const hasUnsaved = dirtySections.length > 0;
  const isBusy = busyAction !== null;
  const currentActivation = state.currentActivation;
  const latestDraft = state.latestDraft;

  async function handleReload() {
    if (isBusy) return;
    setBusyAction("reload");
    setMessage(null);
    try {
      const result = await reloadSettingsFactoryDefinition(workspaceId, state);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      if (result.data.pipeline) {
        dispatchSettingsEvent(SETTINGS_PIPELINE_CHANGED, result.data.pipeline);
      }
      dispatchSettingsDataChanged(workspaceId, (current) => ({
        ...projectSettingsDataWithFactoryDefinition(current, result.data.state),
        ...(result.data.pipeline ? { pipeline: result.data.pipeline } : {}),
      }));
      setMessage({ kind: "info", text: "Reloaded the latest factory definition." });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not reload factory definition state.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePublish() {
    if (isBusy || !latestDraft || hasUnsaved || conflict) return;
    setBusyAction("publish");
    setMessage(null);
    try {
      const result = await publishSettingsFactoryDraft(workspaceId, state);
      if (!result.ok) {
        const detail = result.diagnostics?.[0]?.message;
        setMessage({
          kind: "error",
          text: detail && detail !== result.error ? `${result.error} ${detail}` : result.error,
        });
        return;
      }
      if (result.data.pipeline) {
        dispatchSettingsEvent(SETTINGS_PIPELINE_CHANGED, result.data.pipeline);
      }
      dispatchSettingsDataChanged(workspaceId, (current) => ({
        ...projectSettingsDataWithFactoryDefinition(current, result.data.state),
        ...(result.data.pipeline ? { pipeline: result.data.pipeline } : {}),
      }));
      const activationNumber =
        result.data.activation?.activationNumber ??
        result.data.state.currentActivation?.activationNumber;
      setMessage({
        kind: "success",
        text: activationNumber
          ? `Published activation #${activationNumber}. New sessions will use this revision.`
          : "Published factory definition.",
      });
    } catch (error) {
      setMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Could not publish factory definition draft.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  const guidance = !canRoute
    ? "Connect a GitHub repository to save and publish shared factory definition drafts."
    : conflict
      ? "Another change was saved or published. Reload the latest configuration before saving or publishing."
      : hasUnsaved
        ? "Save your edited sections to update the shared draft before publishing."
        : latestDraft
          ? "Your draft includes compiled pipeline, runtime, and policy settings. Publish it so new sessions pin this revision."
          : currentActivation
            ? "New sessions pin the active published revision. Editing pipeline, agent, sandbox, or policy forms saves a shared draft."
            : "Editing pipeline, agent, sandbox, or policy forms saves a shared draft ready to publish.";

  return (
    <section
      aria-labelledby="factory-definition-heading"
      className="ui-sheet space-y-4 p-5"
      id="factory-definition"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              className="text-[15px] font-semibold text-foreground"
              id="factory-definition-heading"
            >
              Factory definition
            </h2>
            {currentActivation ? (
              <Status label={`Published #${currentActivation.activationNumber}`} value="healthy" />
            ) : (
              <Status label="Not published" value="not_started" />
            )}
            {currentActivation ? (
              <code
                className="font-mono text-xs text-muted"
                title={`Published digest ${currentActivation.canonicalDigest}`}
              >
                {shortFactoryDigest(currentActivation.canonicalDigest)}
              </code>
            ) : null}
            {latestDraft ? (
              <>
                <Status label="Draft saved" value="in_progress" />
                <code
                  className="font-mono text-xs text-muted"
                  title={`Draft digest ${latestDraft.canonicalDigest}`}
                >
                  {shortFactoryDigest(latestDraft.canonicalDigest)}
                </code>
              </>
            ) : null}
            {hasUnsaved ? <Status label="Unsaved edits" value="needs_attention" /> : null}
            {conflict ? <Status label="Conflict" value="blocked" /> : null}
          </div>
          <p className="max-w-2xl text-[13px] leading-5 text-muted">{guidance}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            className="ui-button"
            disabled={isBusy}
            onClick={() => void handleReload()}
            type="button"
          >
            <ActionButtonLabel
              idle={conflict ? "Reload latest" : "Reload"}
              pending={busyAction === "reload"}
              pendingLabel="Reloading…"
            />
          </button>
          {initialData.canManage && canRoute ? (
            <button
              className="ui-button-primary"
              disabled={isBusy || !latestDraft || hasUnsaved || Boolean(conflict)}
              onClick={() => void handlePublish()}
              type="button"
            >
              <ActionButtonLabel
                idle="Publish draft"
                pending={busyAction === "publish"}
                pendingLabel="Publishing…"
              />
            </button>
          ) : null}
        </div>
      </div>

      {conflict ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
          role="alert"
        >
          <p>{conflict}</p>
          <button
            className="ui-button shrink-0"
            disabled={isBusy}
            onClick={() => void handleReload()}
            type="button"
          >
            Reload latest
          </button>
        </div>
      ) : null}

      <InlineActionMessage message={message} />
    </section>
  );
}
