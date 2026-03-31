import { PlaceholderPanel } from "@/components/shared/placeholder-panel";
import { workspaceLabel } from "@/lib/routes";

type SettingsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function SettingsPage({ params }: SettingsPageProps) {
  const { workspaceSlug } = await params;

  return (
    <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
      <PlaceholderPanel
        eyebrow="Workspace Settings"
        title="Profile, billing, GitHub, and secret-management entry points"
        summary="The settings surface is reserved for workspace identity, GitHub App installation state, subscription display, and encrypted secret previews handled through privileged route handlers."
        items={[
          "Use Supabase Storage for workspace avatars instead of client-exposed object storage credentials.",
          "Keep GitHub install, refresh, and webhook flows behind route handlers.",
          "Read and write secret values through server routes; only previews should reach the client.",
        ]}
        tone="planned"
      />

      <PlaceholderPanel
        eyebrow="Tenant Context"
        title={workspaceLabel(workspaceSlug)}
        summary="This placeholder keeps the workspace-prefixed route structure visible while schema, auth, GitHub, billing, and secrets agents converge on final contracts."
        items={[
          "Settings nested routes can later branch into /settings/github and /settings/billing.",
          "RLS should key access off auth.uid() and workspace membership rows.",
          "No storage, billing, or GitHub credentials belong in public client code.",
        ]}
      />
    </div>
  );
}
