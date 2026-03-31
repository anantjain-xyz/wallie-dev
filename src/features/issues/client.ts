import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Database,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "@/lib/supabase/database.types";
import type {
  IssuePriority,
  IssueStatus,
} from "@/features/issues/types";

export type IssueCreateInput = {
  assigneeMemberId?: string | null;
  descriptionMd?: string;
  designMd?: string | null;
  estimatePoints?: number | null;
  planMd?: string | null;
  priority?: IssuePriority;
  status?: IssueStatus;
  title: string;
  workspaceId: string;
};

export async function createIssueWithAllocatedNumber(
  supabase: SupabaseClient<Database>,
  input: IssueCreateInput,
) {
  const { data: number, error: numberError } = await supabase.rpc(
    "next_issue_number",
    {
      target_workspace_id: input.workspaceId,
    },
  );

  if (numberError) {
    throw numberError;
  }

  const payload: TablesInsert<"issues"> = {
    assignee_member_id: input.assigneeMemberId ?? null,
    description_md: input.descriptionMd ?? "",
    design_md: input.designMd ?? null,
    estimate_points: input.estimatePoints ?? null,
    number,
    plan_md: input.planMd ?? null,
    priority: input.priority ?? "none",
    status: input.status ?? "backlog",
    title: input.title,
    workspace_id: input.workspaceId,
  };

  const { data: issue, error } = await supabase
    .from("issues")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return issue as Tables<"issues">;
}

export async function resolveIssueByNumber(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  issueNumber: number,
) {
  const { data, error } = await supabase
    .from("issues")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("number", issueNumber)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as Tables<"issues"> | null;
}

export async function updateIssueRows(
  supabase: SupabaseClient<Database>,
  issueIds: string[],
  patch: TablesUpdate<"issues">,
) {
  const { error } = await supabase.from("issues").update(patch).in("id", issueIds);

  if (error) {
    throw error;
  }
}
