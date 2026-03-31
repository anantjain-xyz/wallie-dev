import { PlaceholderPanel } from "@/components/shared/placeholder-panel";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-8 sm:px-6 lg:px-8">
      <PlaceholderPanel
        eyebrow="Auth Scaffold"
        title="Supabase Auth login route reserved"
        summary="This route is intentionally shallow until the auth agent lands Google OAuth, GitHub OAuth, and magic-link sign-in on top of Supabase Auth."
        items={[
          "Replace this placeholder with a server-first auth entry point and provider buttons.",
          "Persist the post-login destination so workspace routing can resume cleanly.",
          "Do not reintroduce Clerk or email-claim tenancy lookup as the primary auth model.",
        ]}
        tone="ready"
      />
    </main>
  );
}
