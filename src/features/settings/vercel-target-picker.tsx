"use client";

import { useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField } from "@/components/ui/select";
import type {
  VercelProjectOption,
  VercelSandboxConnectionPreview,
  VercelSandboxCredentials,
  VercelTeamOption,
} from "@/lib/vercel-sandbox/contracts";

type Props = {
  connection: VercelSandboxConnectionPreview | null;
  disabled: boolean;
  isSaving: boolean;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (credentials: VercelSandboxCredentials) => void;
  workspaceId: string;
};

export function VercelTargetPicker({
  connection,
  disabled,
  isSaving,
  onCancel,
  onDirtyChange,
  onSave,
  workspaceId,
}: Props) {
  const [token, setToken] = useState("");
  const [teams, setTeams] = useState<VercelTeamOption[] | null>(null);
  const [projects, setProjects] = useState<VercelProjectOption[] | null>(null);
  const [teamId, setTeamId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [manual, setManual] = useState(false);
  const [manualTeamId, setManualTeamId] = useState(connection?.teamId ?? "");
  const [manualProjectId, setManualProjectId] = useState(connection?.projectId ?? "");
  const [savedUnavailable, setSavedUnavailable] = useState(false);
  const [pending, setPending] = useState<"teams" | "projects" | null>(null);
  const [error, setError] = useState<{ message: string; scope: "teams" | "projects" } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const team = teams?.find((item) => item.id === teamId);
  const dirty =
    token.length > 0 ||
    manualTeamId !== (connection?.teamId ?? "") ||
    manualProjectId !== (connection?.projectId ?? "");

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => requestRef.current?.abort(), []);

  function resetLookup() {
    requestRef.current?.abort();
    setPending(null);
    setError(null);
    setSavedUnavailable(false);
    setTeams(null);
    setProjects(null);
    setTeamId("");
    setProjectId("");
  }

  async function lookup<T>(
    scope: "teams" | "projects",
    nextTeamId: string | undefined,
    onResult: (items: T[]) => void,
  ) {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(scope);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/sandbox-connections/vercel/targets`,
        {
          body: JSON.stringify({ token: token.trim(), teamId: nextTeamId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        },
      );
      const body = (await response.json()) as { error?: string } & Partial<
        Record<"teams" | "projects", T[]>
      >;
      if (controller.signal.aborted) return;
      const items = body[scope];
      if (!response.ok || !Array.isArray(items)) {
        setError({
          message: body.error ?? "Couldn’t load Vercel targets. Retry or enter IDs manually.",
          scope,
        });
        return;
      }
      onResult(items);
    } catch {
      if (!controller.signal.aborted) {
        setError({ message: "Couldn’t load Vercel targets. Retry or enter IDs manually.", scope });
      }
    } finally {
      if (!controller.signal.aborted) setPending(null);
    }
  }

  function chooseTeam(nextTeamId: string, keepSavedProject: boolean) {
    setTeamId(nextTeamId);
    setProjectId("");
    setProjects(null);
    setSavedUnavailable(false);
    if (!nextTeamId) {
      requestRef.current?.abort();
      setPending(null);
      setError(null);
      return;
    }
    void lookup<VercelProjectOption>("projects", nextTeamId, (items) => {
      setProjects(items);
      if (keepSavedProject && connection) {
        const saved = items.find((item) => item.id === connection.projectId);
        setProjectId(saved?.id ?? "");
        setSavedUnavailable(!saved);
      } else if (items.length === 1) {
        setProjectId(items[0]!.id);
      }
    });
  }

  function findTeams() {
    resetLookup();
    void lookup<VercelTeamOption>("teams", undefined, (items) => {
      setTeams(items);
      const match = items.find((item) => item.id === connection?.teamId);
      if (match) chooseTeam(match.id, true);
      else if (connection) setSavedUnavailable(true);
      else if (items.length === 1) chooseTeam(items[0]!.id, false);
    });
  }

  const target = manual
    ? { teamId: manualTeamId.trim(), projectId: manualProjectId.trim() }
    : { teamId, projectId };
  const canSave = Boolean(token.trim() && target.teamId && target.projectId);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave || disabled || pending) return;
        requestRef.current?.abort();
        onSave({ ...target, token: token.trim() });
      }}
    >
      <h3 className="text-[13px] font-semibold text-foreground">Connect Vercel Sandbox</h3>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-foreground">Token</span>
        <input
          autoComplete="off"
          className="ui-input"
          disabled={disabled}
          maxLength={4000}
          name="vercel-token"
          onChange={(event) => {
            setToken(event.target.value);
            resetLookup();
          }}
          spellCheck={false}
          type="password"
          value={token}
        />
      </label>

      {manual ? (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted">
            Some tokens can access a project without listing teams or projects. In Vercel, copy the{" "}
            <a
              className="underline underline-offset-2"
              href="https://vercel.com/docs/accounts#find-your-team-id"
            >
              Team ID from Team Settings → General
            </a>{" "}
            and the{" "}
            <a
              className="underline underline-offset-2"
              href="https://vercel.com/docs/project-configuration/general-settings#project-id"
            >
              Project ID from Project Settings → General
            </a>
            . Wallie still checks that the token can access the project and list its sandboxes
            before saving.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TargetIdInput
              disabled={disabled}
              label="Team ID"
              onChange={setManualTeamId}
              value={manualTeamId}
            />
            <TargetIdInput
              disabled={disabled}
              label="Project ID"
              onChange={setManualProjectId}
              value={manualProjectId}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            className="ui-button"
            disabled={disabled || !token.trim() || pending !== null}
            onClick={findTeams}
            type="button"
          >
            Find teams
          </button>
          {teams?.length ? (
            <SelectField
              disabled={disabled}
              emptyOption={{ label: "Choose a team", value: "" }}
              label="Team"
              labelClassName="text-xs"
              name="vercel-team"
              onValueChange={(nextTeamId) => {
                if (nextTeamId !== teamId)
                  chooseTeam(nextTeamId, nextTeamId === connection?.teamId);
              }}
              options={teams.map((item) => ({
                label: item.name === item.slug ? item.slug : `${item.name} · ${item.slug}`,
                value: item.id,
              }))}
              value={teamId}
              wrap
            />
          ) : null}
          {team && projects?.length ? (
            <SelectField
              disabled={disabled}
              emptyOption={{ label: "Choose a project", value: "" }}
              label="Project"
              labelClassName="text-xs"
              name="vercel-project"
              onValueChange={(nextProjectId) => {
                setProjectId(nextProjectId);
                if (nextProjectId) setSavedUnavailable(false);
              }}
              options={projects.map((item) => ({
                label: `${item.name} · ${team.slug}`,
                value: item.id,
              }))}
              value={projectId}
              wrap
            />
          ) : null}
          {pending ? (
            <p className="text-xs text-muted" role="status">
              Loading {pending}…
            </p>
          ) : null}
          {error ? (
            <div className="space-y-2">
              <p className="text-xs text-danger" role="alert">
                {error.message}
              </p>
              {error.scope === "projects" && team ? (
                <button
                  className="ui-button"
                  disabled={disabled}
                  onClick={() => chooseTeam(team.id, team.id === connection?.teamId)}
                  type="button"
                >
                  Retry projects
                </button>
              ) : null}
            </div>
          ) : null}
          {teams?.length === 0 || projects?.length === 0 ? (
            <p className="text-xs text-muted" role="status">
              {teams?.length === 0
                ? "No teams found for this token."
                : "No projects found in this team."}{" "}
              Check access or enter IDs manually.
            </p>
          ) : null}
          {savedUnavailable ? (
            <p className="text-xs text-warning" role="status">
              Saved project unavailable. Your current connection hasn’t changed. Choose a
              replacement or enter IDs manually.
            </p>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          aria-expanded={manual}
          className="ui-button"
          disabled={disabled}
          onClick={() => {
            resetLookup();
            setManual(!manual);
          }}
          type="button"
        >
          {manual ? "Choose by name" : "Enter IDs manually"}
        </button>
        <button
          className="ui-button-primary"
          disabled={disabled || pending !== null || !canSave}
          type="submit"
        >
          <ActionButtonLabel idle="Save connection" pending={isSaving} pendingLabel="Saving…" />
        </button>
        {onCancel ? (
          <button className="ui-button" disabled={disabled} onClick={onCancel} type="button">
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function TargetIdInput({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <input
        autoComplete="off"
        className="ui-input"
        disabled={disabled}
        maxLength={128}
        name={label === "Team ID" ? "vercel-team-id" : "vercel-project-id"}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        value={value}
      />
    </label>
  );
}
