export const SETTINGS_CATEGORIES = [
  "general",
  "integrations",
  "agent-execution",
  "pipeline",
  "members",
  "advanced",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = "general";

export const SETTINGS_CATEGORY_LINKS: ReadonlyArray<{
  description: string;
  documentTitle: string;
  id: SettingsCategory;
  label: string;
  purpose: string;
}> = [
  {
    description: "Workspace name, avatar, and identity",
    documentTitle: "General",
    id: "general",
    label: "General",
    purpose: "Update workspace identity and how Wallie labels this workspace.",
  },
  {
    description: "GitHub, repositories, Vercel, and Linear",
    documentTitle: "Integrations",
    id: "integrations",
    label: "Integrations",
    purpose: "Connect GitHub, repositories, Vercel Sandbox, and Linear.",
  },
  {
    description: "Provider, models, concurrency, and secrets",
    documentTitle: "Agent execution",
    id: "agent-execution",
    label: "Agent execution",
    purpose: "Configure coding-agent access, runtime settings, and workspace secrets.",
  },
  {
    description: "Stages, prompts, and approvers",
    documentTitle: "Pipeline",
    id: "pipeline",
    label: "Pipeline",
    purpose: "Edit the ordered stages Wallie runs for each session.",
  },
  {
    description: "Members, roles, and invitations",
    documentTitle: "Members",
    id: "members",
    label: "Members",
    purpose: "Invite people, change roles, and manage pending invitations.",
  },
  {
    description: "Setup health, usage, rate limits, and danger zone",
    documentTitle: "Advanced",
    id: "advanced",
    label: "Advanced",
    purpose: "Verify setup, review usage and rate limits, or leave or delete the workspace.",
  },
];

const LEGACY_QUERY_CATEGORIES: Record<string, SettingsCategory> = {
  advanced: "advanced",
  "agent-execution": "agent-execution",
  general: "general",
  integrations: "integrations",
  members: "members",
  pipeline: "pipeline",
  workspace: "general",
};

export function isSettingsCategory(value: string | undefined | null): value is SettingsCategory {
  return SETTINGS_CATEGORIES.includes(value as SettingsCategory);
}

export function parseSettingsCategory(value: string | string[] | undefined): SettingsCategory {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (isSettingsCategory(candidate)) {
    return candidate;
  }
  if (candidate && LEGACY_QUERY_CATEGORIES[candidate]) {
    return LEGACY_QUERY_CATEGORIES[candidate];
  }
  return DEFAULT_SETTINGS_CATEGORY;
}

export function settingsCategoryMeta(category: SettingsCategory) {
  const meta = SETTINGS_CATEGORY_LINKS.find((entry) => entry.id === category);
  if (!meta) {
    throw new Error(`Unknown settings category: ${category}`);
  }
  return meta;
}
