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
          job_type: string
          last_error: string | null
          requested_by_member_id: string | null
          scheduled_at: string | null
          session_id: string
          stage_id: string | null
          stage_name: string | null
          stage_slug: string | null
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
          job_type?: string
          last_error?: string | null
          requested_by_member_id?: string | null
          scheduled_at?: string | null
          session_id: string
          stage_id?: string | null
          stage_name?: string | null
          stage_slug?: string | null
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
          job_type?: string
          last_error?: string | null
          requested_by_member_id?: string | null
          scheduled_at?: string | null
          session_id?: string
          stage_id?: string | null
          stage_name?: string | null
          stage_slug?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_job_status"]
          trigger_type?: Database["public"]["Enums"]["agent_trigger_type"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
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
            foreignKeyName: "agent_jobs_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
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
          last_activity_at: string | null
          model_name: string
          model_provider: string
          output_tokens: number | null
          run_type: string
          sandbox_id: string | null
          session_id: string
          stage_id: string | null
          stage_name: string | null
          stage_slug: string | null
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
          last_activity_at?: string | null
          model_name: string
          model_provider: string
          output_tokens?: number | null
          run_type: string
          sandbox_id?: string | null
          session_id: string
          stage_id?: string | null
          stage_name?: string | null
          stage_slug?: string | null
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
          last_activity_at?: string | null
          model_name?: string
          model_provider?: string
          output_tokens?: number | null
          run_type?: string
          sandbox_id?: string | null
          session_id?: string
          stage_id?: string | null
          stage_name?: string | null
          stage_slug?: string | null
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
            foreignKeyName: "agent_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
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
      codex_device_auth_flows: {
        Row: {
          account_email: string | null
          account_id: string | null
          auth_cache_last_refresh: string | null
          canceled_at: string | null
          command_id: string
          completed_at: string | null
          created_at: string
          encrypted_auth_json: string | null
          error: string | null
          expires_at: string
          id: string
          instructions: string | null
          output_tail: string | null
          sandbox_id: string
          status: string
          updated_at: string
          user_code: string | null
          user_id: string
          verification_uri: string | null
        }
        Insert: {
          account_email?: string | null
          account_id?: string | null
          auth_cache_last_refresh?: string | null
          canceled_at?: string | null
          command_id: string
          completed_at?: string | null
          created_at?: string
          encrypted_auth_json?: string | null
          error?: string | null
          expires_at: string
          id?: string
          instructions?: string | null
          output_tail?: string | null
          sandbox_id: string
          status?: string
          updated_at?: string
          user_code?: string | null
          user_id: string
          verification_uri?: string | null
        }
        Update: {
          account_email?: string | null
          account_id?: string | null
          auth_cache_last_refresh?: string | null
          canceled_at?: string | null
          command_id?: string
          completed_at?: string | null
          created_at?: string
          encrypted_auth_json?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          instructions?: string | null
          output_tail?: string | null
          sandbox_id?: string
          status?: string
          updated_at?: string
          user_code?: string | null
          user_id?: string
          verification_uri?: string | null
        }
        Relationships: []
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
            foreignKeyName: "github_issue_branches_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_issue_branches_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
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
      pipeline_stages: {
        Row: {
          approver_member_ids: string[]
          created_at: string
          description: string
          id: string
          name: string
          pipeline_id: string
          position: number
          prompt_template_md: string
          slug: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          approver_member_ids?: string[]
          created_at?: string
          description?: string
          id?: string
          name: string
          pipeline_id: string
          position: number
          prompt_template_md?: string
          slug: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          approver_member_ids?: string[]
          created_at?: string
          description?: string
          id?: string
          name?: string
          pipeline_id?: string
          position?: number
          prompt_template_md?: string
          slug?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_stages_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pipeline_stages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      pipelines: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          name: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipelines_workspace_id_fkey"
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
      repository_onboarding_status: {
        Row: {
          conflict_report: Json
          created_at: string
          github_repository_id: string
          id: string
          installed_skill_hash: string | null
          installed_skill_version: number | null
          last_error: string | null
          setup_branch_name: string | null
          setup_pr_number: number | null
          setup_pr_url: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          conflict_report?: Json
          created_at?: string
          github_repository_id: string
          id?: string
          installed_skill_hash?: string | null
          installed_skill_version?: number | null
          last_error?: string | null
          setup_branch_name?: string | null
          setup_pr_number?: number | null
          setup_pr_url?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          conflict_report?: Json
          created_at?: string
          github_repository_id?: string
          id?: string
          installed_skill_hash?: string | null
          installed_skill_version?: number | null
          last_error?: string | null
          setup_branch_name?: string | null
          setup_pr_number?: number | null
          setup_pr_url?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repository_onboarding_status_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repository_onboarding_status_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sandbox_capability_checks: {
        Row: {
          capabilities: Json
          checked_at: string
          created_at: string
          error_text: string | null
          github_repository_id: string | null
          id: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          capabilities?: Json
          checked_at?: string
          created_at?: string
          error_text?: string | null
          github_repository_id?: string | null
          id?: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          capabilities?: Json
          checked_at?: string
          created_at?: string
          error_text?: string | null
          github_repository_id?: string | null
          id?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sandbox_capability_checks_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sandbox_capability_checks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_artifact_feedback: {
        Row: {
          created_at: string
          feedback_text: string
          id: string
          session_id: string
          stage_id: string | null
          stage_slug: string
          target_version: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          feedback_text: string
          id?: string
          session_id: string
          stage_id?: string | null
          stage_slug: string
          target_version: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          feedback_text?: string
          id?: string
          session_id?: string
          stage_id?: string | null
          stage_slug?: string
          target_version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_artifact_feedback_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_artifact_feedback_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_artifact_feedback_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_artifacts: {
        Row: {
          artifact_json: Json
          created_at: string
          id: string
          session_id: string
          stage_id: string | null
          stage_slug: string
          version: number
          workspace_id: string
        }
        Insert: {
          artifact_json: Json
          created_at?: string
          id?: string
          session_id: string
          stage_id?: string | null
          stage_slug: string
          version: number
          workspace_id: string
        }
        Update: {
          artifact_json?: Json
          created_at?: string
          id?: string
          session_id?: string
          stage_id?: string | null
          stage_slug?: string
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
            foreignKeyName: "session_artifacts_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
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
          session_id: string
          stage_id: string | null
          stage_slug: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string
          completed_by_member_id?: string | null
          id?: string
          session_id: string
          stage_id?: string | null
          stage_slug: string
          workspace_id: string
        }
        Update: {
          completed_at?: string
          completed_by_member_id?: string | null
          id?: string
          session_id?: string
          stage_id?: string | null
          stage_slug?: string
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
            foreignKeyName: "session_phase_completions_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
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
          current_stage_id: string
          github_repository_id: string | null
          id: string
          linear_issue_id: string | null
          linear_issue_url: string | null
          number: number
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          pipeline_id: string
          prompt_md: string
          rejection_count: number
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          creator_member_id?: string | null
          current_artifact_version?: number
          current_stage_id: string
          github_repository_id?: string | null
          id?: string
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          number: number
          phase_status?: Database["public"]["Enums"]["pipeline_phase_status"]
          pipeline_id: string
          prompt_md?: string
          rejection_count?: number
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          creator_member_id?: string | null
          current_artifact_version?: number
          current_stage_id?: string
          github_repository_id?: string | null
          id?: string
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          number?: number
          phase_status?: Database["public"]["Enums"]["pipeline_phase_status"]
          pipeline_id?: string
          prompt_md?: string
          rejection_count?: number
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
            foreignKeyName: "sessions_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_current_stage_id_fkey"
            columns: ["current_stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
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
      user_claude_code_credentials: {
        Row: {
          created_at: string
          encrypted_api_key: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_api_key: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_api_key?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_codex_credentials: {
        Row: {
          access_token_expires_at: string | null
          account_email: string | null
          account_id: string | null
          auth_cache_last_refresh: string | null
          auth_lock_expires_at: string | null
          auth_lock_run_id: string | null
          auth_reconnect_reason: string | null
          auth_reconnect_required: boolean
          created_at: string
          credential_type: string
          credential_version: number
          encrypted_credential: string
          scope: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_expires_at?: string | null
          account_email?: string | null
          account_id?: string | null
          auth_cache_last_refresh?: string | null
          auth_lock_expires_at?: string | null
          auth_lock_run_id?: string | null
          auth_reconnect_reason?: string | null
          auth_reconnect_required?: boolean
          created_at?: string
          credential_type?: string
          credential_version?: number
          encrypted_credential: string
          scope?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token_expires_at?: string | null
          account_email?: string | null
          account_id?: string | null
          auth_cache_last_refresh?: string | null
          auth_lock_expires_at?: string | null
          auth_lock_run_id?: string | null
          auth_reconnect_reason?: string | null
          auth_reconnect_required?: boolean
          created_at?: string
          credential_type?: string
          credential_version?: number
          encrypted_credential?: string
          scope?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
      workspace_linear_routing: {
        Row: {
          created_at: string
          id: string
          land_stage_slug: string
          rework_stage_slug: string
          status_mappings: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          land_stage_slug?: string
          rework_stage_slug?: string
          status_mappings?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          land_stage_slug?: string
          rework_stage_slug?: string
          status_mappings?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_linear_routing_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
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
      workspace_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by_member_id: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by_member_id: string | null
          last_sent_at: string | null
          revoked_at: string | null
          role: Database["public"]["Enums"]["member_role"]
          status: Database["public"]["Enums"]["workspace_invitation_status"]
          token_hash: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by_member_id?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by_member_id?: string | null
          last_sent_at?: string | null
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["member_role"]
          status?: Database["public"]["Enums"]["workspace_invitation_status"]
          token_hash: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by_member_id?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by_member_id?: string | null
          last_sent_at?: string | null
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["member_role"]
          status?: Database["public"]["Enums"]["workspace_invitation_status"]
          token_hash?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitations_accepted_by_member_id_fkey"
            columns: ["accepted_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitations_invited_by_member_id_fkey"
            columns: ["invited_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_onboarding: {
        Row: {
          completed_at: string | null
          completed_steps: string[]
          created_at: string
          current_step: string
          dismissed_at: string | null
          id: string
          selected_github_repository_id: string | null
          skipped_steps: string[]
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string | null
          completed_steps?: string[]
          created_at?: string
          current_step?: string
          dismissed_at?: string | null
          id?: string
          selected_github_repository_id?: string | null
          skipped_steps?: string[]
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          completed_at?: string | null
          completed_steps?: string[]
          created_at?: string
          current_step?: string
          dismissed_at?: string | null
          id?: string
          selected_github_repository_id?: string | null
          skipped_steps?: string[]
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_onboarding_selected_github_repository_id_fkey"
            columns: ["selected_github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_onboarding_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_repository_profiles: {
        Row: {
          build_command: string | null
          created_at: string
          env_key_suggestions: string[]
          framework_hints: string[]
          github_repository_id: string
          id: string
          inference_confidence: string
          inference_sources: Json
          install_command: string | null
          is_primary: boolean
          language_hints: string[]
          package_manager: string | null
          setup_notes: string
          test_command: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          build_command?: string | null
          created_at?: string
          env_key_suggestions?: string[]
          framework_hints?: string[]
          github_repository_id: string
          id?: string
          inference_confidence?: string
          inference_sources?: Json
          install_command?: string | null
          is_primary?: boolean
          language_hints?: string[]
          package_manager?: string | null
          setup_notes?: string
          test_command?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          build_command?: string | null
          created_at?: string
          env_key_suggestions?: string[]
          framework_hints?: string[]
          github_repository_id?: string
          id?: string
          inference_confidence?: string
          inference_sources?: Json
          install_command?: string | null
          is_primary?: boolean
          language_hints?: string[]
          package_manager?: string | null
          setup_notes?: string
          test_command?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_repository_profiles_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_repository_profiles_workspace_id_fkey"
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
      accept_workspace_invitation: {
        Args: {
          actor_avatar_url?: string
          actor_email: string
          actor_full_name?: string
          actor_user_id: string
          invitation_token_hash: string
        }
        Returns: Json
      }
      acquire_codex_auth_lease: {
        Args: {
          lease_expires_at: string
          target_run_id: string
          target_user_id: string
        }
        Returns: {
          access_token_expires_at: string
          auth_cache_last_refresh: string
          auth_reconnect_reason: string
          auth_reconnect_required: boolean
          credential_type: string
          credential_version: number
          encrypted_credential: string
        }[]
      }
      approve_session_stage: {
        Args: {
          approver_member_id?: string
          expected_version: number
          expected_workspace_id: string
          target_session_id: string
        }
        Returns: {
          archived_at: string
          current_stage_id: string
          current_stage_slug: string
          id: string
          linear_issue_url: string
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          pipeline_id: string
          workspace_id: string
        }[]
      }
      claim_agent_job: {
        Args: { default_concurrency_limit?: number; target_job_id: string }
        Returns: {
          attempt_count: number
          created_at: string
          dedupe_key: string | null
          finished_at: string | null
          id: string
          job_type: string
          last_error: string | null
          requested_by_member_id: string | null
          scheduled_at: string | null
          session_id: string
          stage_id: string | null
          stage_name: string | null
          stage_slug: string | null
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
        Args: {
          actor_avatar_url?: string
          actor_email?: string
          actor_full_name?: string
          actor_user_id: string
          requested_slug?: string
          workspace_name: string
        }
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
      mark_codex_auth_reconnect_required: {
        Args: {
          reconnect_reason: string
          target_run_id: string
          target_user_id: string
        }
        Returns: undefined
      }
      next_session_number: {
        Args: { actor_user_id: string; target_workspace_id: string }
        Returns: number
      }
      persist_codex_auth_json: {
        Args: {
          new_account_email: string
          new_account_id: string
          new_auth_cache_last_refresh: string
          new_encrypted_credential: string
          previous_credential_version: number
          target_run_id: string
          target_user_id: string
        }
        Returns: {
          credential_version: number
        }[]
      }
      release_codex_auth_lease: {
        Args: { target_run_id: string; target_user_id: string }
        Returns: undefined
      }
      rewrite_default_pipeline: {
        Args: {
          pipeline_name: string
          stage_payload: Json
          target_workspace_id: string
        }
        Returns: Json
      }
      save_workspace_repository_profile: {
        Args: {
          selected_build_command: string
          selected_env_key_suggestions: string[]
          selected_framework_hints: string[]
          selected_inference_confidence: string
          selected_inference_sources: Json
          selected_install_command: string
          selected_language_hints: string[]
          selected_package_manager: string
          selected_setup_notes: string
          selected_test_command: string
          target_github_repository_id: string
          target_workspace_id: string
        }
        Returns: {
          build_command: string | null
          created_at: string
          env_key_suggestions: string[]
          framework_hints: string[]
          github_repository_id: string
          id: string
          inference_confidence: string
          inference_sources: Json
          install_command: string | null
          is_primary: boolean
          language_hints: string[]
          package_manager: string | null
          setup_notes: string
          test_command: string | null
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "workspace_repository_profiles"
          isOneToOne: true
          isSetofReturn: false
        }
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
          job_type: string
          last_error: string | null
          requested_by_member_id: string | null
          scheduled_at: string | null
          session_id: string
          stage_id: string | null
          stage_name: string | null
          stage_slug: string | null
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
      agent_job_status:
        | "queued"
        | "started"
        | "running"
        | "success"
        | "error"
        | "canceled"
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
      member_kind: "human" | "system"
      member_role: "owner" | "admin" | "member" | "agent"
      pipeline_phase_status:
        | "agent_generating"
        | "awaiting_review"
        | "approved"
        | "rejected"
      workspace_invitation_status: "pending" | "accepted" | "revoked"
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
      agent_job_status: [
        "queued",
        "started",
        "running",
        "success",
        "error",
        "canceled",
      ],
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
      ],
      member_kind: ["human", "system"],
      member_role: ["owner", "admin", "member", "agent"],
      pipeline_phase_status: [
        "agent_generating",
        "awaiting_review",
        "approved",
        "rejected",
      ],
      workspace_invitation_status: ["pending", "accepted", "revoked"],
    },
  },
} as const
