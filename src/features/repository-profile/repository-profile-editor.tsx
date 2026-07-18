"use client";

import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";

type EditableProfile = RepositoryProfileState;
type ProfileHintKind = "framework" | "language" | "package";

const profileHintLabel: Record<ProfileHintKind, string> = {
  framework: "Framework",
  language: "Language",
  package: "Package manager",
};

function ProfileHint({ kind, value }: { kind: ProfileHintKind; value: string }) {
  const label = `${profileHintLabel[kind]}: ${value}`;

  return (
    <MetadataItem
      aria-label={label}
      className="flex gap-1 border-0 py-0"
      label={profileHintLabel[kind]}
      value={value}
    />
  );
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function joinList(value: readonly string[]) {
  return value.join("\n");
}

function ProfileField({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        className="ui-input w-full"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

export function RepositoryProfileEditor({
  canManage,
  isAnalyzing,
  isSaving,
  onChange,
  onInfer,
  onSave,
  profile,
  reanalyzeLabel = "Re-analyze",
}: {
  canManage: boolean;
  isAnalyzing: boolean;
  isSaving: boolean;
  onChange: (profile: EditableProfile, dirty?: boolean) => void;
  onInfer: () => void;
  onSave: () => void;
  profile: EditableProfile;
  reanalyzeLabel?: string;
}) {
  const actionsDisabled = isAnalyzing || isSaving;

  function update<K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) {
    onChange({ ...profile, [key]: value, inferenceConfidence: "manual" }, true);
  }

  return (
    <div className="rounded-[6px] border border-border bg-sheet p-4">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-foreground">Repository profile</h3>
          <MetadataList className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 sm:flex">
            {profile.packageManager ? (
              <ProfileHint kind="package" value={profile.packageManager} />
            ) : null}
            {profile.languageHints.map((hint) => (
              <ProfileHint kind="language" key={hint} value={hint} />
            ))}
            {profile.frameworkHints.map((hint) => (
              <ProfileHint kind="framework" key={hint} value={hint} />
            ))}
          </MetadataList>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            className="ui-button"
            disabled={!canManage || actionsDisabled}
            onClick={onInfer}
            type="button"
          >
            {isAnalyzing ? "Analyzing…" : reanalyzeLabel}
          </button>
          <button
            className="ui-button-primary"
            disabled={!canManage || actionsDisabled}
            onClick={onSave}
            type="button"
          >
            {isSaving ? "Saving…" : "Save profile"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProfileField
          label="Package manager"
          onChange={(value) => update("packageManager", value.trim() || null)}
          placeholder="pnpm"
          value={profile.packageManager ?? ""}
        />
        <ProfileField
          label="Install command"
          onChange={(value) => update("installCommand", value.trim() || null)}
          placeholder="pnpm install"
          value={profile.installCommand ?? ""}
        />
        <ProfileField
          label="Build command"
          onChange={(value) => update("buildCommand", value.trim() || null)}
          placeholder="pnpm build"
          value={profile.buildCommand ?? ""}
        />
        <ProfileField
          label="Test command"
          onChange={(value) => update("testCommand", value.trim() || null)}
          placeholder="pnpm test"
          value={profile.testCommand ?? ""}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted">Language hints</span>
          <textarea
            className="ui-textarea min-h-24 w-full"
            onChange={(event) => update("languageHints", splitList(event.target.value))}
            value={joinList(profile.languageHints)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted">Framework hints</span>
          <textarea
            className="ui-textarea min-h-24 w-full"
            onChange={(event) => update("frameworkHints", splitList(event.target.value))}
            value={joinList(profile.frameworkHints)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted">Env key suggestions</span>
          <textarea
            className="ui-textarea min-h-28 w-full font-mono text-xs"
            onChange={(event) => update("envKeySuggestions", splitList(event.target.value))}
            value={joinList(profile.envKeySuggestions)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted">Setup notes</span>
          <textarea
            className="ui-textarea min-h-28 w-full"
            onChange={(event) => update("setupNotes", event.target.value)}
            value={profile.setupNotes}
          />
        </label>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium text-muted">Source files</p>
        {profile.inferenceSources.length === 0 ? (
          <p className="mt-1 text-xs leading-5 text-muted">No source files matched.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border border-y border-border font-mono text-xs text-foreground">
            {profile.inferenceSources.map((source) => (
              <li className="break-all py-1.5" key={source.path}>
                {source.path}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
