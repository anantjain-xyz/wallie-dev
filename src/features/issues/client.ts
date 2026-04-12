import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables, TablesInsert } from "@/lib/supabase/database.types";

export type IssueCreateInput = {
  descriptionMd?: string;
  title: string;
  workspaceId: string;
};

export async function createIssueWithAllocatedNumber(
  supabase: SupabaseClient<Database>,
  input: IssueCreateInput,
) {
  const { data: number, error: numberError } = await supabase.rpc("next_session_number", {
    target_workspace_id: input.workspaceId,
  });

  if (numberError) {
    throw numberError;
  }

  const payload: TablesInsert<"issues"> = {
    description_md: input.descriptionMd ?? "",
    number,
    title: input.title,
    workspace_id: input.workspaceId,
  };

  const { data: issue, error } = await supabase.from("issues").insert(payload).select("*").single();

  if (error) {
    throw error;
  }

  return issue as Tables<"issues">;
}
