import type {
  SettingsInitialData,
  SettingsPageData,
  SettingsSetupData,
  WorkspaceUsageData,
} from "@/features/settings/data";
import type { WorkspaceInvitation } from "@/lib/workspace-invitations/contracts";

export type SettingsPageClientProps = {
  initialData: SettingsInitialData | SettingsPageData;
  searchState: {
    githubStatus: string | null;
    codexStatus: string | null;
  };
  setupData?: Promise<SettingsSetupData>;
  usage?: Promise<WorkspaceUsageData>;
  workspaceInvitations?: Promise<WorkspaceInvitation[]>;
};

export type FlashMessage = {
  kind: "error" | "info" | "success";
  text: string;
};
