"use client";

import { CodeIcon, ProjectsIcon, SparkIcon } from "@/components/shared/icons";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";

type EditableProfile = RepositoryProfileState;
type ProfileHintKind = "framework" | "language" | "package";

const profileHintLabel: Record<ProfileHintKind, string> = {
  framework: "Framework",
  language: "Language",
  package: "Package manager",
};

const profileHintIconMap: Record<
  ProfileHintKind,
  Record<string, { bg: string; fg: string; text: string }>
> = {
  framework: {
    angular: { bg: "#dd0031", fg: "#ffffff", text: "A" },
    astro: { bg: "#2f2148", fg: "#ffffff", text: "A" },
    django: { bg: "#092e20", fg: "#ffffff", text: "Dj" },
    express: { bg: "#24292f", fg: "#ffffff", text: "Ex" },
    flask: { bg: "#24292f", fg: "#ffffff", text: "Fl" },
    nest: { bg: "#e0234e", fg: "#ffffff", text: "Ns" },
    nestjs: { bg: "#e0234e", fg: "#ffffff", text: "Ns" },
    next: { bg: "#111111", fg: "#ffffff", text: "N" },
    nextjs: { bg: "#111111", fg: "#ffffff", text: "N" },
    playwright: { bg: "#2ead33", fg: "#ffffff", text: "Pw" },
    rails: { bg: "#cc0000", fg: "#ffffff", text: "Rl" },
    react: { bg: "#149eca", fg: "#ffffff", text: "R" },
    remix: { bg: "#111111", fg: "#ffffff", text: "Rx" },
    svelte: { bg: "#ff3e00", fg: "#ffffff", text: "S" },
    supabase: { bg: "#3ecf8e", fg: "#0b3727", text: "S" },
    tailwind: { bg: "#38bdf8", fg: "#082f49", text: "Tw" },
    tailwindcss: { bg: "#38bdf8", fg: "#082f49", text: "Tw" },
    turbo: { bg: "#ef4444", fg: "#ffffff", text: "T" },
    turborepo: { bg: "#ef4444", fg: "#ffffff", text: "T" },
    vite: { bg: "#646cff", fg: "#ffffff", text: "V" },
    vue: { bg: "#42b883", fg: "#0f2f24", text: "V" },
  },
  language: {
    bash: { bg: "#4eaa25", fg: "#ffffff", text: "sh" },
    c: { bg: "#555555", fg: "#ffffff", text: "C" },
    cpp: { bg: "#00599c", fg: "#ffffff", text: "C++" },
    csharp: { bg: "#68217a", fg: "#ffffff", text: "C#" },
    css: { bg: "#1572b6", fg: "#ffffff", text: "CSS" },
    dart: { bg: "#0175c2", fg: "#ffffff", text: "Da" },
    go: { bg: "#00add8", fg: "#06262f", text: "Go" },
    golang: { bg: "#00add8", fg: "#06262f", text: "Go" },
    html: { bg: "#e34f26", fg: "#ffffff", text: "HT" },
    java: { bg: "#e76f00", fg: "#ffffff", text: "Ja" },
    javascript: { bg: "#f7df1e", fg: "#1d1f22", text: "JS" },
    js: { bg: "#f7df1e", fg: "#1d1f22", text: "JS" },
    kotlin: { bg: "#7f52ff", fg: "#ffffff", text: "Kt" },
    php: { bg: "#777bb4", fg: "#ffffff", text: "PHP" },
    python: { bg: "#3776ab", fg: "#ffffff", text: "Py" },
    ruby: { bg: "#cc342d", fg: "#ffffff", text: "Rb" },
    rust: { bg: "#b7410e", fg: "#ffffff", text: "Rs" },
    shell: { bg: "#4eaa25", fg: "#ffffff", text: "sh" },
    swift: { bg: "#f05138", fg: "#ffffff", text: "Sw" },
    ts: { bg: "#3178c6", fg: "#ffffff", text: "TS" },
    typescript: { bg: "#3178c6", fg: "#ffffff", text: "TS" },
  },
  package: {
    bun: { bg: "#f0dbb4", fg: "#1d1f22", text: "B" },
    cargo: { bg: "#b7410e", fg: "#ffffff", text: "Cg" },
    go: { bg: "#00add8", fg: "#06262f", text: "Go" },
    npm: { bg: "#cb3837", fg: "#ffffff", text: "npm" },
    pip: { bg: "#3776ab", fg: "#ffffff", text: "pip" },
    pnpm: { bg: "#f9ad00", fg: "#1d1f22", text: "pn" },
    poetry: { bg: "#60a5fa", fg: "#082f49", text: "Po" },
    uv: { bg: "#111827", fg: "#ffffff", text: "uv" },
    yarn: { bg: "#2c8ebb", fg: "#ffffff", text: "Y" },
  },
};

function normalizeProfileHint(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.js$/u, "js")
    .replace(/[^a-z0-9+#]+/gu, "");
}

function ProfileHintIcon({ kind, value }: { kind: ProfileHintKind; value: string }) {
  const icon = profileHintIconMap[kind][normalizeProfileHint(value)];

  if (icon) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[4px] px-1 text-[8px] font-bold leading-none"
        style={{ backgroundColor: icon.bg, color: icon.fg }}
      >
        {icon.text}
      </span>
    );
  }

  const className = "h-3.5 w-3.5 text-muted";
  if (kind === "package") return <ProjectsIcon className={className} />;
  if (kind === "framework") return <SparkIcon className={className} />;
  return <CodeIcon className={className} />;
}

function ProfileHintPill({ kind, value }: { kind: ProfileHintKind; value: string }) {
  const label = `${profileHintLabel[kind]}: ${value}`;

  return (
    <span aria-label={label} className="ui-pill gap-1.5" title={label}>
      <ProfileHintIcon kind={kind} value={value} />
      {value}
    </span>
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
      <span className="text-[12px] font-medium text-muted">{label}</span>
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
    <div className="rounded-[6px] border border-border bg-surface p-4">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-foreground">Repository profile</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {profile.packageManager ? (
              <ProfileHintPill kind="package" value={profile.packageManager} />
            ) : null}
            {profile.languageHints.map((hint) => (
              <ProfileHintPill kind="language" key={hint} value={hint} />
            ))}
            {profile.frameworkHints.map((hint) => (
              <ProfileHintPill kind="framework" key={hint} value={hint} />
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            className="ui-button"
            disabled={!canManage || actionsDisabled}
            onClick={onInfer}
            type="button"
          >
            {isAnalyzing ? "Analyzing..." : reanalyzeLabel}
          </button>
          <button
            className="ui-button-primary"
            disabled={!canManage || actionsDisabled}
            onClick={onSave}
            type="button"
          >
            {isSaving ? "Saving..." : "Save profile"}
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
          <span className="text-[12px] font-medium text-muted">Language hints</span>
          <textarea
            className="ui-textarea min-h-24 w-full"
            onChange={(event) => update("languageHints", splitList(event.target.value))}
            value={joinList(profile.languageHints)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Framework hints</span>
          <textarea
            className="ui-textarea min-h-24 w-full"
            onChange={(event) => update("frameworkHints", splitList(event.target.value))}
            value={joinList(profile.frameworkHints)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Env key suggestions</span>
          <textarea
            className="ui-textarea min-h-28 w-full font-mono text-[12px]"
            onChange={(event) => update("envKeySuggestions", splitList(event.target.value))}
            value={joinList(profile.envKeySuggestions)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Setup notes</span>
          <textarea
            className="ui-textarea min-h-28 w-full"
            onChange={(event) => update("setupNotes", event.target.value)}
            value={profile.setupNotes}
          />
        </label>
      </div>

      <div className="mt-4">
        <p className="text-[12px] font-medium text-muted">Source files</p>
        {profile.inferenceSources.length === 0 ? (
          <p className="mt-1 text-[12px] leading-5 text-muted">No source files matched.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {profile.inferenceSources.map((source) => (
              <span className="ui-pill font-mono" key={source.path}>
                {source.path}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
