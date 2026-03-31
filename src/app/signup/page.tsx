import { PlaceholderPanel } from "@/components/shared/placeholder-panel";

export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-8 sm:px-6 lg:px-8">
      <PlaceholderPanel
        eyebrow="Auth Scaffold"
        title="Workspace signup and invitation flows start here"
        summary="The signup route is parked with the same contracts as login so onboarding can later branch into create-workspace and accept-invite flows without reworking the public app surface."
        items={[
          "Reserve this screen for first-run identity creation and invitation acceptance.",
          "Keep all workspace membership rules in Postgres and RLS rather than duplicating them in the client.",
          "Wire the next step into /onboarding/workspace once auth is operational.",
        ]}
        tone="planned"
      />
    </main>
  );
}
