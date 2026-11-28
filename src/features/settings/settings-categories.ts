export const SETTINGS_CATEGORIES = ["integrations", "workspace", "advanced", "personal"] as const;
export const FACTORY_ROW_ANCHOR_PREFIX = "factory-row-";

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = "integrations";

export const SETTINGS_CATEGORY_LINKS: ReadonlyArray<{
  id: SettingsCategory;
  label: string;
}> = [
  { id: "integrations", label: "Integrations" },
  { id: "workspace", label: "Workspace" },
  { id: "advanced", label: "Usage & retention" },
  { id: "personal", label: "Personal" },
];

export function parseSettingsCategory(value: string | string[] | undefined): SettingsCategory {
  const candidate = Array.isArray(value) ? value[0] : value;
  return SETTINGS_CATEGORIES.includes(candidate as SettingsCategory)
    ? (candidate as SettingsCategory)
    : DEFAULT_SETTINGS_CATEGORY;
}
