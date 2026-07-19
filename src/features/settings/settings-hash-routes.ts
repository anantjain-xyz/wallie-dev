import { isSettingsCategory, type SettingsCategory } from "@/features/settings/settings-categories";

export type SettingsHashRoute = {
  anchor: string;
  category: SettingsCategory;
};

const HASH_ROUTES: Record<string, SettingsHashRoute> = {
  "cloud-execution": { anchor: "verify", category: "advanced" },
  "coding-agent": { anchor: "runtime", category: "agent-execution" },
  "danger-zone": { anchor: "danger-zone", category: "advanced" },
  github: { anchor: "github", category: "integrations" },
  linear: { anchor: "linear", category: "integrations" },
  "linear-routing": { anchor: "linear", category: "integrations" },
  members: { anchor: "members", category: "members" },
  pipeline: { anchor: "pipeline", category: "pipeline" },
  "rate-limits": { anchor: "rate-limits", category: "advanced" },
  repository: { anchor: "repository", category: "integrations" },
  runtime: { anchor: "runtime", category: "agent-execution" },
  secrets: { anchor: "runtime", category: "agent-execution" },
  usage: { anchor: "usage", category: "advanced" },
  vercel: { anchor: "vercel", category: "integrations" },
  verify: { anchor: "verify", category: "advanced" },
  workspace: { anchor: "workspace", category: "general" },
};

export function resolveSettingsHashRoute(hash: string): SettingsHashRoute | null {
  const anchorId = hash.replace(/^#/u, "");
  return HASH_ROUTES[anchorId] ?? null;
}

export function settingsCategoryFromPathname(pathname: string): SettingsCategory | null {
  const match = /\/settings\/([^/]+)/u.exec(pathname);
  if (!match?.[1]) return null;
  return isSettingsCategory(match[1]) ? match[1] : null;
}
