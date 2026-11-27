"use client";

import { lazy, useEffect, useState, type ComponentProps } from "react";

import type { SettingsInitialData } from "@/features/settings/data";
import { DangerZoneSection } from "@/features/settings/danger-zone-section";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import { WorkspaceAvatarSection } from "@/features/settings/workspace-avatar-section";
import {
  dispatchSettingsEvent,
  SETTINGS_WORKSPACE_NAME_CHANGED,
} from "@/features/settings/settings-island-events";

const WorkspaceMembersSection = lazy(() =>
  import("@/features/settings/workspace-members-section").then((module) => ({
    default: module.WorkspaceMembersSection,
  })),
);

const WorkspaceInvitationsSection = lazy(() =>
  import("@/features/settings/workspace-invitations-section").then((module) => ({
    default: module.WorkspaceInvitationsSection,
  })),
);

const WorkspaceProfileSection = lazy(() =>
  import("@/features/settings/workspace-profile-section").then((module) => ({
    default: module.WorkspaceProfileSection,
  })),
);

export function WorkspaceMembersIsland(props: ComponentProps<typeof WorkspaceMembersSection>) {
  return <WorkspaceMembersSection {...props} />;
}

export function WorkspaceInvitationsIsland(
  props: ComponentProps<typeof WorkspaceInvitationsSection>,
) {
  return <WorkspaceInvitationsSection {...props} />;
}

export function WorkspaceProfileIsland(props: ComponentProps<typeof WorkspaceProfileSection>) {
  return <WorkspaceProfileSection {...props} />;
}

export function WorkspaceIdentityIsland({ initialData }: { initialData: SettingsInitialData }) {
  const [workspace, setWorkspace] = useState(initialData.workspace);
  const { feedback, setMessage } = useIslandFeedback();
  return (
    <>
      {feedback}
      <WorkspaceAvatarSection
        canManage={initialData.canManage}
        onWorkspaceNameChange={(name) => {
          setWorkspace((current) => ({ ...current, name }));
          dispatchSettingsEvent(SETTINGS_WORKSPACE_NAME_CHANGED, name);
        }}
        setFlashMessage={setMessage}
        workspace={workspace}
      />
    </>
  );
}

export function DangerActionsIsland({ initialData }: { initialData: SettingsInitialData }) {
  const [workspaceName, setWorkspaceName] = useState(initialData.workspace.name);
  useEffect(() => {
    const handleNameChange = (event: Event) =>
      setWorkspaceName((event as CustomEvent<string>).detail);
    window.addEventListener(SETTINGS_WORKSPACE_NAME_CHANGED, handleNameChange);
    return () => window.removeEventListener(SETTINGS_WORKSPACE_NAME_CHANGED, handleNameChange);
  }, []);
  return (
    <DangerZoneSection
      canDelete={initialData.currentMember.role === "owner"}
      workspaceId={initialData.workspace.id}
      workspaceName={workspaceName}
    />
  );
}
