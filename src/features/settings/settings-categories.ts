export const SETTINGS_CATEGORIES = ["integrations", "workspace", "advanced"] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = "integrations";

export const SETTINGS_CATEGORY_LINKS: ReadonlyArray<{
  description: string;
  id: SettingsCategory;
  label: string;
}> = [
  {
    description: "GitHub, repositories, pipeline, Linear, sandbox, agents, and setup health",
    id: "integrations",
    label: "Integrations",
  },
  {
    description: "Identity, members, invitations, and deletion",
    id: "workspace",
    label: "Workspace",
  },
  {
    description: "Usage, Maintenence, and Rate Limits",
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
