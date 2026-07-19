import { redirect } from "next/navigation";

import {
  DEFAULT_SETTINGS_CATEGORY,
  parseSettingsCategory,
} from "@/features/settings/settings-categories";
import { workspaceSettingsCategoryPath } from "@/lib/routes";

type SettingsIndexPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<{
    category?: string | string[];
    codex_connect?: string;
    github?: string;
  }>;
};

function resolveRedirectCategory(searchParams: {
  category?: string | string[];
  codex_connect?: string;
  github?: string;
}) {
  if (searchParams.category !== undefined) {
    return parseSettingsCategory(searchParams.category);
  }
  if (searchParams.github) {
    return "integrations" as const;
  }
  if (searchParams.codex_connect) {
    return "agent-execution" as const;
  }
  return DEFAULT_SETTINGS_CATEGORY;
}

export default async function SettingsIndexPage({ params, searchParams }: SettingsIndexPageProps) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const category = resolveRedirectCategory(resolvedSearchParams);

  redirect(
    workspaceSettingsCategoryPath(workspaceSlug, category, {
      codex_connect: resolvedSearchParams.codex_connect,
      github: resolvedSearchParams.github,
    }),
  );
}
