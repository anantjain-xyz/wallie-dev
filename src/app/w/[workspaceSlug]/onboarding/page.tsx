import { notFound, redirect } from "next/navigation";

import { loadWorkspaceOnboardingDataForContext } from "@/features/onboarding/data";
import { OnboardingPageClient } from "@/features/onboarding/onboarding-page-client";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { loginPath } from "@/lib/routes";

type WorkspaceOnboardingPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceOnboardingPage({ params }: WorkspaceOnboardingPageProps) {
  const { workspaceSlug } = await params;
  const authenticatedContext = await loadAuthenticatedWorkspaceContext(workspaceSlug);
  const result = await loadWorkspaceOnboardingDataForContext(authenticatedContext);

  if (!result.ok) {
    if (result.status === 401) {
      redirect(loginPath(`/w/${workspaceSlug}/onboarding`));
    }

    notFound();
  }

  return <OnboardingPageClient initialData={result.data} />;
}
