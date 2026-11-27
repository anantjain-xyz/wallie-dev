export const SETTINGS_CATEGORIES = ["integrations", "workspace", "advanced"] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = "integrations";

export const SETTINGS_CATEGORY_LINKS: ReadonlyArray<{
  description: string;
  id: SettingsCategory;
  label: string;
}> = [
  {
    description: "Connections, factory configuration, and setup checks",
    id: "integrations",
    label: "Integrations",
  },
  {
    description: "Workspace identity, team access, and personal settings",
    id: "workspace",
    label: "Workspace",
  },
  {
    description: "Usage, retention, maintenance, and API limits",
    id: "advanced",
    label: "Advanced",
  },
];

export function parseSettingsCategory(value: string | string[] | undefined): SettingsCategory {
  const candidate = Array.isArray(value) ? value[0] : value;
  return SETTINGS_CATEGORIES.includes(candidate as SettingsCategory)
    ? (candidate as SettingsCategory)
    : DEFAULT_SETTINGS_CATEGORY;
}
