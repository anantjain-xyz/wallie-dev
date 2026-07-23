export const SETTINGS_CATEGORIES = ["integrations", "advanced", "workspace"] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = "integrations";

export const SETTINGS_CATEGORY_LINKS: ReadonlyArray<{
  description: string;
  id: SettingsCategory;
  label: string;
}> = [
  {
    description: "GitHub, repositories, pipeline, sandbox, Linear, and agent access",
    id: "integrations",
    label: "Integrations",
  },
  {
    description: "Setup health, usage, and rate limits",
    id: "advanced",
    label: "Advanced",
  },
  {
    description: "Identity, members, invitations, and deletion",
    id: "workspace",
    label: "Workspace",
  },
];

export function parseSettingsCategory(value: string | string[] | undefined): SettingsCategory {
  const candidate = Array.isArray(value) ? value[0] : value;
  return SETTINGS_CATEGORIES.includes(candidate as SettingsCategory)
    ? (candidate as SettingsCategory)
    : DEFAULT_SETTINGS_CATEGORY;
}
