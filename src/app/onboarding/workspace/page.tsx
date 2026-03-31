import { PlaceholderPanel } from "@/components/shared/placeholder-panel";

export default function WorkspaceOnboardingPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-8 sm:px-6 lg:px-8">
      <PlaceholderPanel
        eyebrow="Onboarding Scaffold"
        title="Workspace bootstrap flow is reserved for server-backed creation"
        summary="This screen marks the handoff point where a signed-in user will create a workspace, become its owner, and receive the system `wallie` member through a privileged route handler."
        items={[
          "Target POST /api/workspaces for workspace creation and owner membership bootstrap.",
          "Keep slug generation, uniqueness, and wallie system-member creation on the server.",
          "Route users into /w/[workspaceSlug]/issues after successful provisioning.",
        ]}
        tone="planned"
      />
    </main>
  );
}
