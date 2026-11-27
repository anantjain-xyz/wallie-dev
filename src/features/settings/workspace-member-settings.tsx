import { Suspense, type ReactNode } from "react";

import type {
  SettingsInitialData,
  SettingsSetupData,
  SettingsWorkspaceProfile,
  WorkspaceInvitationsSnapshot,
} from "@/features/settings/data";
import { Section } from "@/features/settings/settings-ui";
import { WorkspaceInvitationsSection } from "@/features/settings/workspace-invitations-section";
import { WorkspaceMembersSection } from "@/features/settings/workspace-members-section";
import { WorkspaceProfileSection } from "@/features/settings/workspace-profile-section";
import { WorkspaceSettingsLoadError } from "@/features/settings/workspace-settings-load-error";

async function WorkspaceSettingsRead<T>({
  data,
  error,
  render,
}: {
  data: Promise<T>;
  error: ReactNode;
  render: (value: T) => ReactNode;
}) {
  let value: T;
  try {
    value = await data;
  } catch {
    return error;
  }
  return render(value);
}

function WorkspaceSettingsLoading({ label }: { label: string }) {
  return (
    <p aria-busy="true" className="ui-sheet px-4 py-3 type-body text-muted" role="status">
      Loading {label}…
    </p>
  );
}

export function WorkspaceMemberSettings({
  initialData,
  invitations,
  setup,
}: {
  initialData: SettingsInitialData;
  invitations: Promise<WorkspaceInvitationsSnapshot>;
  setup: Promise<SettingsSetupData>;
}) {
  const { canManage, currentMember, workspace } = initialData;
  return (
    <Section
      anchorId="members"
      tagline={`See who has access to ${workspace.name}.`}
      title="Team access"
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <h3 className="text-[14px] font-semibold text-foreground">Active members</h3>
          <Suspense fallback={<WorkspaceSettingsLoading label="active members" />}>
            <WorkspaceSettingsRead
              data={setup}
              error={<WorkspaceSettingsLoadError label="active members" />}
              render={({ workspaceMembers }) => (
                <WorkspaceMembersSection
                  canManage={canManage}
                  currentMemberId={currentMember.id}
                  workspaceId={workspace.id}
                  workspaceMembers={workspaceMembers}
                />
              )}
            />
          </Suspense>
        </div>
        {canManage && (
          <Suspense
            fallback={
              <InvitationPlaceholder>
                <WorkspaceSettingsLoading label="pending invitations" />
              </InvitationPlaceholder>
            }
          >
            <WorkspaceSettingsRead
              data={invitations}
              error={
                <InvitationPlaceholder>
                  <WorkspaceSettingsLoadError label="pending invitations" />
                </InvitationPlaceholder>
              }
              render={(snapshot) => (
                <WorkspaceInvitationsSection snapshot={snapshot} workspaceId={workspace.id} />
              )}
            />
          </Suspense>
        )}
      </div>
    </Section>
  );
}

export function WorkspacePersonalProfile({
  profile,
}: {
  profile: Promise<SettingsWorkspaceProfile>;
}) {
  return (
    <Section anchorId="profile" heading="h3" title="Your profile">
      <Suspense fallback={<WorkspaceSettingsLoading label="your profile" />}>
        <WorkspaceSettingsRead
          data={profile}
          error={<WorkspaceSettingsLoadError label="your profile" />}
          render={(value) => <WorkspaceProfileSection initialProfile={value} />}
        />
      </Suspense>
    </Section>
  );
}

function InvitationPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-[14px] font-semibold text-foreground">Pending invitations</h3>
      {children}
    </div>
  );
}
