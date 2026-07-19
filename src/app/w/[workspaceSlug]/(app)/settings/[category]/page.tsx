import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadSettingsPageData } from "@/features/settings/data";
import {
  isSettingsCategory,
  settingsCategoryMeta,
  type SettingsCategory,
} from "@/features/settings/settings-categories";
import { SettingsServerShell } from "@/features/settings/settings-server-shell";

type SettingsCategoryPageProps = {
  params: Promise<{
    category: string;
    workspaceSlug: string;
  }>;
  searchParams: Promise<{
    codex_connect?: string;
    github?: string;
  }>;
};

export async function generateMetadata({
  params,
}: Pick<SettingsCategoryPageProps, "params">): Promise<Metadata> {
  const { category: rawCategory } = await params;
  if (!isSettingsCategory(rawCategory)) {
    return { title: "Settings" };
  }
  return { title: settingsCategoryMeta(rawCategory).documentTitle };
}

export default async function SettingsCategoryPage({
  params,
  searchParams,
}: SettingsCategoryPageProps) {
  const { category: rawCategory, workspaceSlug } = await params;
  if (!isSettingsCategory(rawCategory)) {
    notFound();
  }
  const category = rawCategory as SettingsCategory;
  const resolvedSearchParams = await searchParams;
  const data = await loadSettingsPageData(workspaceSlug, category);
  const initialData = await data.initialData;

  return (
    <SettingsServerShell
      category={category}
      initialData={initialData}
      searchState={{
        codexStatus: resolvedSearchParams.codex_connect ?? null,
        githubStatus: resolvedSearchParams.github ?? null,
      }}
      setupData={data.setupData}
      usage={data.usage}
      workspaceInvitations={data.workspaceInvitations}
    />
  );
}
