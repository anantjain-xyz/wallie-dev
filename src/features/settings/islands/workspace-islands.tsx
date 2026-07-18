"use client";

import { useEffect, useState } from "react";

import type { SettingsInitialData, SettingsPageData } from "@/features/settings/data";
import { DangerZoneSection } from "@/features/settings/danger-zone-section";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import { WorkspaceAvatarSection } from "@/features/settings/workspace-avatar-section";
import { WorkspaceMembersSection } from "@/features/settings/workspace-members-section";
import type { WorkspaceInvitation } from "@/lib/workspace-invitations/contracts";
import {
  dispatchSettingsEvent,
  SETTINGS_WORKSPACE_NAME_CHANGED,
} from "@/features/settings/settings-island-events";

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

export function WorkspaceMembersIsland({
  initialData,
  invitations,
}: {
  initialData: SettingsPageData;
  invitations: WorkspaceInvitation[];
}) {
  const { feedback, setMessage } = useIslandFeedback();
  return (
    <>
      {feedback}
      <WorkspaceMembersSection
        canManage={initialData.canManage}
        currentMemberId={initialData.currentMember.id}
        initialInvitations={invitations}
        setFlashMessage={setMessage}
        workspaceId={initialData.workspace.id}
        workspaceMembers={initialData.workspaceMembers}
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
