import { AGENT_PROVIDER_LABELS } from "@/components/shared/agent-provider-options";
import { MetadataItem } from "@/components/ui/page-shell";
import type { RecordedRunExecutionProfile } from "@/lib/factory-definitions/execution-profile-contracts";

const sandboxLabels = {
  vercel: "Vercel Sandbox",
  e2b: "E2B",
  daytona: "Daytona",
} satisfies Record<NonNullable<RecordedRunExecutionProfile["sandboxProvider"]>, string>;

export function ExecutionProfileFields({
  profile,
}: {
  profile: Pick<
    RecordedRunExecutionProfile,
    "provider" | "model" | "effort" | "maxTurns" | "sandboxProvider"
  >;
}) {
  return (
    <>
      <MetadataItem label="Harness" value={AGENT_PROVIDER_LABELS[profile.provider]} />
      <MetadataItem
        label="Model"
        monospace
        value={<span className="[overflow-wrap:anywhere]">{profile.model}</span>}
      />
      {profile.effort && <MetadataItem label="Effort" value={profile.effort} />}
      {profile.maxTurns !== null && <MetadataItem label="Maximum turns" value={profile.maxTurns} />}
      <MetadataItem
        label="Sandbox"
        value={profile.sandboxProvider ? sandboxLabels[profile.sandboxProvider] : "Unrecorded"}
      />
    </>
  );
}
