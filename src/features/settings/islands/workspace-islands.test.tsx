// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/settings/workspace-avatar-section", () => ({
  WorkspaceAvatarSection: ({
    onWorkspaceNameChange,
    workspace,
  }: {
    onWorkspaceNameChange: (name: string) => void;
    workspace: { name: string };
  }) => (
    <button onClick={() => onWorkspaceNameChange("Renamed workspace")} type="button">
      Workspace {workspace.name}
    </button>
  ),
}));
vi.mock("@/features/settings/danger-zone-section", () => ({
  DangerZoneSection: ({
    canDelete,
    workspaceName,
  }: {
    canDelete: boolean;
    workspaceName: string;
  }) => (
    <p>
      Danger zone: {workspaceName}, {canDelete ? "owner" : "member"}
    </p>
  ),
}));

import type { SettingsInitialData } from "@/features/settings/data";
import {
  DangerActionsIsland,
  WorkspaceIdentityIsland,
} from "@/features/settings/islands/workspace-islands";

function initialData(role: "member" | "owner" = "owner"): SettingsInitialData {
  return {
    canManage: role === "owner",
    currentMember: { id: "member-1", role },
    github: {} as never,
    workspace: {
      avatarPath: null,
      avatarUrl: null,
      id: "workspace-1",
      name: "Acme",
      slug: "acme",
    },
  };
}

describe("Settings workspace islands", () => {
  it("synchronizes a workspace rename with the deletion confirmation", () => {
    const data = initialData();

    render(
      <>
        <WorkspaceIdentityIsland initialData={data} />
        <DangerActionsIsland initialData={data} />
      </>,
    );

    expect(screen.getByText("Danger zone: Acme, owner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Workspace Acme" }));

    expect(screen.getByRole("button", { name: "Workspace Renamed workspace" })).toBeInTheDocument();
    expect(screen.getByText("Danger zone: Renamed workspace, owner")).toBeInTheDocument();
  });

  it("keeps destructive workspace actions owner-only", () => {
    render(<DangerActionsIsland initialData={initialData("member")} />);

    expect(screen.getByText("Danger zone: Acme, member")).toBeInTheDocument();
  });
});
