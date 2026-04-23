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
          issue_id: string | null
          job_type: string
          last_error: string | null
          requested_by_member_id: string | null
          scheduled_at: string | null
          session_id: string | null
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
          issue_id?: string | null
          job_type?: string
          last_error?: string | null
          requested_by_member_id?: string | null
          scheduled_at?: string | null
          session_id?: string | null
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
          issue_id?: string | null
          job_type?: string
          last_error?: string | null
          requested_by_member_id?: string | null
          scheduled_at?: string | null
          session_id?: string | null
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
            foreignKeyName: "agent_jobs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
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
          input_tokens: number | null
          issue_id: string | null
          last_activity_at: string | null
          model_name: string
          model_provider: string
          output_tokens: number | null
          run_type: string
          started_at: string | null
          status: Database["public"]["Enums"]["agent_run_status"]
          total_cost_usd: number | null
          triggered_by_member_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          agent_job_id?: string | null
          created_at?: string
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          issue_id?: string | null
          last_activity_at?: string | null
          model_name: string
          model_provider: string
          output_tokens?: number | null
          run_type: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_run_status"]
          total_cost_usd?: number | null
          triggered_by_member_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          agent_job_id?: string | null
          created_at?: string
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          issue_id?: string | null
          last_activity_at?: string | null
          model_name?: string
          model_provider?: string
          output_tokens?: number | null
          run_type?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_run_status"]
          total_cost_usd?: number | null
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
      issues: {
        Row: {
          created_at: string
          creator_member_id: string | null
          description_md: string
          github_repository_id: string | null
          id: string
          number: number
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          creator_member_id?: string | null
          description_md?: string
          github_repository_id?: string | null
          id?: string
          number: number
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          creator_member_id?: string | null
          description_md?: string
          github_repository_id?: string | null
          id?: string
          number?: number
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
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
      session_artifacts: {
        Row: {
          artifact_json: Json
          created_at: string
          feedback_text: string | null
          id: string
          phase: Database["public"]["Enums"]["session_phase"]
          session_id: string
          version: number
          workspace_id: string
        }
        Insert: {
          artifact_json: Json
          created_at?: string
          feedback_text?: string | null
          id?: string
          phase: Database["public"]["Enums"]["session_phase"]
          session_id: string
          version: number
          workspace_id: string
        }
        Update: {
          artifact_json?: Json
          created_at?: string
          feedback_text?: string | null
          id?: string
          phase?: Database["public"]["Enums"]["session_phase"]
          session_id?: string
          version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_artifacts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_artifacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_phase_completions: {
        Row: {
          completed_at: string
          completed_by_member_id: string | null
          id: string
          phase: Database["public"]["Enums"]["session_phase"]
          session_id: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string
          completed_by_member_id?: string | null
          id?: string
          phase: Database["public"]["Enums"]["session_phase"]
          session_id: string
          workspace_id: string
        }
        Update: {
          completed_at?: string
          completed_by_member_id?: string | null
          id?: string
          phase?: Database["public"]["Enums"]["session_phase"]
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_phase_completions_completed_by_member_id_fkey"
            columns: ["completed_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_phase_completions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_phase_completions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_pull_requests: {
        Row: {
          branch_name: string
          created_at: string
          github_repository_id: string | null
          id: string
          is_draft: boolean | null
          pull_request_number: number | null
          pull_request_state: string | null
          pull_request_url: string | null
          session_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          branch_name: string
          created_at?: string
          github_repository_id?: string | null
          id?: string
          is_draft?: boolean | null
          pull_request_number?: number | null
          pull_request_state?: string | null
          pull_request_url?: string | null
          session_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          branch_name?: string
          created_at?: string
          github_repository_id?: string | null
          id?: string
          is_draft?: boolean | null
          pull_request_number?: number | null
          pull_request_state?: string | null
          pull_request_url?: string | null
          session_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_pull_requests_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pull_requests_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pull_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          archived_at: string | null
          created_at: string
          creator_member_id: string | null
          current_artifact_version: number
          id: string
          issue_id: string | null
          linear_issue_id: string | null
          linear_issue_url: string | null
          number: number
          phase: Database["public"]["Enums"]["session_phase"]
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          prompt_md: string
          rejection_count: number
          slack_channel_id: string | null
          slack_thread_ts: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          creator_member_id?: string | null
          current_artifact_version?: number
          id?: string
          issue_id?: string | null
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          number: number
          phase?: Database["public"]["Enums"]["session_phase"]
          phase_status?: Database["public"]["Enums"]["pipeline_phase_status"]
          prompt_md?: string
          rejection_count?: number
          slack_channel_id?: string | null
          slack_thread_ts?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          creator_member_id?: string | null
          current_artifact_version?: number
          id?: string
          issue_id?: string | null
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          number?: number
          phase?: Database["public"]["Enums"]["session_phase"]
          phase_status?: Database["public"]["Enums"]["pipeline_phase_status"]
          prompt_md?: string
          rejection_count?: number
          slack_channel_id?: string | null
          slack_thread_ts?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_creator_member_id_fkey"
            columns: ["creator_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_workspace_id_fkey"
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
      worker_heartbeats: {
        Row: {
          active_job_id: string | null
          id: string
          last_heartbeat_at: string
          metadata: Json
          started_at: string
          worker_id: string
        }
        Insert: {
          active_job_id?: string | null
          id?: string
          last_heartbeat_at?: string
          metadata?: Json
          started_at?: string
          worker_id: string
        }
        Update: {
          active_job_id?: string | null
          id?: string
          last_heartbeat_at?: string
          metadata?: Json
          started_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_heartbeats_active_job_id_fkey"
            columns: ["active_job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_agent_config: {
        Row: {
          created_at: string
          id: string
          key: string
          updated_at: string
          value_json: Json
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          updated_at?: string
          value_json?: Json
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          updated_at?: string
          value_json?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_agent_config_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
      workspace_prompt_templates: {
        Row: {
          created_at: string
          id: string
          phase: Database["public"]["Enums"]["session_phase"]
          template_md: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          phase: Database["public"]["Enums"]["session_phase"]
          template_md: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          phase?: Database["public"]["Enums"]["session_phase"]
          template_md?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_prompt_templates_workspace_id_fkey"
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
      approve_session_phase: {
        Args: {
          approver_member_id?: string
          expected_version: number
          expected_workspace_id: string
          target_session_id: string
        }
        Returns: {
          archived_at: string
          id: string
          linear_issue_url: string
          phase: Database["public"]["Enums"]["session_phase"]
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          slack_channel_id: string
          slack_thread_ts: string
          workspace_id: string
        }[]
      }
      can_manage_workspace: {
        Args: { target_workspace_id: string }
        Returns: boolean
      }
      claim_agent_job: {
        Args: { default_concurrency_limit?: number; target_job_id: string }
        Returns: {
          attempt_count: number
          created_at: string
          dedupe_key: string | null
          finished_at: string | null
          id: string
          issue_id: string | null
          job_type: string
          last_error: string | null
          requested_by_member_id: string | null
          scheduled_at: string | null
          session_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["agent_job_status"]
          trigger_type: Database["public"]["Enums"]["agent_trigger_type"]
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "agent_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_workspace: {
        Args: { requested_slug?: string; workspace_name: string }
        Returns: {
          avatar_path: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          slug: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workspaces"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_user_workspace_ids: { Args: never; Returns: string[] }
      next_session_number: {
        Args: { target_workspace_id: string }
        Returns: number
      }
      schedule_job_retry: {
        Args: {
          base_delay_ms?: number
          max_backoff_ms?: number
          target_job_id: string
        }
        Returns: {
          attempt_count: number
          created_at: string
          dedupe_key: string | null
          finished_at: string | null
          id: string
          issue_id: string | null
          job_type: string
          last_error: string | null
          requested_by_member_id: string | null
          scheduled_at: string | null
          session_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["agent_job_status"]
          trigger_type: Database["public"]["Enums"]["agent_trigger_type"]
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "agent_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
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
      member_kind: "human" | "system"
      member_role: "owner" | "admin" | "member" | "agent"
      pipeline_phase_status:
        | "agent_generating"
        | "awaiting_review"
        | "approved"
        | "rejected"
        | "escalated"
      session_phase:
        | "product"
        | "design"
        | "engineering"
        | "review"
        | "land"
        | "monitor"
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
      member_kind: ["human", "system"],
      member_role: ["owner", "admin", "member", "agent"],
      pipeline_phase_status: [
        "agent_generating",
        "awaiting_review",
        "approved",
        "rejected",
        "escalated",
      ],
      session_phase: [
        "product",
        "design",
        "engineering",
        "review",
        "land",
        "monitor",
      ],
    },
  },
} as const

