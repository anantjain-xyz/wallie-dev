import { notFound, redirect } from "next/navigation";

import { loadWorkspaceOnboardingData } from "@/features/onboarding/data";
import { OnboardingPageClient } from "@/features/onboarding/onboarding-page-client";
import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";
import { loginPath } from "@/lib/routes";

type WorkspaceOnboardingPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceOnboardingPage({ params }: WorkspaceOnboardingPageProps) {
  const { workspaceSlug } = await params;
  const { workspace } = await loadWorkspaceLayoutContext(workspaceSlug);
  const result = await loadWorkspaceOnboardingData(workspace.id);

  if (!result.ok) {
    if (result.status === 401) {
      redirect(loginPath(`/w/${workspaceSlug}/onboarding`));
    }

    notFound();
  }

  return <OnboardingPageClient initialData={result.data} />;
}
