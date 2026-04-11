export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      agent_jobs: {
        Row: {
          attempt_count: number
          created_at: string
          dedupe_key: string | null
          finished_at: string | null
          id: string
          issue_id: string
          job_type: string
          last_error: string | null
          requested_by_member_id: string | null
          scheduled_at: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["agent_job_status"]
          trigger_type: Database["public"]["Enums"]["agent_trigger_type"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          dedupe_key?: string | null
          finished_at?: string | null
          id?: string
          issue_id: string
          job_type?: string
          last_error?: string | null
          requested_by_member_id?: string | null
          scheduled_at?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_job_status"]
          trigger_type: Database["public"]["Enums"]["agent_trigger_type"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          dedupe_key?: string | null
          finished_at?: string | null
          id?: string
          issue_id?: string
          job_type?: string
          last_error?: string | null
          requested_by_member_id?: string | null
          scheduled_at?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_job_status"]
          trigger_type?: Database["public"]["Enums"]["agent_trigger_type"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_jobs_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_jobs_requested_by_member_id_fkey"
            columns: ["requested_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_run_messages: {
        Row: {
          agent_run_id: string
          created_at: string
          id: string
          kind: string
          message_md: string
          workspace_id: string
        }
        Insert: {
          agent_run_id: string
          created_at?: string
          id?: string
          kind: string
          message_md: string
          workspace_id: string
        }
        Update: {
          agent_run_id?: string
          created_at?: string
          id?: string
          kind?: string
          message_md?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_run_messages_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_messages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent_job_id: string | null
          created_at: string
          finished_at: string | null
          id: string
          issue_id: string
          model_name: string
          model_provider: string
          run_type: string
          started_at: string | null
          status: Database["public"]["Enums"]["agent_run_status"]
          triggered_by_member_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          agent_job_id?: string | null
          created_at?: string
          finished_at?: string | null
          id?: string
          issue_id: string
          model_name: string
          model_provider: string
          run_type: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_run_status"]
          triggered_by_member_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          agent_job_id?: string | null
          created_at?: string
          finished_at?: string | null
          id?: string
          issue_id?: string
          model_name?: string
          model_provider?: string
          run_type?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_run_status"]
          triggered_by_member_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_agent_job_id_fkey"
            columns: ["agent_job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_triggered_by_member_id_fkey"
            columns: ["triggered_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      github_installations: {
        Row: {
          app_id: number
          created_at: string
          id: string
          installation_id: number
          installation_url: string
          permissions: Json
          suspended: boolean
          target_name: string
          target_type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          app_id: number
          created_at?: string
          id?: string
          installation_id: number
          installation_url: string
          permissions: Json
          suspended?: boolean
          target_name: string
          target_type: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          app_id?: number
          created_at?: string
          id?: string
          installation_id?: number
          installation_url?: string
          permissions?: Json
          suspended?: boolean
          target_name?: string
          target_type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "github_installations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      github_issue_branches: {
        Row: {
          branch_name: string
          created_at: string
          github_repository_id: string | null
          id: string
          is_draft: boolean | null
          issue_id: string
          pull_request_number: number | null
          pull_request_state: string | null
          pull_request_url: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          branch_name: string
          created_at?: string
          github_repository_id?: string | null
          id?: string
          is_draft?: boolean | null
          issue_id: string
          pull_request_number?: number | null
          pull_request_state?: string | null
          pull_request_url?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          branch_name?: string
          created_at?: string
          github_repository_id?: string | null
          id?: string
          is_draft?: boolean | null
          issue_id?: string
          pull_request_number?: number | null
          pull_request_state?: string | null
          pull_request_url?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "github_issue_branches_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_issue_branches_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_issue_branches_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      github_repositories: {
        Row: {
          created_at: string
          default_branch: string | null
          default_programming_language: string | null
          description: string | null
          full_name: string
          github_installation_id: string
          html_url: string
          id: string
          is_archived: boolean
          name: string
          private: boolean
          repo_id: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          default_branch?: string | null
          default_programming_language?: string | null
          description?: string | null
          full_name: string
          github_installation_id: string
          html_url: string
          id?: string
          is_archived?: boolean
          name: string
          private: boolean
          repo_id: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          default_branch?: string | null
          default_programming_language?: string | null
          description?: string | null
          full_name?: string
          github_installation_id?: string
          html_url?: string
          id?: string
          is_archived?: boolean
          name?: string
          private?: boolean
          repo_id?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "github_repositories_github_installation_id_fkey"
            columns: ["github_installation_id"]
            isOneToOne: false
            referencedRelation: "github_installations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_repositories_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      issue_comments: {
        Row: {
          author_member_id: string | null
          body_md: string
          created_at: string
          id: string
          issue_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          author_member_id?: string | null
          body_md: string
          created_at?: string
          id?: string
          issue_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          author_member_id?: string | null
          body_md?: string
          created_at?: string
          id?: string
          issue_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issue_comments_author_member_id_fkey"
            columns: ["author_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issue_comments_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issue_comments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      issue_links: {
        Row: {
          created_at: string
          id: string
          link_type: Database["public"]["Enums"]["issue_link_type"]
          source_issue_id: string
          target_issue_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          link_type: Database["public"]["Enums"]["issue_link_type"]
          source_issue_id: string
          target_issue_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          link_type?: Database["public"]["Enums"]["issue_link_type"]
          source_issue_id?: string
          target_issue_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issue_links_source_issue_id_fkey"
            columns: ["source_issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issue_links_target_issue_id_fkey"
            columns: ["target_issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issue_links_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_artifacts: {
        Row: {
          artifact_json: Json
          created_at: string
          feedback_text: string | null
          id: string
          phase: Database["public"]["Enums"]["pipeline_phase"]
          pipeline_issue_id: string
          version: number
        }
        Insert: {
          artifact_json: Json
          created_at?: string
          feedback_text?: string | null
          id?: string
          phase: Database["public"]["Enums"]["pipeline_phase"]
          pipeline_issue_id: string
          version: number
        }
        Update: {
          artifact_json?: Json
          created_at?: string
          feedback_text?: string | null
          id?: string
          phase?: Database["public"]["Enums"]["pipeline_phase"]
          pipeline_issue_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_artifacts_pipeline_issue_id_fkey"
            columns: ["pipeline_issue_id"]
            isOneToOne: false
            referencedRelation: "pipeline_issues"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_issues: {
        Row: {
          created_at: string
          current_artifact_version: number
          design_approved_at: string | null
          engineering_approved_at: string | null
          id: string
          issue_id: string
          linear_issue_id: string | null
          linear_issue_url: string | null
          phase: Database["public"]["Enums"]["pipeline_phase"]
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          product_approved_at: string | null
          rejection_count: number
          shipped_at: string | null
          slack_channel_id: string | null
          slack_thread_ts: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          current_artifact_version?: number
          design_approved_at?: string | null
          engineering_approved_at?: string | null
          id?: string
          issue_id: string
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          phase?: Database["public"]["Enums"]["pipeline_phase"]
          phase_status?: Database["public"]["Enums"]["pipeline_phase_status"]
          product_approved_at?: string | null
          rejection_count?: number
          shipped_at?: string | null
          slack_channel_id?: string | null
          slack_thread_ts?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          current_artifact_version?: number
          design_approved_at?: string | null
          engineering_approved_at?: string | null
          id?: string
          issue_id?: string
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          phase?: Database["public"]["Enums"]["pipeline_phase"]
          phase_status?: Database["public"]["Enums"]["pipeline_phase_status"]
          product_approved_at?: string | null
          rejection_count?: number
          shipped_at?: string | null
          slack_channel_id?: string | null
          slack_thread_ts?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_issues_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pipeline_issues_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      slack_installations: {
        Row: {
          bot_token_encrypted: string
          id: string
          installed_at: string
          team_id: string
          team_name: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          bot_token_encrypted: string
          id?: string
          installed_at?: string
          team_id: string
          team_name?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          bot_token_encrypted?: string
          id?: string
          installed_at?: string
          team_id?: string
          team_name?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "slack_installations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      issues: {
        Row: {
          assignee_member_id: string | null
          created_at: string
          creator_member_id: string | null
          description_md: string
          design_md: string | null
          estimate_points: number | null
          github_repository_id: string | null
          id: string
          number: number
          plan_md: string | null
          priority: Database["public"]["Enums"]["issue_priority"]
          priority_rank: number | null
          status: Database["public"]["Enums"]["issue_status"]
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          assignee_member_id?: string | null
          created_at?: string
          creator_member_id?: string | null
          description_md?: string
          design_md?: string | null
          estimate_points?: number | null
          github_repository_id?: string | null
          id?: string
          number: number
          plan_md?: string | null
          priority?: Database["public"]["Enums"]["issue_priority"]
          priority_rank?: number | null
          status?: Database["public"]["Enums"]["issue_status"]
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          assignee_member_id?: string | null
          created_at?: string
          creator_member_id?: string | null
          description_md?: string
          design_md?: string | null
          estimate_points?: number | null
          github_repository_id?: string | null
          id?: string
          number?: number
          plan_md?: string | null
          priority?: Database["public"]["Enums"]["issue_priority"]
          priority_rank?: number | null
          status?: Database["public"]["Enums"]["issue_status"]
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issues_assignee_member_id_fkey"
            columns: ["assignee_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_creator_member_id_fkey"
            columns: ["creator_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          primary_email: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          primary_email?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          primary_email?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      workspace_members: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          is_active: boolean
          kind: Database["public"]["Enums"]["member_kind"]
          preferences: Json
          role: Database["public"]["Enums"]["member_role"]
          updated_at: string
          user_id: string | null
          username: string | null
          workspace_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean
          kind: Database["public"]["Enums"]["member_kind"]
          preferences?: Json
          role: Database["public"]["Enums"]["member_role"]
          updated_at?: string
          user_id?: string | null
          username?: string | null
          workspace_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean
          kind?: Database["public"]["Enums"]["member_kind"]
          preferences?: Json
          role?: Database["public"]["Enums"]["member_role"]
          updated_at?: string
          user_id?: string | null
          username?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_secrets: {
        Row: {
          created_at: string
          created_by_member_id: string | null
          encrypted_value: string
          id: string
          key: string
          updated_at: string
          value_preview: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by_member_id?: string | null
          encrypted_value: string
          id?: string
          key: string
          updated_at?: string
          value_preview?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by_member_id?: string | null
          encrypted_value?: string
          id?: string
          key?: string
          updated_at?: string
          value_preview?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_secrets_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_secrets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          avatar_path: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          avatar_path?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_workspace: {
        Args: { requested_slug?: string | null; workspace_name: string }
        Returns: {
          avatar_path: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          slug: string
          updated_at: string
        }
      }
      can_manage_workspace: {
        Args: { target_workspace_id: string }
        Returns: boolean
      }
      current_user_workspace_ids: { Args: never; Returns: string[] }
      next_issue_number: {
        Args: { target_workspace_id: string }
        Returns: number
      }
      approve_pipeline_phase: {
        Args: {
          pipeline_issue_id: string
          expected_workspace_id: string
          expected_version: number
        }
        Returns: {
          id: string
          phase: Database["public"]["Enums"]["pipeline_phase"]
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          workspace_id: string
          slack_channel_id: string | null
          slack_thread_ts: string | null
          linear_issue_url: string | null
        }[]
      }
    }
    Enums: {
      agent_job_status: "queued" | "running" | "success" | "error" | "canceled"
      agent_run_status:
        | "queued"
        | "started"
        | "running"
        | "success"
        | "error"
        | "canceled"
      agent_trigger_type:
        | "manual_run"
        | "manual_retry"
        | "assignment"
        | "comment_retry"
        | "slack_mention"
      issue_link_type: "blocked_by" | "sub_issue" | "related" | "duplicate"
      issue_priority: "none" | "low" | "medium" | "high" | "urgent"
      issue_status:
        | "backlog"
        | "todo"
        | "in_progress"
        | "in_review"
        | "done"
        | "canceled"
      pipeline_phase: "product" | "design" | "engineering" | "shipped"
      pipeline_phase_status:
        | "agent_generating"
        | "awaiting_review"
        | "approved"
        | "rejected"
        | "escalated"
      member_kind: "human" | "system"
      member_role: "owner" | "admin" | "member" | "agent"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      agent_job_status: ["queued", "running", "success", "error", "canceled"],
      agent_run_status: [
        "queued",
        "started",
        "running",
        "success",
        "error",
        "canceled",
      ],
      agent_trigger_type: [
        "manual_run",
        "manual_retry",
        "assignment",
        "comment_retry",
        "slack_mention",
      ],
      issue_link_type: ["blocked_by", "sub_issue", "related", "duplicate"],
      issue_priority: ["none", "low", "medium", "high", "urgent"],
      issue_status: [
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "done",
        "canceled",
      ],
      pipeline_phase: ["product", "design", "engineering", "shipped"],
      pipeline_phase_status: [
        "agent_generating",
        "awaiting_review",
        "approved",
        "rejected",
        "escalated",
      ],
      member_kind: ["human", "system"],
      member_role: ["owner", "admin", "member", "agent"],
    },
  },
} as const
