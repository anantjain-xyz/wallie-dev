import type { SettingsPageData } from "@/features/settings/data";

export type SettingsPageClientProps = {
  initialData: SettingsPageData;
  searchState: {
    githubStatus: string | null;
    githubAuthorStatus: string | null;
    codexStatus: string | null;
  };
};

export type FlashMessage = {
  kind: "error" | "info" | "success";
  text: string;
};
