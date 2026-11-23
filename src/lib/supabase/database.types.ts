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
          claimed_worker_runtime: string | null
          created_at: string
          dedupe_key: string | null
          finished_at: string | null
          git_continuity_release_revision: number | null
          id: string
          is_repair: boolean
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
          claimed_worker_runtime?: string | null
          created_at?: string
          dedupe_key?: string | null
          finished_at?: string | null
          git_continuity_release_revision?: number | null
          id?: string
          is_repair?: boolean
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
          claimed_worker_runtime?: string | null
          created_at?: string
          dedupe_key?: string | null
          finished_at?: string | null
          git_continuity_release_revision?: number | null
          id?: string
          is_repair?: boolean
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
      agent_run_events: {
        Row: {
          agent_run_id: string
          attempt_count: number
          causation_sequence: number | null
          created_at: string
          kind: string
          payload: Json
          schema_version: number
          sequence: number
          truncated: boolean
          workspace_id: string
        }
        Insert: {
          agent_run_id: string
          attempt_count: number
          causation_sequence?: number | null
          created_at?: string
          kind: string
          payload: Json
          schema_version?: number
          sequence: number
          truncated?: boolean
          workspace_id: string
        }
        Update: {
          agent_run_id?: string
          attempt_count?: number
          causation_sequence?: number | null
          created_at?: string
          kind?: string
          payload?: Json
          schema_version?: number
          sequence?: number
          truncated?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_run_events_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_events_workspace_id_fkey"
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
      agent_run_transcript_expirations: {
        Row: {
          expired_at: string
          purged_at: string | null
          run_id: string
          workspace_id: string
        }
        Insert: {
          expired_at?: string
          purged_at?: string | null
          run_id: string
          workspace_id: string
        }
        Update: {
          expired_at?: string
          purged_at?: string | null
          run_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_run_transcript_expirations_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_transcript_expirations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent_id: string
          agent_job_id: string | null
          agent_prompt_revision_id: string
          attempt_count: number | null
          branch_name: string | null
          cost_provenance: string
          created_at: string
          execution_policy_revision_id: string | null
          finished_at: string | null
          id: string
          input_tokens: number | null
          last_activity_at: string | null
          model_name: string
          model_provider: string
          output_tokens: number | null
          run_type: string
          sandbox_connection_revision: string | null
          sandbox_id: string | null
          sandbox_provider: string | null
          sandbox_vercel_project_id: string | null
          sandbox_vercel_team_id: string | null
          session_id: string
          source_recovery_required: boolean
          stage_id: string | null
          stage_name: string | null
          stage_slug: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["agent_run_status"]
          token_provenance: string
          total_cost_usd: number | null
          triggered_by_member_id: string | null
          updated_at: string
          usage_estimation_revision: string | null
          usage_finalized_at: string | null
          usage_recorded_at: string | null
          usage_unavailable_reason: string | null
          workspace_id: string
        }
        Insert: {
          agent_id: string
          agent_job_id?: string | null
          agent_prompt_revision_id: string
          attempt_count?: number | null
          branch_name?: string | null
          cost_provenance?: string
          created_at?: string
          execution_policy_revision_id?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          last_activity_at?: string | null
          model_name: string
          model_provider: string
          output_tokens?: number | null
          run_type: string
          sandbox_connection_revision?: string | null
          sandbox_id?: string | null
          sandbox_provider?: string | null
          sandbox_vercel_project_id?: string | null
          sandbox_vercel_team_id?: string | null
          session_id: string
          source_recovery_required?: boolean
          stage_id?: string | null
          stage_name?: string | null
          stage_slug?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_run_status"]
          token_provenance?: string
          total_cost_usd?: number | null
          triggered_by_member_id?: string | null
          updated_at?: string
          usage_estimation_revision?: string | null
          usage_finalized_at?: string | null
          usage_recorded_at?: string | null
          usage_unavailable_reason?: string | null
          workspace_id: string
        }
        Update: {
          agent_id?: string
          agent_job_id?: string | null
          agent_prompt_revision_id?: string
          attempt_count?: number | null
          branch_name?: string | null
          cost_provenance?: string
          created_at?: string
          execution_policy_revision_id?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          last_activity_at?: string | null
          model_name?: string
          model_provider?: string
          output_tokens?: number | null
          run_type?: string
          sandbox_connection_revision?: string | null
          sandbox_id?: string | null
          sandbox_provider?: string | null
          sandbox_vercel_project_id?: string | null
          sandbox_vercel_team_id?: string | null
          session_id?: string
          source_recovery_required?: boolean
          stage_id?: string | null
          stage_name?: string | null
          stage_slug?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_run_status"]
          token_provenance?: string
          total_cost_usd?: number | null
          triggered_by_member_id?: string | null
          updated_at?: string
          usage_estimation_revision?: string | null
          usage_finalized_at?: string | null
          usage_recorded_at?: string | null
          usage_unavailable_reason?: string | null
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
            foreignKeyName: "agent_runs_agent_job_id_fkey"
            columns: ["agent_job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "agent_runs_agent_prompt_revision_fkey"
            columns: ["workspace_id", "agent_id", "agent_prompt_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_agent_prompt_revisions"
            referencedColumns: ["workspace_id", "agent_id", "id"]
          },
          {
            foreignKeyName: "agent_runs_execution_policy_revision_id_fkey"
            columns: ["execution_policy_revision_id"]
            isOneToOne: false
            referencedRelation: "execution_policy_revisions"
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
      artifact_feedback_batch_jobs: {
        Row: {
          batch_id: string
          created_at: string
          job_id: string
          session_id: string
          workspace_id: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          job_id: string
          session_id: string
          workspace_id: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          job_id?: string
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifact_feedback_batch_jobs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_jobs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_jobs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_jobs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      artifact_feedback_batch_threads: {
        Row: {
          anchor: Json
          artifact_id: string
          batch_id: string
          comments: Json
          created_at: string
          kind: string
          session_id: string
          thread_id: string
          thread_revision: number
          workspace_id: string
        }
        Insert: {
          anchor: Json
          artifact_id: string
          batch_id: string
          comments: Json
          created_at?: string
          kind: string
          session_id: string
          thread_id: string
          thread_revision: number
          workspace_id: string
        }
        Update: {
          anchor?: Json
          artifact_id?: string
          batch_id?: string
          comments?: Json
          created_at?: string
          kind?: string
          session_id?: string
          thread_id?: string
          thread_revision?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifact_feedback_batch_threads_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "session_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_threads_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_threads_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_threads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      artifact_feedback_batches: {
        Row: {
          actor_label: string
          artifact_id: string
          artifact_version: number
          checkpoint_run_id: string | null
          created_at: string
          id: string
          job_created: boolean
          job_id: string | null
          rejection_count: number
          rendered_feedback_text: string
          request_hash: string
          request_id: string
          requested_by_member_id: string | null
          requested_by_service_principal_id: string | null
          review_revision: number
          run_id: string | null
          selected_thread_ids: string[]
          session_id: string
          stage_id: string
          whole_stage_feedback: string
          workspace_id: string
        }
        Insert: {
          actor_label: string
          artifact_id: string
          artifact_version: number
          checkpoint_run_id?: string | null
          created_at?: string
          id?: string
          job_created: boolean
          job_id?: string | null
          rejection_count: number
          rendered_feedback_text: string
          request_hash?: string
          request_id: string
          requested_by_member_id?: string | null
          requested_by_service_principal_id?: string | null
          review_revision: number
          run_id?: string | null
          selected_thread_ids: string[]
          session_id: string
          stage_id: string
          whole_stage_feedback: string
          workspace_id: string
        }
        Update: {
          actor_label?: string
          artifact_id?: string
          artifact_version?: number
          checkpoint_run_id?: string | null
          created_at?: string
          id?: string
          job_created?: boolean
          job_id?: string | null
          rejection_count?: number
          rendered_feedback_text?: string
          request_hash?: string
          request_id?: string
          requested_by_member_id?: string | null
          requested_by_service_principal_id?: string | null
          review_revision?: number
          run_id?: string | null
          selected_thread_ids?: string[]
          session_id?: string
          stage_id?: string
          whole_stage_feedback?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifact_feedback_batches_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "session_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batches_checkpoint_run_id_fkey"
            columns: ["checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_outputs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "artifact_feedback_batches_checkpoint_run_id_fkey"
            columns: ["checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "session_git_checkpoints"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "artifact_feedback_batches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "artifact_feedback_batches_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batches_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batches_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      artifact_review_comments: {
        Row: {
          author_label: string
          author_member_id: string
          body: string
          created_at: string
          id: string
          revision: number
          thread_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          author_label: string
          author_member_id: string
          body: string
          created_at?: string
          id?: string
          revision?: number
          thread_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          author_label?: string
          author_member_id?: string
          body?: string
          created_at?: string
          id?: string
          revision?: number
          thread_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifact_review_comments_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "artifact_review_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_review_comments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      artifact_review_events: {
        Row: {
          actor_label: string
          actor_member_id: string
          created_at: string
          detail: Json
          event_type: string
          id: string
          review_revision: number
          thread_id: string
          workspace_id: string
        }
        Insert: {
          actor_label: string
          actor_member_id: string
          created_at?: string
          detail: Json
          event_type: string
          id?: string
          review_revision: number
          thread_id: string
          workspace_id: string
        }
        Update: {
          actor_label?: string
          actor_member_id?: string
          created_at?: string
          detail?: Json
          event_type?: string
          id?: string
          review_revision?: number
          thread_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifact_review_events_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "artifact_review_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_review_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      artifact_review_threads: {
        Row: {
          anchor: Json
          artifact_id: string
          artifact_version: number
          author_label: string
          author_member_id: string
          created_at: string
          id: string
          kind: string
          revision: number
          session_id: string
          stage_id: string
          stage_slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          anchor: Json
          artifact_id: string
          artifact_version: number
          author_label: string
          author_member_id: string
          created_at?: string
          id?: string
          kind: string
          revision?: number
          session_id: string
          stage_id: string
          stage_slug: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          anchor?: Json
          artifact_id?: string
          artifact_version?: number
          author_label?: string
          author_member_id?: string
          created_at?: string
          id?: string
          kind?: string
          revision?: number
          session_id?: string
          stage_id?: string
          stage_slug?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifact_review_threads_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "session_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_review_threads_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_review_threads_workspace_id_fkey"
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
          sandbox_connection_revision: string | null
          sandbox_id: string
          sandbox_provider: string | null
          status: string
          updated_at: string
          user_code: string | null
          user_id: string
          verification_uri: string | null
          workspace_id: string | null
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
          sandbox_connection_revision?: string | null
          sandbox_id: string
          sandbox_provider?: string | null
          status?: string
          updated_at?: string
          user_code?: string | null
          user_id: string
          verification_uri?: string | null
          workspace_id?: string | null
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
          sandbox_connection_revision?: string | null
          sandbox_id?: string
          sandbox_provider?: string | null
          status?: string
          updated_at?: string
          user_code?: string | null
          user_id?: string
          verification_uri?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "codex_device_auth_flows_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      cursor_auth_flows: {
        Row: {
          canceled_at: string | null
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          expires_at: string
          id: string
          login_url: string | null
          status: string
          updated_at: string
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          canceled_at?: string | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          expires_at?: string
          id?: string
          login_url?: string | null
          status?: string
          updated_at?: string
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          canceled_at?: string | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          expires_at?: string
          id?: string
          login_url?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cursor_auth_flows_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_policies: {
        Row: {
          current_revision_id: string
          pipeline_id: string
          revision: number
          workspace_id: string
        }
        Insert: {
          current_revision_id: string
          pipeline_id: string
          revision: number
          workspace_id: string
        }
        Update: {
          current_revision_id?: string
          pipeline_id?: string
          revision?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_policies_current_revision_id_fkey"
            columns: ["current_revision_id"]
            isOneToOne: false
            referencedRelation: "delivery_policy_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_policies_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: true
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_policies_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_policy_revisions: {
        Row: {
          created_at: string
          created_by: string
          id: string
          pipeline_id: string
          requirements: Json
          revision: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          pipeline_id: string
          requirements: Json
          revision: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          pipeline_id?: string
          requirements?: Json
          revision?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_policy_revisions_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_policy_revisions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      execution_policies: {
        Row: {
          current_revision_id: string
          revision: number
          workspace_id: string
        }
        Insert: {
          current_revision_id: string
          revision: number
          workspace_id: string
        }
        Update: {
          current_revision_id?: string
          revision?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "execution_policies_current_revision_id_fkey"
            columns: ["current_revision_id"]
            isOneToOne: false
            referencedRelation: "execution_policy_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "execution_policies_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      execution_policy_revisions: {
        Row: {
          created_at: string
          created_by: string
          id: string
          requirements: Json
          revision: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          requirements: Json
          revision: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          requirements?: Json
          revision?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "execution_policy_revisions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      factories: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          archived_reason: string | null
          created_at: string
          id: string
          is_default: boolean
          name: string
          slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          archived_reason?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          slug: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          archived_reason?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          slug?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factories_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factories_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      factory_agent_prompt_revisions: {
        Row: {
          agent_id: string
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          prompt_md: string
          prompt_sha256: string
          revision_number: number
          workspace_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          created_by?: string | null
          factory_id: string
          id?: string
          prompt_md: string
          prompt_sha256: string
          revision_number: number
          workspace_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          created_by?: string | null
          factory_id?: string
          id?: string
          prompt_md?: string
          prompt_sha256?: string
          revision_number?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_agent_prompt_revision_workspace_id_factory_id_agen_fkey"
            columns: ["workspace_id", "factory_id", "agent_id"]
            isOneToOne: false
            referencedRelation: "factory_agents"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_agents: {
        Row: {
          authority: string
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          is_default: boolean
          name: string
          slug: string
          workspace_id: string
        }
        Insert: {
          authority?: string
          created_at?: string
          created_by?: string | null
          factory_id: string
          id?: string
          is_default?: boolean
          name: string
          slug: string
          workspace_id: string
        }
        Update: {
          authority?: string
          created_at?: string
          created_by?: string | null
          factory_id?: string
          id?: string
          is_default?: boolean
          name?: string
          slug?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_agents_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_audit_events: {
        Row: {
          action: string
          actor_member_id: string | null
          created_at: string
          detail: Json
          factory_id: string
          id: number
          subject_member_id: string | null
          workspace_id: string
        }
        Insert: {
          action: string
          actor_member_id?: string | null
          created_at?: string
          detail?: Json
          factory_id: string
          id?: never
          subject_member_id?: string | null
          workspace_id: string
        }
        Update: {
          action?: string
          actor_member_id?: string | null
          created_at?: string
          detail?: Json
          factory_id?: string
          id?: never
          subject_member_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_audit_events_actor_member_id_fkey"
            columns: ["actor_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_audit_events_subject_member_id_fkey"
            columns: ["subject_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_audit_events_workspace_factory_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_benchmark_evaluation_dimensions: {
        Row: {
          experiment_id: string
          factory_id: string
          scorer_revision_id: string
          workspace_id: string
        }
        Insert: {
          experiment_id: string
          factory_id: string
          scorer_revision_id: string
          workspace_id: string
        }
        Update: {
          experiment_id?: string
          factory_id?: string
          scorer_revision_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_evaluation__workspace_id_factory_id_scor_fkey"
            columns: ["workspace_id", "factory_id", "scorer_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_scorer_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_evaluation_workspace_id_factory_id_expe_fkey1"
            columns: ["workspace_id", "factory_id", "experiment_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_evaluation_plans"
            referencedColumns: ["workspace_id", "factory_id", "experiment_id"]
          },
        ]
      }
      factory_benchmark_evaluation_plans: {
        Row: {
          budget_limit_usd: number
          created_at: string
          created_by: string
          experiment_id: string
          factory_id: string
          workspace_id: string
        }
        Insert: {
          budget_limit_usd: number
          created_at?: string
          created_by: string
          experiment_id: string
          factory_id: string
          workspace_id: string
        }
        Update: {
          budget_limit_usd?: number
          created_at?: string
          created_by?: string
          experiment_id?: string
          factory_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_evaluation__workspace_id_factory_id_expe_fkey"
            columns: ["workspace_id", "factory_id", "experiment_id"]
            isOneToOne: true
            referencedRelation: "factory_benchmark_experiments"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_experiment_candidates: {
        Row: {
          candidate_key: string
          canonical_model_key: string | null
          comparison_position: number | null
          definition_digest: string
          definition_revision_id: string
          experiment_id: string
          factory_id: string
          harness: string
          live_inference_connection_revision: string | null
          model: string
          qualification_id: string | null
          sandbox_connection_revision: string | null
          sandbox_provider: string
          toolchain: string | null
          toolchain_digest: string | null
          worker_runtime: string
          workspace_id: string
        }
        Insert: {
          candidate_key: string
          canonical_model_key?: string | null
          comparison_position?: number | null
          definition_digest: string
          definition_revision_id: string
          experiment_id: string
          factory_id: string
          harness: string
          live_inference_connection_revision?: string | null
          model: string
          qualification_id?: string | null
          sandbox_connection_revision?: string | null
          sandbox_provider: string
          toolchain?: string | null
          toolchain_digest?: string | null
          worker_runtime: string
          workspace_id: string
        }
        Update: {
          candidate_key?: string
          canonical_model_key?: string | null
          comparison_position?: number | null
          definition_digest?: string
          definition_revision_id?: string
          experiment_id?: string
          factory_id?: string
          harness?: string
          live_inference_connection_revision?: string | null
          model?: string
          qualification_id?: string | null
          sandbox_connection_revision?: string | null
          sandbox_provider?: string
          toolchain?: string | null
          toolchain_digest?: string | null
          worker_runtime?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_experiment__workspace_id_factory_id_defi_fkey"
            columns: ["workspace_id", "factory_id", "definition_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_definition_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_experiment__workspace_id_factory_id_expe_fkey"
            columns: ["workspace_id", "factory_id", "experiment_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_experiments"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_experiment_trials: {
        Row: {
          candidate_key: string
          eligibility_reason: string | null
          experiment_id: string
          factory_id: string
          repetition: number
          replay_eligibility: string
          seed: number
          task_id: string
          task_revision_id: string
          timeout_ms: number
          trial_id: string
          workspace_id: string
        }
        Insert: {
          candidate_key: string
          eligibility_reason?: string | null
          experiment_id: string
          factory_id: string
          repetition: number
          replay_eligibility: string
          seed: number
          task_id: string
          task_revision_id: string
          timeout_ms: number
          trial_id: string
          workspace_id: string
        }
        Update: {
          candidate_key?: string
          eligibility_reason?: string | null
          experiment_id?: string
          factory_id?: string
          repetition?: number
          replay_eligibility?: string
          seed?: number
          task_id?: string
          task_revision_id?: string
          timeout_ms?: number
          trial_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_experiment__workspace_id_factory_id_task_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "task_id",
              "task_revision_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_benchmark_task_revisions"
            referencedColumns: ["workspace_id", "factory_id", "task_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_experiment_workspace_id_factory_id_expe_fkey1"
            columns: [
              "workspace_id",
              "factory_id",
              "experiment_id",
              "candidate_key",
            ]
            isOneToOne: false
            referencedRelation: "factory_benchmark_experiment_candidates"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "experiment_id",
              "candidate_key",
            ]
          },
        ]
      }
      factory_benchmark_experiments: {
        Row: {
          candidate_count: number
          created_at: string
          created_by: string
          eligible_trial_count: number
          expected_trial_count: number
          factory_id: string
          id: string
          ineligible_trial_count: number
          materialized_trial_count: number
          policy_digest: string
          policy_revision_id: string
          repetitions: number
          request_digest: string
          seed: number
          suite_revision_id: string
          task_count: number
          timeout_ms: number
          workspace_id: string
        }
        Insert: {
          candidate_count: number
          created_at?: string
          created_by: string
          eligible_trial_count: number
          expected_trial_count: number
          factory_id: string
          id: string
          ineligible_trial_count: number
          materialized_trial_count: number
          policy_digest: string
          policy_revision_id: string
          repetitions: number
          request_digest: string
          seed: number
          suite_revision_id: string
          task_count: number
          timeout_ms: number
          workspace_id: string
        }
        Update: {
          candidate_count?: number
          created_at?: string
          created_by?: string
          eligible_trial_count?: number
          expected_trial_count?: number
          factory_id?: string
          id?: string
          ineligible_trial_count?: number
          materialized_trial_count?: number
          policy_digest?: string
          policy_revision_id?: string
          repetitions?: number
          request_digest?: string
          seed?: number
          suite_revision_id?: string
          task_count?: number
          timeout_ms?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_experiments_workspace_id_factory_id_poli_fkey"
            columns: ["workspace_id", "factory_id", "policy_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_replay_policy_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_experiments_workspace_id_factory_id_suit_fkey"
            columns: ["workspace_id", "factory_id", "suite_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_suite_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_replay_executions: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          policy_digest: string
          policy_revision_id: string
          profile: Database["public"]["Enums"]["benchmark_replay_profile"]
          restoration_receipt_sha256: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          id: string
          policy_digest: string
          policy_revision_id: string
          profile: Database["public"]["Enums"]["benchmark_replay_profile"]
          restoration_receipt_sha256: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          policy_digest?: string
          policy_revision_id?: string
          profile?: Database["public"]["Enums"]["benchmark_replay_profile"]
          restoration_receipt_sha256?: string
          task_id?: string
          task_revision_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_replay_exec_workspace_id_factory_id_poli_fkey"
            columns: ["workspace_id", "factory_id", "policy_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_replay_policy_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_replay_exec_workspace_id_factory_id_task_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "task_id",
              "task_revision_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_benchmark_task_revisions"
            referencedColumns: ["workspace_id", "factory_id", "task_id", "id"]
          },
        ]
      }
      factory_benchmark_replay_fixture_revisions: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          fixture_key: string
          id: string
          operation: Database["public"]["Enums"]["benchmark_replay_operation"]
          response_json: string
          response_sha256: string
          revision_number: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          fixture_key: string
          id?: string
          operation: Database["public"]["Enums"]["benchmark_replay_operation"]
          response_json: string
          response_sha256: string
          revision_number: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          fixture_key?: string
          id?: string
          operation?: Database["public"]["Enums"]["benchmark_replay_operation"]
          response_json?: string
          response_sha256?: string
          revision_number?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_replay_fixture_r_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_benchmark_replay_operations: {
        Row: {
          created_at: string
          decision: string
          execution_id: string
          factory_id: string
          fixture_key: string | null
          fixture_response_sha256: string | null
          fixture_revision_id: string | null
          operation: Database["public"]["Enums"]["benchmark_replay_operation"]
          operation_id: string
          reason: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          decision: string
          execution_id: string
          factory_id: string
          fixture_key?: string | null
          fixture_response_sha256?: string | null
          fixture_revision_id?: string | null
          operation: Database["public"]["Enums"]["benchmark_replay_operation"]
          operation_id: string
          reason: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          decision?: string
          execution_id?: string
          factory_id?: string
          fixture_key?: string | null
          fixture_response_sha256?: string | null
          fixture_revision_id?: string | null
          operation?: Database["public"]["Enums"]["benchmark_replay_operation"]
          operation_id?: string
          reason?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_replay_oper_workspace_id_factory_id_exec_fkey"
            columns: ["workspace_id", "factory_id", "execution_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_replay_executions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_replay_oper_workspace_id_factory_id_fixt_fkey"
            columns: ["workspace_id", "factory_id", "fixture_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_replay_fixture_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_replay_policy_revisions: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          policy_digest: string
          profile: Database["public"]["Enums"]["benchmark_replay_profile"]
          revision_number: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          id?: string
          policy_digest: string
          profile: Database["public"]["Enums"]["benchmark_replay_profile"]
          revision_number: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          policy_digest?: string
          profile?: Database["public"]["Enums"]["benchmark_replay_profile"]
          revision_number?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_replay_policy_re_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_benchmark_schedule_evaluations: {
        Row: {
          accounted_at: string | null
          actual_usd: number | null
          attempt_id: string
          cost_provenance: string | null
          reserve_usd: number
          trial_id: string
        }
        Insert: {
          accounted_at?: string | null
          actual_usd?: number | null
          attempt_id: string
          cost_provenance?: string | null
          reserve_usd: number
          trial_id: string
        }
        Update: {
          accounted_at?: string | null
          actual_usd?: number | null
          attempt_id?: string
          cost_provenance?: string | null
          reserve_usd?: number
          trial_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_schedule_evaluations_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: true
            referencedRelation: "factory_evaluation_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_benchmark_schedule_evaluations_trial_id_fkey"
            columns: ["trial_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_schedule_trials"
            referencedColumns: ["trial_id"]
          },
        ]
      }
      factory_benchmark_schedule_trials: {
        Row: {
          accounted_at: string | null
          actual_usd: number | null
          cost_provenance: string | null
          experiment_id: string
          factory_id: string
          reserve_usd: number
          run_id: string
          trial_id: string
          workspace_id: string
        }
        Insert: {
          accounted_at?: string | null
          actual_usd?: number | null
          cost_provenance?: string | null
          experiment_id: string
          factory_id: string
          reserve_usd: number
          run_id: string
          trial_id: string
          workspace_id: string
        }
        Update: {
          accounted_at?: string | null
          actual_usd?: number | null
          cost_provenance?: string | null
          experiment_id?: string
          factory_id?: string
          reserve_usd?: number
          run_id?: string
          trial_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_schedule_tr_workspace_id_factory_id_expe_fkey"
            columns: ["workspace_id", "factory_id", "experiment_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_schedules"
            referencedColumns: ["workspace_id", "factory_id", "experiment_id"]
          },
          {
            foreignKeyName: "factory_benchmark_schedule_tr_workspace_id_factory_id_tria_fkey"
            columns: ["workspace_id", "factory_id", "trial_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_trials"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_schedule_trials_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_benchmark_schedule_trials_trial_id_fkey"
            columns: ["trial_id"]
            isOneToOne: true
            referencedRelation: "factory_benchmark_experiment_trials"
            referencedColumns: ["trial_id"]
          },
        ]
      }
      factory_benchmark_schedules: {
        Row: {
          actor_user_id: string
          admission_issue: string | null
          budget_limit_usd: number
          created_at: string
          evaluation_reserve_usd: number
          execution_reserve_usd: number
          experiment_id: string
          factory_concurrency_limit: number
          factory_id: string
          inference_connection_revision: string | null
          last_reconciled_at: string | null
          max_admitted_trials: number
          runner_revision: string
          sandbox_connection_revision: string
          state: string
          task_fixtures: Json
          workspace_id: string
        }
        Insert: {
          actor_user_id: string
          admission_issue?: string | null
          budget_limit_usd: number
          created_at?: string
          evaluation_reserve_usd: number
          execution_reserve_usd: number
          experiment_id: string
          factory_concurrency_limit: number
          factory_id: string
          inference_connection_revision?: string | null
          last_reconciled_at?: string | null
          max_admitted_trials: number
          runner_revision: string
          sandbox_connection_revision: string
          state?: string
          task_fixtures: Json
          workspace_id: string
        }
        Update: {
          actor_user_id?: string
          admission_issue?: string | null
          budget_limit_usd?: number
          created_at?: string
          evaluation_reserve_usd?: number
          execution_reserve_usd?: number
          experiment_id?: string
          factory_concurrency_limit?: number
          factory_id?: string
          inference_connection_revision?: string | null
          last_reconciled_at?: string | null
          max_admitted_trials?: number
          runner_revision?: string
          sandbox_connection_revision?: string
          state?: string
          task_fixtures?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_schedules_workspace_id_factory_id_experi_fkey"
            columns: ["workspace_id", "factory_id", "experiment_id"]
            isOneToOne: true
            referencedRelation: "factory_benchmark_experiments"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_suite_members: {
        Row: {
          factory_id: string
          suite_revision_id: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        Insert: {
          factory_id: string
          suite_revision_id: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        Update: {
          factory_id?: string
          suite_revision_id?: string
          task_id?: string
          task_revision_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_suite_membe_workspace_id_factory_id_suit_fkey"
            columns: ["workspace_id", "factory_id", "suite_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_suite_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_suite_membe_workspace_id_factory_id_task_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "task_id",
              "task_revision_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_benchmark_task_revisions"
            referencedColumns: ["workspace_id", "factory_id", "task_id", "id"]
          },
        ]
      }
      factory_benchmark_suite_revisions: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          name: string
          purpose: string
          revision_number: number
          selection_tags: string[] | null
          suite_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          id?: string
          name: string
          purpose: string
          revision_number: number
          selection_tags?: string[] | null
          suite_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          name?: string
          purpose?: string
          revision_number?: number
          selection_tags?: string[] | null
          suite_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_suite_revis_workspace_id_factory_id_suit_fkey"
            columns: ["workspace_id", "factory_id", "suite_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_suites"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_suites: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          id?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_suites_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_benchmark_task_inputs: {
        Row: {
          checkout_sha: string | null
          context_manifest_sha256: string | null
          context_origin_run_id: string | null
          created_at: string
          definition_digest: string | null
          definition_revision_id: string | null
          factory_id: string
          input_ref: string | null
          input_sha: string | null
          original_prompt_sha256: string | null
          rendered_prompt_sha256: string | null
          renderer_version: number | null
          repository_id: string | null
          retry_bundle_sha256: string | null
          retry_source_run_id: string | null
          source_attempt_count: number | null
          source_checkpoint_run_id: string | null
          source_job_id: string | null
          source_run_id: string
          source_session_id: string
          task_id: string
          workspace_id: string
        }
        Insert: {
          checkout_sha?: string | null
          context_manifest_sha256?: string | null
          context_origin_run_id?: string | null
          created_at?: string
          definition_digest?: string | null
          definition_revision_id?: string | null
          factory_id: string
          input_ref?: string | null
          input_sha?: string | null
          original_prompt_sha256?: string | null
          rendered_prompt_sha256?: string | null
          renderer_version?: number | null
          repository_id?: string | null
          retry_bundle_sha256?: string | null
          retry_source_run_id?: string | null
          source_attempt_count?: number | null
          source_checkpoint_run_id?: string | null
          source_job_id?: string | null
          source_run_id: string
          source_session_id: string
          task_id: string
          workspace_id: string
        }
        Update: {
          checkout_sha?: string | null
          context_manifest_sha256?: string | null
          context_origin_run_id?: string | null
          created_at?: string
          definition_digest?: string | null
          definition_revision_id?: string | null
          factory_id?: string
          input_ref?: string | null
          input_sha?: string | null
          original_prompt_sha256?: string | null
          rendered_prompt_sha256?: string | null
          renderer_version?: number | null
          repository_id?: string | null
          retry_bundle_sha256?: string | null
          retry_source_run_id?: string | null
          source_attempt_count?: number | null
          source_checkpoint_run_id?: string | null
          source_job_id?: string | null
          source_run_id?: string
          source_session_id?: string
          task_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_task_inputs_workspace_id_factory_id_task_fkey"
            columns: ["workspace_id", "factory_id", "task_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_tasks"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_task_revisions: {
        Row: {
          acceptance_criteria: string
          created_at: string
          created_by: string
          eligibility_reason: string | null
          factory_id: string
          id: string
          name: string
          replay_eligibility: string
          revision_number: number
          tags: string[]
          task_id: string
          workspace_id: string
        }
        Insert: {
          acceptance_criteria: string
          created_at?: string
          created_by: string
          eligibility_reason?: string | null
          factory_id: string
          id?: string
          name: string
          replay_eligibility: string
          revision_number: number
          tags: string[]
          task_id: string
          workspace_id: string
        }
        Update: {
          acceptance_criteria?: string
          created_at?: string
          created_by?: string
          eligibility_reason?: string | null
          factory_id?: string
          id?: string
          name?: string
          replay_eligibility?: string
          revision_number?: number
          tags?: string[]
          task_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_task_revisi_workspace_id_factory_id_task_fkey"
            columns: ["workspace_id", "factory_id", "task_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_tasks"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_tasks: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          source_provenance: Json
          source_run_id: string
          source_session_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          id?: string
          source_provenance: Json
          source_run_id: string
          source_session_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          source_provenance?: Json
          source_run_id?: string
          source_session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_tasks_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_benchmark_trial_results: {
        Row: {
          artifact_markdown: string
          artifact_sha256: string
          checkpoint_bundle_sha256: string
          checkpoint_storage_path: string
          created_at: string
          factory_id: string
          fixture_operation_id: string | null
          fixture_response_sha256: string | null
          fixture_revision_id: string | null
          inference_receipt_id: string | null
          input_bundle_sha256: string
          input_commit_sha: string
          input_tree_sha: string
          output_commit_sha: string
          output_tree_sha: string
          renderer_revision: string | null
          replay_execution_id: string
          replay_prompt_sha256: string | null
          restoration_receipt_sha256: string
          result_digest: string
          run_id: string
          runtime: string
          trial_id: string
          validation: Json
          workspace_id: string
        }
        Insert: {
          artifact_markdown: string
          artifact_sha256: string
          checkpoint_bundle_sha256: string
          checkpoint_storage_path: string
          created_at?: string
          factory_id: string
          fixture_operation_id?: string | null
          fixture_response_sha256?: string | null
          fixture_revision_id?: string | null
          inference_receipt_id?: string | null
          input_bundle_sha256: string
          input_commit_sha: string
          input_tree_sha: string
          output_commit_sha: string
          output_tree_sha: string
          renderer_revision?: string | null
          replay_execution_id: string
          replay_prompt_sha256?: string | null
          restoration_receipt_sha256: string
          result_digest: string
          run_id: string
          runtime: string
          trial_id: string
          validation: Json
          workspace_id: string
        }
        Update: {
          artifact_markdown?: string
          artifact_sha256?: string
          checkpoint_bundle_sha256?: string
          checkpoint_storage_path?: string
          created_at?: string
          factory_id?: string
          fixture_operation_id?: string | null
          fixture_response_sha256?: string | null
          fixture_revision_id?: string | null
          inference_receipt_id?: string | null
          input_bundle_sha256?: string
          input_commit_sha?: string
          input_tree_sha?: string
          output_commit_sha?: string
          output_tree_sha?: string
          renderer_revision?: string | null
          replay_execution_id?: string
          replay_prompt_sha256?: string | null
          restoration_receipt_sha256?: string
          result_digest?: string
          run_id?: string
          runtime?: string
          trial_id?: string
          validation?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_trial_resul_replay_execution_id_fixture__fkey"
            columns: ["replay_execution_id", "fixture_operation_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_replay_operations"
            referencedColumns: ["execution_id", "operation_id"]
          },
          {
            foreignKeyName: "factory_benchmark_trial_resul_workspace_id_factory_id_tria_fkey"
            columns: ["workspace_id", "factory_id", "trial_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_trials"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_benchmark_trials: {
        Row: {
          actor_user_id: string
          attempt_count: number | null
          created_at: string
          deadline_at: string | null
          effective_execution_digest: string | null
          factory_id: string
          failure_code: string | null
          finished_at: string | null
          fixture_key: string | null
          fixture_revision_id: string | null
          id: string
          inference_connection_revision: string | null
          job_id: string
          policy_digest: string
          policy_revision_id: string
          replay_execution_id: string
          run_id: string
          runner_revision: string
          sandbox_connection_revision: string
          session_id: string
          status: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id: string
          attempt_count?: number | null
          created_at?: string
          deadline_at?: string | null
          effective_execution_digest?: string | null
          factory_id: string
          failure_code?: string | null
          finished_at?: string | null
          fixture_key?: string | null
          fixture_revision_id?: string | null
          id: string
          inference_connection_revision?: string | null
          job_id: string
          policy_digest: string
          policy_revision_id: string
          replay_execution_id?: string
          run_id: string
          runner_revision?: string
          sandbox_connection_revision: string
          session_id: string
          status?: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string
          attempt_count?: number | null
          created_at?: string
          deadline_at?: string | null
          effective_execution_digest?: string | null
          factory_id?: string
          failure_code?: string | null
          finished_at?: string | null
          fixture_key?: string | null
          fixture_revision_id?: string | null
          id?: string
          inference_connection_revision?: string | null
          job_id?: string
          policy_digest?: string
          policy_revision_id?: string
          replay_execution_id?: string
          run_id?: string
          runner_revision?: string
          sandbox_connection_revision?: string
          session_id?: string
          status?: string
          task_id?: string
          task_revision_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_benchmark_trials_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_benchmark_trials_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "factory_benchmark_trials_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_benchmark_trials_session_id_workspace_id_factory_i_fkey"
            columns: ["session_id", "workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id", "workspace_id", "factory_id"]
          },
          {
            foreignKeyName: "factory_benchmark_trials_workspace_id_factory_id_fixture_r_fkey"
            columns: ["workspace_id", "factory_id", "fixture_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_replay_fixture_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_trials_workspace_id_factory_id_policy_re_fkey"
            columns: ["workspace_id", "factory_id", "policy_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_replay_policy_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_benchmark_trials_workspace_id_factory_id_task_id_t_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "task_id",
              "task_revision_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_benchmark_task_revisions"
            referencedColumns: ["workspace_id", "factory_id", "task_id", "id"]
          },
        ]
      }
      factory_context_source_revisions: {
        Row: {
          content: string | null
          content_bytes: number
          content_purged_at: string | null
          content_sha256: string
          created_at: string
          factory_id: string
          id: string
          media_type: string
          source_id: string
          upstream_revision: string
          upstream_updated_at: string
          workspace_id: string
        }
        Insert: {
          content?: string | null
          content_bytes: number
          content_purged_at?: string | null
          content_sha256: string
          created_at?: string
          factory_id: string
          id?: string
          media_type: string
          source_id: string
          upstream_revision: string
          upstream_updated_at: string
          workspace_id: string
        }
        Update: {
          content?: string | null
          content_bytes?: number
          content_purged_at?: string | null
          content_sha256?: string
          created_at?: string
          factory_id?: string
          id?: string
          media_type?: string
          source_id?: string
          upstream_revision?: string
          upstream_updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_context_source_revisi_workspace_id_factory_id_sour_fkey"
            columns: ["workspace_id", "factory_id", "source_id"]
            isOneToOne: false
            referencedRelation: "factory_context_sources"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_context_sources: {
        Row: {
          created_at: string
          current_revision_id: string | null
          deleted_at: string | null
          factory_id: string
          file_path: string
          github_installation_id: string
          grant_id: string
          grant_version: number
          id: string
          last_successful_sync_at: string | null
          last_sync_attempt_at: string | null
          repository_id: string
          status: string
          sync_lease_expires_at: string | null
          sync_lease_id: string | null
          upstream_repository_id: number
          upstream_revision: string | null
          upstream_updated_at: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          current_revision_id?: string | null
          deleted_at?: string | null
          factory_id: string
          file_path: string
          github_installation_id: string
          grant_id: string
          grant_version: number
          id?: string
          last_successful_sync_at?: string | null
          last_sync_attempt_at?: string | null
          repository_id: string
          status?: string
          sync_lease_expires_at?: string | null
          sync_lease_id?: string | null
          upstream_repository_id: number
          upstream_revision?: string | null
          upstream_updated_at?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          current_revision_id?: string | null
          deleted_at?: string | null
          factory_id?: string
          file_path?: string
          github_installation_id?: string
          grant_id?: string
          grant_version?: number
          id?: string
          last_successful_sync_at?: string | null
          last_sync_attempt_at?: string | null
          repository_id?: string
          status?: string
          sync_lease_expires_at?: string | null
          sync_lease_id?: string | null
          upstream_repository_id?: number
          upstream_revision?: string | null
          upstream_updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_context_sources_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "factory_context_sources_workspace_id_factory_id_id_current_fkey"
            columns: ["workspace_id", "factory_id", "id", "current_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_context_source_revisions"
            referencedColumns: ["workspace_id", "factory_id", "source_id", "id"]
          },
        ]
      }
      factory_definition_activations: {
        Row: {
          activation_number: number
          created_at: string
          created_by: string
          factory_id: string
          id: string
          previous_activation_number: number | null
          revision_id: string
          workspace_id: string
        }
        Insert: {
          activation_number: number
          created_at?: string
          created_by: string
          factory_id: string
          id?: string
          previous_activation_number?: number | null
          revision_id: string
          workspace_id: string
        }
        Update: {
          activation_number?: number
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          previous_activation_number?: number | null
          revision_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_definition_activation_workspace_id_factory_id_prev_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "previous_activation_number",
            ]
            isOneToOne: false
            referencedRelation: "factory_definition_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "factory_definition_activation_workspace_id_factory_id_revi_fkey"
            columns: ["workspace_id", "factory_id", "revision_id"]
            isOneToOne: false
            referencedRelation: "factory_definition_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_definition_activations_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_definition_drafts: {
        Row: {
          base_activation_number: number | null
          canonical_digest: string
          created_at: string
          created_by: string
          definition_json: string
          factory_id: string
          id: string
          routing_evidence_source_draft_id: string | null
          schema_version: number
          settings_metadata: Json
          workspace_id: string
        }
        Insert: {
          base_activation_number?: number | null
          canonical_digest: string
          created_at?: string
          created_by: string
          definition_json: string
          factory_id: string
          id?: string
          routing_evidence_source_draft_id?: string | null
          schema_version: number
          settings_metadata?: Json
          workspace_id: string
        }
        Update: {
          base_activation_number?: number | null
          canonical_digest?: string
          created_at?: string
          created_by?: string
          definition_json?: string
          factory_id?: string
          id?: string
          routing_evidence_source_draft_id?: string | null
          schema_version?: number
          settings_metadata?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_definition_drafts_base_fk"
            columns: ["workspace_id", "factory_id", "base_activation_number"]
            isOneToOne: false
            referencedRelation: "factory_definition_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "factory_definition_drafts_routing_evidence_source_fk"
            columns: [
              "workspace_id",
              "factory_id",
              "routing_evidence_source_draft_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_routing_draft_evidence"
            referencedColumns: ["workspace_id", "factory_id", "draft_id"]
          },
          {
            foreignKeyName: "factory_definition_drafts_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_definition_revisions: {
        Row: {
          canonical_digest: string
          created_at: string
          created_by: string
          definition_json: string
          factory_id: string
          id: string
          schema_version: number
          source_draft_id: string | null
          workspace_id: string
        }
        Insert: {
          canonical_digest: string
          created_at?: string
          created_by: string
          definition_json: string
          factory_id: string
          id?: string
          schema_version: number
          source_draft_id?: string | null
          workspace_id: string
        }
        Update: {
          canonical_digest?: string
          created_at?: string
          created_by?: string
          definition_json?: string
          factory_id?: string
          id?: string
          schema_version?: number
          source_draft_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_definition_revisions_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "factory_definition_revisions_workspace_id_factory_id_sourc_fkey"
            columns: ["workspace_id", "factory_id", "source_draft_id"]
            isOneToOne: false
            referencedRelation: "factory_definition_drafts"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_definition_smoke_tests: {
        Row: {
          base_activation_number: number
          created_at: string
          created_by: string
          definition_digest: string
          error_text: string | null
          evidence: Json
          factory_id: string
          finished_at: string | null
          id: string
          lease_expires_at: string
          policy_version: number
          sandbox_connection_revision: string | null
          status: string
          target_id: string
          target_kind: string
          workspace_id: string
        }
        Insert: {
          base_activation_number: number
          created_at?: string
          created_by: string
          definition_digest: string
          error_text?: string | null
          evidence?: Json
          factory_id: string
          finished_at?: string | null
          id?: string
          lease_expires_at: string
          policy_version?: number
          sandbox_connection_revision?: string | null
          status: string
          target_id: string
          target_kind: string
          workspace_id: string
        }
        Update: {
          base_activation_number?: number
          created_at?: string
          created_by?: string
          definition_digest?: string
          error_text?: string | null
          evidence?: Json
          factory_id?: string
          finished_at?: string | null
          id?: string
          lease_expires_at?: string
          policy_version?: number
          sandbox_connection_revision?: string | null
          status?: string
          target_id?: string
          target_kind?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_definition_smoke_tests_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_evaluation_attempts: {
        Row: {
          attempt_number: number
          claimed_at: string
          factory_id: string
          id: string
          job_id: string
          lease_expires_at: string
          lease_id: string
          outcome: string | null
          settled_at: string | null
          workspace_id: string
        }
        Insert: {
          attempt_number: number
          claimed_at: string
          factory_id: string
          id?: string
          job_id: string
          lease_expires_at: string
          lease_id?: string
          outcome?: string | null
          settled_at?: string | null
          workspace_id: string
        }
        Update: {
          attempt_number?: number
          claimed_at?: string
          factory_id?: string
          id?: string
          job_id?: string
          lease_expires_at?: string
          lease_id?: string
          outcome?: string | null
          settled_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_evaluation_attempts_job_id_workspace_id_factory_id_fkey"
            columns: ["job_id", "workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factory_evaluation_jobs"
            referencedColumns: ["id", "workspace_id", "factory_id"]
          },
        ]
      }
      factory_evaluation_jobs: {
        Row: {
          attempt_count: number
          attempt_limit: number
          available_at: string | null
          benchmark_deferral_count: number
          canceled_recorded_xact_id: unknown
          created_at: string
          factory_id: string
          finished_at: string | null
          id: string
          requested_by: string | null
          run_id: string
          sample_receipt_id: string
          scorer_revision_id: string
          session_id: string
          source_attempt_id: string | null
          status: string
          target_commit_sha: string
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          attempt_limit?: number
          available_at?: string | null
          benchmark_deferral_count?: number
          canceled_recorded_xact_id?: unknown
          created_at?: string
          factory_id: string
          finished_at?: string | null
          id?: string
          requested_by?: string | null
          run_id: string
          sample_receipt_id: string
          scorer_revision_id: string
          session_id: string
          source_attempt_id?: string | null
          status?: string
          target_commit_sha: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          attempt_limit?: number
          available_at?: string | null
          benchmark_deferral_count?: number
          canceled_recorded_xact_id?: unknown
          created_at?: string
          factory_id?: string
          finished_at?: string | null
          id?: string
          requested_by?: string | null
          run_id?: string
          sample_receipt_id?: string
          scorer_revision_id?: string
          session_id?: string
          source_attempt_id?: string | null
          status?: string
          target_commit_sha?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_evaluation_jobs_sample_receipt_id_fkey"
            columns: ["sample_receipt_id"]
            isOneToOne: false
            referencedRelation: "factory_scorer_sample_receipts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_evaluation_jobs_source_attempt_id_fkey"
            columns: ["source_attempt_id"]
            isOneToOne: false
            referencedRelation: "factory_evaluation_receipts"
            referencedColumns: ["attempt_id"]
          },
          {
            foreignKeyName: "factory_evaluation_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "factory_evaluation_lanes"
            referencedColumns: ["workspace_id"]
          },
        ]
      }
      factory_evaluation_lanes: {
        Row: {
          max_concurrent: number
          paused: boolean
          revision: number
          updated_at: string | null
          updated_by: string | null
          workspace_id: string
        }
        Insert: {
          max_concurrent?: number
          paused?: boolean
          revision?: number
          updated_at?: string | null
          updated_by?: string | null
          workspace_id: string
        }
        Update: {
          max_concurrent?: number
          paused?: boolean
          revision?: number
          updated_at?: string | null
          updated_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_evaluation_lanes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      factory_evaluation_receipts: {
        Row: {
          adapter_runtime: string | null
          attempt_id: string
          attempt_number: number
          attempt_outcome: string
          claimed_at: string
          cost_provenance: string
          cost_usd: number | null
          estimation_revision: string | null
          evidence_digest: string | null
          evidence_locations: Json | null
          explanation: string | null
          factory_id: string
          finished_at: string
          input_tokens: number | null
          job_id: string
          latency_ms: number
          output_tokens: number | null
          profile_revision_id: string | null
          provider_model: string | null
          provider_name: string | null
          provider_request_id: string | null
          reason: string | null
          recorded_xact_id: unknown
          result: Json | null
          run_id: string
          sample_receipt_id: string
          scorer_revision_id: string
          session_id: string
          started_at: string | null
          status: string
          target_commit_sha: string
          token_provenance: string
          worker_runtime: string | null
          workspace_id: string
        }
        Insert: {
          adapter_runtime?: string | null
          attempt_id: string
          attempt_number: number
          attempt_outcome: string
          claimed_at: string
          cost_provenance?: string
          cost_usd?: number | null
          estimation_revision?: string | null
          evidence_digest?: string | null
          evidence_locations?: Json | null
          explanation?: string | null
          factory_id: string
          finished_at: string
          input_tokens?: number | null
          job_id: string
          latency_ms: number
          output_tokens?: number | null
          profile_revision_id?: string | null
          provider_model?: string | null
          provider_name?: string | null
          provider_request_id?: string | null
          reason?: string | null
          recorded_xact_id?: unknown
          result?: Json | null
          run_id: string
          sample_receipt_id: string
          scorer_revision_id: string
          session_id: string
          started_at?: string | null
          status: string
          target_commit_sha: string
          token_provenance?: string
          worker_runtime?: string | null
          workspace_id: string
        }
        Update: {
          adapter_runtime?: string | null
          attempt_id?: string
          attempt_number?: number
          attempt_outcome?: string
          claimed_at?: string
          cost_provenance?: string
          cost_usd?: number | null
          estimation_revision?: string | null
          evidence_digest?: string | null
          evidence_locations?: Json | null
          explanation?: string | null
          factory_id?: string
          finished_at?: string
          input_tokens?: number | null
          job_id?: string
          latency_ms?: number
          output_tokens?: number | null
          profile_revision_id?: string | null
          provider_model?: string | null
          provider_name?: string | null
          provider_request_id?: string | null
          reason?: string | null
          recorded_xact_id?: unknown
          result?: Json | null
          run_id?: string
          sample_receipt_id?: string
          scorer_revision_id?: string
          session_id?: string
          started_at?: string | null
          status?: string
          target_commit_sha?: string
          token_provenance?: string
          worker_runtime?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_evaluation_receipts_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: true
            referencedRelation: "factory_evaluation_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_evaluation_receipts_job_id_workspace_id_factory_id_fkey"
            columns: ["job_id", "workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factory_evaluation_jobs"
            referencedColumns: ["id", "workspace_id", "factory_id"]
          },
        ]
      }
      factory_execution_grants: {
        Row: {
          approved_at: string
          approved_by_member_id: string
          budget_payer_member_id: string
          command_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          execution_policy_revision_id: string
          expires_at: string
          factory_id: string
          github_repository_id: string
          id: string
          read_context_repository_ids: string[]
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          service_principal_id: string
          tool_ids: string[]
          version: number
          workspace_id: string
        }
        Insert: {
          approved_at: string
          approved_by_member_id: string
          budget_payer_member_id: string
          command_scopes?: Database["public"]["Enums"]["factory_command_scope"][]
          execution_policy_revision_id: string
          expires_at: string
          factory_id: string
          github_repository_id: string
          id?: string
          read_context_repository_ids: string[]
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          service_principal_id: string
          tool_ids: string[]
          version: number
          workspace_id: string
        }
        Update: {
          approved_at?: string
          approved_by_member_id?: string
          budget_payer_member_id?: string
          command_scopes?: Database["public"]["Enums"]["factory_command_scope"][]
          execution_policy_revision_id?: string
          expires_at?: string
          factory_id?: string
          github_repository_id?: string
          id?: string
          read_context_repository_ids?: string[]
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          service_principal_id?: string
          tool_ids?: string[]
          version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_execution_grants_workspace_id_factory_id_service_p_fkey"
            columns: ["workspace_id", "factory_id", "service_principal_id"]
            isOneToOne: false
            referencedRelation: "service_principals"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_judge_invocations: {
        Row: {
          adapter_runtime: string
          attempt_id: string
          candidate_result: Json | null
          evidence_digest: string | null
          factory_id: string
          finished_at: string | null
          job_id: string
          profile_revision_id: string | null
          provider_model: string | null
          provider_name: string | null
          provider_request_id: string | null
          started_at: string | null
          status: string
          worker_runtime: string | null
          workspace_id: string
        }
        Insert: {
          adapter_runtime?: string
          attempt_id: string
          candidate_result?: Json | null
          evidence_digest?: string | null
          factory_id: string
          finished_at?: string | null
          job_id: string
          profile_revision_id?: string | null
          provider_model?: string | null
          provider_name?: string | null
          provider_request_id?: string | null
          started_at?: string | null
          status: string
          worker_runtime?: string | null
          workspace_id: string
        }
        Update: {
          adapter_runtime?: string
          attempt_id?: string
          candidate_result?: Json | null
          evidence_digest?: string | null
          factory_id?: string
          finished_at?: string | null
          job_id?: string
          profile_revision_id?: string | null
          provider_model?: string | null
          provider_name?: string | null
          provider_request_id?: string | null
          started_at?: string | null
          status?: string
          worker_runtime?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_judge_invocations_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: true
            referencedRelation: "factory_evaluation_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_judge_invocations_job_id_workspace_id_factory_id_fkey"
            columns: ["job_id", "workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factory_evaluation_jobs"
            referencedColumns: ["id", "workspace_id", "factory_id"]
          },
          {
            foreignKeyName: "factory_judge_invocations_workspace_id_profile_revision_id_fkey"
            columns: ["workspace_id", "profile_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_judge_profile_revisions"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_judge_profile_revisions: {
        Row: {
          allow_images: boolean
          allow_video: boolean
          approved_by_member_id: string
          created_at: string
          enabled: boolean
          id: string
          model_id: string
          provider: string
          provider_route: string
          revision: number
          workspace_id: string
        }
        Insert: {
          allow_images: boolean
          allow_video: boolean
          approved_by_member_id: string
          created_at?: string
          enabled: boolean
          id?: string
          model_id: string
          provider?: string
          provider_route: string
          revision: number
          workspace_id: string
        }
        Update: {
          allow_images?: boolean
          allow_video?: boolean
          approved_by_member_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          model_id?: string
          provider?: string
          provider_route?: string
          revision?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_judge_profile_revisions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      factory_machine_tokens: {
        Row: {
          created_at: string
          created_by_member_id: string
          execution_grant_id: string
          execution_grant_version: number
          expires_at: string | null
          factory_id: string
          id: string
          last_used_at: string | null
          last_used_scope:
            | Database["public"]["Enums"]["factory_command_scope"]
            | null
          name: string
          revoked_at: string | null
          revoked_by_member_id: string | null
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          service_principal_id: string
          workspace_id: string
        }
        Insert: {
          created_at: string
          created_by_member_id: string
          execution_grant_id: string
          execution_grant_version: number
          expires_at?: string | null
          factory_id: string
          id: string
          last_used_at?: string | null
          last_used_scope?:
            | Database["public"]["Enums"]["factory_command_scope"]
            | null
          name: string
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          service_principal_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by_member_id?: string
          execution_grant_id?: string
          execution_grant_version?: number
          expires_at?: string | null
          factory_id?: string
          id?: string
          last_used_at?: string | null
          last_used_scope?:
            | Database["public"]["Enums"]["factory_command_scope"]
            | null
          name?: string
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          scopes?: Database["public"]["Enums"]["factory_command_scope"][]
          service_principal_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_machine_tokens_workspace_id_factory_id_service_pri_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "service_principal_id",
              "execution_grant_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_execution_grants"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "service_principal_id",
              "id",
            ]
          },
        ]
      }
      factory_mcp_secret_bindings: {
        Row: {
          created_at: string
          created_by: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id: string
          revoked_at: string | null
          revoked_by: string | null
          service_principal_id: string
          tool_revision_id: string
          workspace_id: string
          workspace_secret_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          service_principal_id: string
          tool_revision_id: string
          workspace_id: string
          workspace_secret_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          execution_grant_id?: string
          factory_agent_id?: string
          factory_id?: string
          id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          service_principal_id?: string
          tool_revision_id?: string
          workspace_id?: string
          workspace_secret_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_mcp_secret_bindings_execution_grant_id_fkey"
            columns: ["execution_grant_id"]
            isOneToOne: false
            referencedRelation: "factory_execution_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_mcp_secret_bindings_workspace_id_factory_id_factor_fkey"
            columns: ["workspace_id", "factory_id", "factory_agent_id"]
            isOneToOne: false
            referencedRelation: "factory_agents"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_mcp_secret_bindings_workspace_id_factory_id_servic_fkey"
            columns: ["workspace_id", "factory_id", "service_principal_id"]
            isOneToOne: false
            referencedRelation: "service_principals"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_mcp_secret_bindings_workspace_id_factory_id_tool_r_fkey"
            columns: ["workspace_id", "factory_id", "tool_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_mcp_server_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_mcp_server_revisions: {
        Row: {
          auth_kind: string
          created_at: string
          created_by: string
          endpoint: string
          factory_id: string
          id: string
          operation_names: string[]
          revision_number: number
          revoked_at: string | null
          revoked_by: string | null
          server_id: string
          workspace_id: string
        }
        Insert: {
          auth_kind: string
          created_at?: string
          created_by: string
          endpoint: string
          factory_id: string
          id?: string
          operation_names: string[]
          revision_number: number
          revoked_at?: string | null
          revoked_by?: string | null
          server_id: string
          workspace_id: string
        }
        Update: {
          auth_kind?: string
          created_at?: string
          created_by?: string
          endpoint?: string
          factory_id?: string
          id?: string
          operation_names?: string[]
          revision_number?: number
          revoked_at?: string | null
          revoked_by?: string | null
          server_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_mcp_server_revisions_workspace_id_factory_id_serve_fkey"
            columns: ["workspace_id", "factory_id", "server_id"]
            isOneToOne: false
            referencedRelation: "factory_mcp_servers"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_mcp_servers: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          name: string
          slug: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          id?: string
          name: string
          slug: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          name?: string
          slug?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_mcp_servers_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_members: {
        Row: {
          factory_id: string
          granted_at: string
          granted_by_member_id: string | null
          id: string
          member_id: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          role: string
          workspace_id: string
        }
        Insert: {
          factory_id: string
          granted_at?: string
          granted_by_member_id?: string | null
          id?: string
          member_id: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          role: string
          workspace_id: string
        }
        Update: {
          factory_id?: string
          granted_at?: string
          granted_by_member_id?: string | null
          id?: string
          member_id?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          role?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_members_granted_by_member_id_fkey"
            columns: ["granted_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_members_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_members_revoked_by_member_id_fkey"
            columns: ["revoked_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_members_workspace_factory_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_memories: {
        Row: {
          created_at: string
          current_approval_id: string | null
          current_revision_id: string | null
          factory_id: string
          forgotten_at: string | null
          id: string
          pending_revision_id: string | null
          source_artifact_id: string
          source_artifact_version: number
          source_attempt_count: number
          source_commit_sha: string
          source_content_sha256: string
          source_run_id: string
          source_session_id: string
          title: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          current_approval_id?: string | null
          current_revision_id?: string | null
          factory_id: string
          forgotten_at?: string | null
          id?: string
          pending_revision_id?: string | null
          source_artifact_id: string
          source_artifact_version: number
          source_attempt_count: number
          source_commit_sha: string
          source_content_sha256: string
          source_run_id: string
          source_session_id: string
          title?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          current_approval_id?: string | null
          current_revision_id?: string | null
          factory_id?: string
          forgotten_at?: string | null
          id?: string
          pending_revision_id?: string | null
          source_artifact_id?: string
          source_artifact_version?: number
          source_attempt_count?: number
          source_commit_sha?: string
          source_content_sha256?: string
          source_run_id?: string
          source_session_id?: string
          title?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_memories_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "factory_memories_workspace_id_factory_id_id_current_revis_fkey1"
            columns: [
              "workspace_id",
              "factory_id",
              "id",
              "current_revision_id",
              "current_approval_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_memory_review_events"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "memory_id",
              "revision_id",
              "id",
            ]
          },
          {
            foreignKeyName: "factory_memories_workspace_id_factory_id_id_current_revisi_fkey"
            columns: ["workspace_id", "factory_id", "id", "current_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_memory_revisions"
            referencedColumns: ["workspace_id", "factory_id", "memory_id", "id"]
          },
          {
            foreignKeyName: "factory_memories_workspace_id_factory_id_id_pending_revisi_fkey"
            columns: ["workspace_id", "factory_id", "id", "pending_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_memory_revisions"
            referencedColumns: ["workspace_id", "factory_id", "memory_id", "id"]
          },
        ]
      }
      factory_memory_review_events: {
        Row: {
          action: string
          actor_member_id: string
          created_at: string
          factory_id: string
          id: string
          memory_id: string
          revision_id: string | null
          workspace_id: string
        }
        Insert: {
          action: string
          actor_member_id: string
          created_at?: string
          factory_id: string
          id?: string
          memory_id: string
          revision_id?: string | null
          workspace_id: string
        }
        Update: {
          action?: string
          actor_member_id?: string
          created_at?: string
          factory_id?: string
          id?: string
          memory_id?: string
          revision_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_memory_review_events_workspace_id_factory_id_memo_fkey1"
            columns: ["workspace_id", "factory_id", "memory_id", "revision_id"]
            isOneToOne: false
            referencedRelation: "factory_memory_revisions"
            referencedColumns: ["workspace_id", "factory_id", "memory_id", "id"]
          },
          {
            foreignKeyName: "factory_memory_review_events_workspace_id_factory_id_memor_fkey"
            columns: ["workspace_id", "factory_id", "memory_id"]
            isOneToOne: false
            referencedRelation: "factory_memories"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_memory_revision_bodies: {
        Row: {
          body_md: string
          factory_id: string
          memory_id: string
          revision_id: string
          workspace_id: string
        }
        Insert: {
          body_md: string
          factory_id: string
          memory_id: string
          revision_id: string
          workspace_id: string
        }
        Update: {
          body_md?: string
          factory_id?: string
          memory_id?: string
          revision_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_memory_revision_bodie_workspace_id_factory_id_memo_fkey"
            columns: ["workspace_id", "factory_id", "memory_id", "revision_id"]
            isOneToOne: false
            referencedRelation: "factory_memory_revisions"
            referencedColumns: ["workspace_id", "factory_id", "memory_id", "id"]
          },
        ]
      }
      factory_memory_revisions: {
        Row: {
          content_sha256: string
          created_at: string
          expires_at: string | null
          factory_id: string
          id: string
          memory_id: string
          revision_number: number
          supersedes_revision_id: string | null
          workspace_id: string
        }
        Insert: {
          content_sha256: string
          created_at?: string
          expires_at?: string | null
          factory_id: string
          id?: string
          memory_id: string
          revision_number: number
          supersedes_revision_id?: string | null
          workspace_id: string
        }
        Update: {
          content_sha256?: string
          created_at?: string
          expires_at?: string | null
          factory_id?: string
          id?: string
          memory_id?: string
          revision_number?: number
          supersedes_revision_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_memory_revisions_workspace_id_factory_id_memory_i_fkey1"
            columns: [
              "workspace_id",
              "factory_id",
              "memory_id",
              "supersedes_revision_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_memory_revisions"
            referencedColumns: ["workspace_id", "factory_id", "memory_id", "id"]
          },
          {
            foreignKeyName: "factory_memory_revisions_workspace_id_factory_id_memory_id_fkey"
            columns: ["workspace_id", "factory_id", "memory_id"]
            isOneToOne: false
            referencedRelation: "factory_memories"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_oauth_client_bindings: {
        Row: {
          client_id: string
          execution_grant_id: string
          execution_grant_version: number
          factory_id: string
          service_principal_id: string
          workspace_id: string
        }
        Insert: {
          client_id: string
          execution_grant_id: string
          execution_grant_version: number
          factory_id: string
          service_principal_id: string
          workspace_id: string
        }
        Update: {
          client_id?: string
          execution_grant_id?: string
          execution_grant_version?: number
          factory_id?: string
          service_principal_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_oauth_client_bindings_workspace_id_client_id_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "factory_oauth_clients"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "factory_oauth_client_bindings_workspace_id_factory_id_serv_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "service_principal_id",
              "execution_grant_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_execution_grants"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "service_principal_id",
              "id",
            ]
          },
        ]
      }
      factory_oauth_clients: {
        Row: {
          allowed_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          created_at: string
          created_by_member_id: string
          id: string
          name: string
          redirect_uris: string[]
          revoked_at: string | null
          revoked_by_member_id: string | null
          workspace_id: string
        }
        Insert: {
          allowed_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          created_at?: string
          created_by_member_id: string
          id?: string
          name: string
          redirect_uris: string[]
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          workspace_id: string
        }
        Update: {
          allowed_scopes?: Database["public"]["Enums"]["factory_command_scope"][]
          created_at?: string
          created_by_member_id?: string
          id?: string
          name?: string
          redirect_uris?: string[]
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_oauth_clients_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      factory_oauth_grant_bindings: {
        Row: {
          execution_grant_id: string
          execution_grant_version: number
          factory_id: string
          grant_id: string
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          service_principal_id: string
          workspace_id: string
        }
        Insert: {
          execution_grant_id: string
          execution_grant_version: number
          factory_id: string
          grant_id: string
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          service_principal_id: string
          workspace_id: string
        }
        Update: {
          execution_grant_id?: string
          execution_grant_version?: number
          factory_id?: string
          grant_id?: string
          scopes?: Database["public"]["Enums"]["factory_command_scope"][]
          service_principal_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_oauth_grant_bindings_workspace_id_factory_id_servi_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "service_principal_id",
              "execution_grant_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_execution_grants"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "service_principal_id",
              "id",
            ]
          },
          {
            foreignKeyName: "factory_oauth_grant_bindings_workspace_id_grant_id_fkey"
            columns: ["workspace_id", "grant_id"]
            isOneToOne: false
            referencedRelation: "factory_oauth_grants"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_oauth_grants: {
        Row: {
          client_id: string
          consenting_member_id: string
          created_at: string
          expires_at: string
          id: string
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          workspace_id: string
        }
        Insert: {
          client_id: string
          consenting_member_id: string
          created_at: string
          expires_at: string
          id?: string
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          workspace_id: string
        }
        Update: {
          client_id?: string
          consenting_member_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          scopes?: Database["public"]["Enums"]["factory_command_scope"][]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_oauth_grants_workspace_id_client_id_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "factory_oauth_clients"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_routing_activations: {
        Row: {
          activation_number: number
          benchmark_evidence_draft_id: string | null
          draft_digest: string
          draft_id: string | null
          factory_id: string
          previous_activation_number: number | null
          previous_revision_id: string | null
          reviewed_at: string
          reviewed_by_member_id: string
          reviewed_targets: Json
          revision_id: string
          source_improvement_adoption_id: string | null
          workspace_id: string
        }
        Insert: {
          activation_number: number
          benchmark_evidence_draft_id?: string | null
          draft_digest: string
          draft_id?: string | null
          factory_id: string
          previous_activation_number?: number | null
          previous_revision_id?: string | null
          reviewed_at?: string
          reviewed_by_member_id: string
          reviewed_targets: Json
          revision_id: string
          source_improvement_adoption_id?: string | null
          workspace_id: string
        }
        Update: {
          activation_number?: number
          benchmark_evidence_draft_id?: string | null
          draft_digest?: string
          draft_id?: string | null
          factory_id?: string
          previous_activation_number?: number | null
          previous_revision_id?: string | null
          reviewed_at?: string
          reviewed_by_member_id?: string
          reviewed_targets?: Json
          revision_id?: string
          source_improvement_adoption_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_routing_activations_workspace_id_factory_id_activa_fkey"
            columns: ["workspace_id", "factory_id", "activation_number"]
            isOneToOne: true
            referencedRelation: "factory_definition_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "factory_routing_activations_workspace_id_factory_id_benchm_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "benchmark_evidence_draft_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_routing_draft_evidence"
            referencedColumns: ["workspace_id", "factory_id", "draft_id"]
          },
          {
            foreignKeyName: "factory_routing_activations_workspace_id_factory_id_draft__fkey"
            columns: ["workspace_id", "factory_id", "draft_id"]
            isOneToOne: false
            referencedRelation: "factory_definition_drafts"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_routing_canaries: {
        Row: {
          activation_number: number
          baseline_activation_number: number
          baseline_revision_id: string
          candidate_bps: number
          candidate_revision_id: string
          created_at: string
          factory_id: string
          id: string
          minimum_support: number
          task_class_id: string
          task_class_slug: string
          workspace_id: string
        }
        Insert: {
          activation_number: number
          baseline_activation_number: number
          baseline_revision_id: string
          candidate_bps: number
          candidate_revision_id: string
          created_at?: string
          factory_id: string
          id?: string
          minimum_support?: number
          task_class_id: string
          task_class_slug: string
          workspace_id: string
        }
        Update: {
          activation_number?: number
          baseline_activation_number?: number
          baseline_revision_id?: string
          candidate_bps?: number
          candidate_revision_id?: string
          created_at?: string
          factory_id?: string
          id?: string
          minimum_support?: number
          task_class_id?: string
          task_class_slug?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_routing_canaries_workspace_id_factory_id_activatio_fkey"
            columns: ["workspace_id", "factory_id", "activation_number"]
            isOneToOne: true
            referencedRelation: "factory_routing_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "factory_routing_canaries_workspace_id_factory_id_baseline__fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "baseline_activation_number",
            ]
            isOneToOne: false
            referencedRelation: "factory_definition_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
        ]
      }
      factory_routing_canary_alerts: {
        Row: {
          activation_number: number
          baseline_support: number
          baseline_value: number
          canary_id: string
          candidate_support: number
          candidate_value: number
          evidence: Json
          evidence_draft_id: string
          factory_id: string
          id: string
          metric: string
          observed_at: string
          report: Json
          rule_id: string
          threshold_bps: number
          threshold_revision: number
          workspace_id: string
        }
        Insert: {
          activation_number: number
          baseline_support: number
          baseline_value: number
          canary_id: string
          candidate_support: number
          candidate_value: number
          evidence: Json
          evidence_draft_id: string
          factory_id: string
          id?: string
          metric: string
          observed_at: string
          report: Json
          rule_id: string
          threshold_bps: number
          threshold_revision: number
          workspace_id: string
        }
        Update: {
          activation_number?: number
          baseline_support?: number
          baseline_value?: number
          canary_id?: string
          candidate_support?: number
          candidate_value?: number
          evidence?: Json
          evidence_draft_id?: string
          factory_id?: string
          id?: string
          metric?: string
          observed_at?: string
          report?: Json
          rule_id?: string
          threshold_bps?: number
          threshold_revision?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_routing_canary_alerts_workspace_id_factory_id_cana_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "canary_id",
              "activation_number",
            ]
            isOneToOne: false
            referencedRelation: "factory_routing_canaries"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "factory_routing_canary_alerts_workspace_id_factory_id_evid_fkey"
            columns: ["workspace_id", "factory_id", "evidence_draft_id"]
            isOneToOne: false
            referencedRelation: "factory_routing_draft_evidence"
            referencedColumns: ["workspace_id", "factory_id", "draft_id"]
          },
        ]
      }
      factory_routing_draft_evidence: {
        Row: {
          candidate_key: string
          created_by: string
          draft_id: string
          evidence: Json
          experiment_id: string
          factory_id: string
          request_digest: string
          request_id: string
          workspace_id: string
        }
        Insert: {
          candidate_key: string
          created_by: string
          draft_id: string
          evidence: Json
          experiment_id: string
          factory_id: string
          request_digest: string
          request_id: string
          workspace_id: string
        }
        Update: {
          candidate_key?: string
          created_by?: string
          draft_id?: string
          evidence?: Json
          experiment_id?: string
          factory_id?: string
          request_digest?: string
          request_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_routing_draft_evidenc_workspace_id_factory_id_draf_fkey"
            columns: ["workspace_id", "factory_id", "draft_id"]
            isOneToOne: true
            referencedRelation: "factory_definition_drafts"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_routing_draft_evidenc_workspace_id_factory_id_expe_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "experiment_id",
              "candidate_key",
            ]
            isOneToOne: false
            referencedRelation: "factory_benchmark_experiment_candidates"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "experiment_id",
              "candidate_key",
            ]
          },
        ]
      }
      factory_routing_rollbacks: {
        Row: {
          activation_number: number
          actor_member_id: string
          created_at: string
          factory_id: string
          previous_activation_number: number
          restored_mode: string
          target_activation_number: number
          target_revision_id: string
          workspace_id: string
        }
        Insert: {
          activation_number: number
          actor_member_id: string
          created_at?: string
          factory_id: string
          previous_activation_number: number
          restored_mode: string
          target_activation_number: number
          target_revision_id: string
          workspace_id: string
        }
        Update: {
          activation_number?: number
          actor_member_id?: string
          created_at?: string
          factory_id?: string
          previous_activation_number?: number
          restored_mode?: string
          target_activation_number?: number
          target_revision_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_routing_rollbacks_workspace_id_factory_id_activati_fkey"
            columns: ["workspace_id", "factory_id", "activation_number"]
            isOneToOne: true
            referencedRelation: "factory_definition_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "factory_routing_rollbacks_workspace_id_factory_id_target_a_fkey"
            columns: ["workspace_id", "factory_id", "target_activation_number"]
            isOneToOne: false
            referencedRelation: "factory_definition_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
        ]
      }
      factory_run_credential_receipts: {
        Row: {
          agent_provider: string
          attempt_count: number
          binding_id: string
          binding_version: number
          factory_id: string
          job_id: string
          material_revision: number
          resolved_at: string
          run_id: string
          service_principal_id: string
          session_id: string
          workspace_id: string
        }
        Insert: {
          agent_provider: string
          attempt_count: number
          binding_id: string
          binding_version: number
          factory_id: string
          job_id: string
          material_revision: number
          resolved_at?: string
          run_id: string
          service_principal_id: string
          session_id: string
          workspace_id: string
        }
        Update: {
          agent_provider?: string
          attempt_count?: number
          binding_id?: string
          binding_version?: number
          factory_id?: string
          job_id?: string
          material_revision?: number
          resolved_at?: string
          run_id?: string
          service_principal_id?: string
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_run_credential_receipts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_run_credential_receipts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "factory_run_credential_receipts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_run_credential_receipts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_run_credential_receipts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      factory_scorer_adjudications: {
        Row: {
          actor_member_id: string
          attempt_id: string
          created_at: string
          disposition: string
          expected_status: string | null
          factory_id: string
          id: string
          note: string
          scorer_id: string
          workspace_id: string
        }
        Insert: {
          actor_member_id: string
          attempt_id: string
          created_at?: string
          disposition: string
          expected_status?: string | null
          factory_id: string
          id: string
          note: string
          scorer_id: string
          workspace_id: string
        }
        Update: {
          actor_member_id?: string
          attempt_id?: string
          created_at?: string
          disposition?: string
          expected_status?: string | null
          factory_id?: string
          id?: string
          note?: string
          scorer_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorer_adjudications_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "factory_evaluation_receipts"
            referencedColumns: ["attempt_id"]
          },
          {
            foreignKeyName: "factory_scorer_adjudications_workspace_id_factory_id_score_fkey"
            columns: ["workspace_id", "factory_id", "scorer_id"]
            isOneToOne: false
            referencedRelation: "factory_scorers"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_scorer_admission_skips: {
        Row: {
          factory_id: string
          pause_revision: number
          recorded_xact_id: unknown
          sample_receipt_id: string
          scorer_id: string
          workspace_id: string
        }
        Insert: {
          factory_id: string
          pause_revision: number
          recorded_xact_id?: unknown
          sample_receipt_id: string
          scorer_id: string
          workspace_id: string
        }
        Update: {
          factory_id?: string
          pause_revision?: number
          recorded_xact_id?: unknown
          sample_receipt_id?: string
          scorer_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorer_admission_ski_workspace_id_factory_id_scor_fkey1"
            columns: [
              "workspace_id",
              "factory_id",
              "scorer_id",
              "pause_revision",
            ]
            isOneToOne: false
            referencedRelation: "factory_scorer_pause_transitions"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "scorer_id",
              "revision",
            ]
          },
          {
            foreignKeyName: "factory_scorer_admission_skip_workspace_id_factory_id_scor_fkey"
            columns: ["workspace_id", "factory_id", "scorer_id"]
            isOneToOne: false
            referencedRelation: "factory_scorers"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_scorer_admission_skips_sample_receipt_id_fkey"
            columns: ["sample_receipt_id"]
            isOneToOne: true
            referencedRelation: "factory_scorer_sample_receipts"
            referencedColumns: ["id"]
          },
        ]
      }
      factory_scorer_calibration_revisions: {
        Row: {
          adjudication_ids: string[]
          created_at: string
          created_by_member_id: string
          factory_id: string
          id: string
          name: string
          revision: number
          scorer_id: string
          scorer_revision_id: string
          set_id: string
          workspace_id: string
        }
        Insert: {
          adjudication_ids: string[]
          created_at?: string
          created_by_member_id: string
          factory_id: string
          id?: string
          name: string
          revision: number
          scorer_id: string
          scorer_revision_id: string
          set_id: string
          workspace_id: string
        }
        Update: {
          adjudication_ids?: string[]
          created_at?: string
          created_by_member_id?: string
          factory_id?: string
          id?: string
          name?: string
          revision?: number
          scorer_id?: string
          scorer_revision_id?: string
          set_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorer_calibration_re_workspace_id_factory_id_scor_fkey"
            columns: ["workspace_id", "factory_id", "scorer_id"]
            isOneToOne: false
            referencedRelation: "factory_scorers"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_scorer_pause_transitions: {
        Row: {
          actor_user_id: string
          created_at: string
          factory_id: string
          paused: boolean
          revision: number
          scorer_id: string
          workspace_id: string
        }
        Insert: {
          actor_user_id: string
          created_at: string
          factory_id: string
          paused: boolean
          revision: number
          scorer_id: string
          workspace_id: string
        }
        Update: {
          actor_user_id?: string
          created_at?: string
          factory_id?: string
          paused?: boolean
          revision?: number
          scorer_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorer_pause_transiti_workspace_id_factory_id_scor_fkey"
            columns: ["workspace_id", "factory_id", "scorer_id"]
            isOneToOne: false
            referencedRelation: "factory_scorers"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_scorer_pauses: {
        Row: {
          factory_id: string
          paused: boolean
          revision: number
          scorer_id: string
          updated_at: string
          updated_by: string
          workspace_id: string
        }
        Insert: {
          factory_id: string
          paused: boolean
          revision: number
          scorer_id: string
          updated_at?: string
          updated_by: string
          workspace_id: string
        }
        Update: {
          factory_id?: string
          paused?: boolean
          revision?: number
          scorer_id?: string
          updated_at?: string
          updated_by?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorer_pauses_workspace_id_factory_id_scorer_id_fkey"
            columns: ["workspace_id", "factory_id", "scorer_id"]
            isOneToOne: true
            referencedRelation: "factory_scorers"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_scorer_revisions: {
        Row: {
          created_at: string
          created_by: string
          definition: Json
          factory_id: string
          id: string
          revision_number: number
          scorer_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          definition: Json
          factory_id: string
          id?: string
          revision_number: number
          scorer_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          definition?: Json
          factory_id?: string
          id?: string
          revision_number?: number
          scorer_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorer_revisions_workspace_id_factory_id_scorer_id_fkey"
            columns: ["workspace_id", "factory_id", "scorer_id"]
            isOneToOne: false
            referencedRelation: "factory_scorers"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_scorer_sample_receipts: {
        Row: {
          attempt_count: number | null
          benchmark_result_digest: string | null
          benchmark_trial_id: string | null
          created_at: string
          definition_revision_id: string
          evidence: Json
          factory_id: string
          id: string
          missing_evidence: string[]
          outcome: string
          policy_id: string | null
          reason: string | null
          recorded_xact_id: unknown
          run_finished_at: string
          run_id: string
          scorer_revision_id: string
          session_id: string
          target_commit_sha: string | null
          workspace_id: string
        }
        Insert: {
          attempt_count?: number | null
          benchmark_result_digest?: string | null
          benchmark_trial_id?: string | null
          created_at?: string
          definition_revision_id: string
          evidence: Json
          factory_id: string
          id?: string
          missing_evidence: string[]
          outcome: string
          policy_id?: string | null
          reason?: string | null
          recorded_xact_id?: unknown
          run_finished_at: string
          run_id: string
          scorer_revision_id: string
          session_id: string
          target_commit_sha?: string | null
          workspace_id: string
        }
        Update: {
          attempt_count?: number | null
          benchmark_result_digest?: string | null
          benchmark_trial_id?: string | null
          created_at?: string
          definition_revision_id?: string
          evidence?: Json
          factory_id?: string
          id?: string
          missing_evidence?: string[]
          outcome?: string
          policy_id?: string | null
          reason?: string | null
          recorded_xact_id?: unknown
          run_finished_at?: string
          run_id?: string
          scorer_revision_id?: string
          session_id?: string
          target_commit_sha?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorer_sample_receipt_workspace_id_factory_id_poli_fkey"
            columns: [
              "workspace_id",
              "factory_id",
              "policy_id",
              "scorer_revision_id",
            ]
            isOneToOne: false
            referencedRelation: "factory_scorer_sampling_policies"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "id",
              "scorer_revision_id",
            ]
          },
          {
            foreignKeyName: "factory_scorer_sample_receipts_benchmark_trial_id_fkey"
            columns: ["benchmark_trial_id"]
            isOneToOne: false
            referencedRelation: "factory_benchmark_schedule_trials"
            referencedColumns: ["trial_id"]
          },
          {
            foreignKeyName: "factory_scorer_sample_receipts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_scorer_sample_receipts_scorer_fk"
            columns: ["workspace_id", "factory_id", "scorer_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_scorer_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_scorer_sampling_policies: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          rate_bps: number
          revision_number: number
          scorer_revision_id: string
          seed: string
          stage_ids: string[]
          terminal_statuses: string[]
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          id?: string
          rate_bps: number
          revision_number: number
          scorer_revision_id: string
          seed: string
          stage_ids: string[]
          terminal_statuses: string[]
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          rate_bps?: number
          revision_number?: number
          scorer_revision_id?: string
          seed?: string
          stage_ids?: string[]
          terminal_statuses?: string[]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorer_sampling_polic_workspace_id_factory_id_scor_fkey"
            columns: ["workspace_id", "factory_id", "scorer_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_scorer_revisions"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_scorers: {
        Row: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          name: string
          slug: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          factory_id: string
          id?: string
          name: string
          slug: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          factory_id?: string
          id?: string
          name?: string
          slug?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_scorers_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      factory_secret_bindings: {
        Row: {
          agent_provider: string
          created_at: string
          created_by_member_id: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id: string
          open_code_provider_id: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          service_principal_id: string
          version: number
          workspace_id: string
          workspace_secret_id: string
        }
        Insert: {
          agent_provider: string
          created_at?: string
          created_by_member_id: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id?: string
          open_code_provider_id?: string | null
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          service_principal_id: string
          version?: number
          workspace_id: string
          workspace_secret_id: string
        }
        Update: {
          agent_provider?: string
          created_at?: string
          created_by_member_id?: string
          execution_grant_id?: string
          factory_agent_id?: string
          factory_id?: string
          id?: string
          open_code_provider_id?: string | null
          revoked_at?: string | null
          revoked_by_member_id?: string | null
          service_principal_id?: string
          version?: number
          workspace_id?: string
          workspace_secret_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_secret_bindings_execution_grant_id_fkey"
            columns: ["execution_grant_id"]
            isOneToOne: false
            referencedRelation: "factory_execution_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factory_secret_bindings_workspace_id_factory_id_factory_ag_fkey"
            columns: ["workspace_id", "factory_id", "factory_agent_id"]
            isOneToOne: false
            referencedRelation: "factory_agents"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
          {
            foreignKeyName: "factory_secret_bindings_workspace_id_factory_id_service_pr_fkey"
            columns: ["workspace_id", "factory_id", "service_principal_id"]
            isOneToOne: false
            referencedRelation: "service_principals"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_skill_revisions: {
        Row: {
          content_md: string
          content_sha256: string
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          revision_number: number
          revoked_at: string | null
          revoked_by: string | null
          skill_id: string
          source_kind: string
          source_ref: string | null
          workspace_id: string
        }
        Insert: {
          content_md: string
          content_sha256: string
          created_at?: string
          created_by?: string | null
          factory_id: string
          id?: string
          revision_number: number
          revoked_at?: string | null
          revoked_by?: string | null
          skill_id: string
          source_kind: string
          source_ref?: string | null
          workspace_id: string
        }
        Update: {
          content_md?: string
          content_sha256?: string
          created_at?: string
          created_by?: string | null
          factory_id?: string
          id?: string
          revision_number?: number
          revoked_at?: string | null
          revoked_by?: string | null
          skill_id?: string
          source_kind?: string
          source_ref?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_skill_revisions_workspace_id_factory_id_skill_id_fkey"
            columns: ["workspace_id", "factory_id", "skill_id"]
            isOneToOne: false
            referencedRelation: "factory_skills"
            referencedColumns: ["workspace_id", "factory_id", "id"]
          },
        ]
      }
      factory_skills: {
        Row: {
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          name: string
          slug: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          factory_id: string
          id?: string
          name: string
          slug: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          factory_id?: string
          id?: string
          name?: string
          slug?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "factory_skills_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      github_install_flows: {
        Row: {
          created_at: string
          encrypted_code_verifier: string
          expires_at: string
          installation_id: number | null
          phase: string
          source: string
          state_hash: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          encrypted_code_verifier: string
          expires_at: string
          installation_id?: number | null
          phase?: string
          source: string
          state_hash: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          encrypted_code_verifier?: string
          expires_at?: string
          installation_id?: number | null
          phase?: string
          source?: string
          state_hash?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "github_install_flows_workspace_id_fkey"
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
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      github_pr_refresh_watermarks: {
        Row: {
          repository_id: string
          revision: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          repository_id: string
          revision: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          repository_id?: string
          revision?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "github_pr_refresh_watermarks_repository_id_fkey"
            columns: ["repository_id"]
            isOneToOne: true
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_pr_refresh_watermarks_workspace_id_fkey"
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
          factory_id: string
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
          factory_id: string
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
          factory_id?: string
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
            foreignKeyName: "github_repositories_workspace_factory_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
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
          anyone_can_approve: boolean
          approver_member_ids: string[]
          archived_at: string | null
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
          anyone_can_approve?: boolean
          approver_member_ids?: string[]
          archived_at?: string | null
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
          anyone_can_approve?: boolean
          approver_member_ids?: string[]
          archived_at?: string | null
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
          factory_id: string
          id: string
          is_default: boolean
          name: string
          operating_rules_md: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          factory_id: string
          id?: string
          is_default?: boolean
          name?: string
          operating_rules_md?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          factory_id?: string
          id?: string
          is_default?: boolean
          name?: string
          operating_rules_md?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipelines_workspace_factory_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
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
          avatar_overridden: boolean
          avatar_path: string | null
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          primary_email: string | null
          updated_at: string
        }
        Insert: {
          avatar_overridden?: boolean
          avatar_path?: string | null
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          primary_email?: string | null
          updated_at?: string
        }
        Update: {
          avatar_overridden?: boolean
          avatar_path?: string | null
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
          setup_pr_observation_token: string | null
          setup_pr_state: string | null
          setup_pr_updated_at: string | null
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
          setup_pr_observation_token?: string | null
          setup_pr_state?: string | null
          setup_pr_updated_at?: string | null
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
          setup_pr_observation_token?: string | null
          setup_pr_state?: string | null
          setup_pr_updated_at?: string | null
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
      run_export_assets: {
        Row: {
          asset_id: string
          content_type: string
          export_id: string
          sha256: string
          size_bytes: number
          workspace_id: string
        }
        Insert: {
          asset_id: string
          content_type: string
          export_id: string
          sha256: string
          size_bytes: number
          workspace_id: string
        }
        Update: {
          asset_id?: string
          content_type?: string
          export_id?: string
          sha256?: string
          size_bytes?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_export_assets_export_id_workspace_id_fkey"
            columns: ["export_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "run_exports"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      run_export_pages: {
        Row: {
          export_id: string
          first_ordinal: number
          last_ordinal: number
          sha256: string
          size_bytes: number
          workspace_id: string
        }
        Insert: {
          export_id: string
          first_ordinal: number
          last_ordinal: number
          sha256: string
          size_bytes: number
          workspace_id: string
        }
        Update: {
          export_id?: string
          first_ordinal?: number
          last_ordinal?: number
          sha256?: string
          size_bytes?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_export_pages_export_id_workspace_id_fkey"
            columns: ["export_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "run_exports"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      run_exports: {
        Row: {
          cleaned_at: string | null
          completed_at: string | null
          expires_at: string
          failure_code: string | null
          id: string
          item_count: number
          lease_expires_at: string | null
          lease_token: string | null
          next_ordinal: number
          ready_at: string
          request_id: string
          requested_at: string
          requested_by: string
          snapshot_at: string | null
          snapshot_visibility: unknown
          source_expires_at: string | null
          status: string
          workspace_id: string
        }
        Insert: {
          cleaned_at?: string | null
          completed_at?: string | null
          expires_at?: string
          failure_code?: string | null
          id?: string
          item_count?: number
          lease_expires_at?: string | null
          lease_token?: string | null
          next_ordinal?: number
          ready_at?: string
          request_id: string
          requested_at?: string
          requested_by: string
          snapshot_at?: string | null
          snapshot_visibility?: unknown
          source_expires_at?: string | null
          status?: string
          workspace_id: string
        }
        Update: {
          cleaned_at?: string | null
          completed_at?: string | null
          expires_at?: string
          failure_code?: string | null
          id?: string
          item_count?: number
          lease_expires_at?: string | null
          lease_token?: string | null
          next_ordinal?: number
          ready_at?: string
          request_id?: string
          requested_at?: string
          requested_by?: string
          snapshot_at?: string | null
          snapshot_visibility?: unknown
          source_expires_at?: string | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_exports_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sandbox_capability_checks: {
        Row: {
          agent_model: string | null
          agent_provider: string | null
          capabilities: Json
          checked_at: string
          created_at: string
          error_text: string | null
          factory_definition_digest: string | null
          github_repository_id: string | null
          id: string
          sandbox_connection_revision: string | null
          sandbox_id: string | null
          sandbox_provider: string | null
          sandbox_vercel_project_id: string | null
          sandbox_vercel_team_id: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          agent_model?: string | null
          agent_provider?: string | null
          capabilities?: Json
          checked_at?: string
          created_at?: string
          error_text?: string | null
          factory_definition_digest?: string | null
          github_repository_id?: string | null
          id?: string
          sandbox_connection_revision?: string | null
          sandbox_id?: string | null
          sandbox_provider?: string | null
          sandbox_vercel_project_id?: string | null
          sandbox_vercel_team_id?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          agent_model?: string | null
          agent_provider?: string | null
          capabilities?: Json
          checked_at?: string
          created_at?: string
          error_text?: string | null
          factory_definition_digest?: string | null
          github_repository_id?: string | null
          id?: string
          sandbox_connection_revision?: string | null
          sandbox_id?: string | null
          sandbox_provider?: string | null
          sandbox_vercel_project_id?: string | null
          sandbox_vercel_team_id?: string | null
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
      service_principals: {
        Row: {
          created_at: string
          created_by_member_id: string
          factory_id: string
          id: string
          name: string
          slug: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by_member_id: string
          factory_id: string
          id?: string
          name: string
          slug: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by_member_id?: string
          factory_id?: string
          id?: string
          name?: string
          slug?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_principals_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
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
      session_attachments: {
        Row: {
          attached_at: string | null
          content_type: string
          created_at: string
          delete_claimed_at: string | null
          expires_at: string | null
          id: string
          original_filename: string
          position: number | null
          session_id: string | null
          size_bytes: number
          status: string
          storage_path: string
          uploaded_by_member_id: string | null
          workspace_id: string
        }
        Insert: {
          attached_at?: string | null
          content_type: string
          created_at?: string
          delete_claimed_at?: string | null
          expires_at?: string | null
          id?: string
          original_filename: string
          position?: number | null
          session_id?: string | null
          size_bytes: number
          status?: string
          storage_path: string
          uploaded_by_member_id?: string | null
          workspace_id: string
        }
        Update: {
          attached_at?: string | null
          content_type?: string
          created_at?: string
          delete_claimed_at?: string | null
          expires_at?: string | null
          id?: string
          original_filename?: string
          position?: number | null
          session_id?: string | null
          size_bytes?: number
          status?: string
          storage_path?: string
          uploaded_by_member_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_attachments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_attachments_uploaded_by_member_id_fkey"
            columns: ["uploaded_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_attachments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_attempt_manifests: {
        Row: {
          agent_effort: string | null
          attempt_count: number
          base_branch: string
          checkout_sha: string
          created_at: string
          credential_owner_member_id: string | null
          definition_delivery_policy_revision_id: string | null
          definition_digest: string | null
          definition_execution_policy_revision_id: string | null
          definition_provenance: string
          definition_revision_id: string | null
          definition_skill_ids: string[]
          definition_tool_ids: string[]
          execution_policy_revision_id: string | null
          initial_base_sha: string
          input_ref: string | null
          input_sha: string
          job_id: string
          max_turns: number | null
          model_name: string
          model_provider: string
          predecessors: Json
          prompt_sha256: string
          prompt_utf8_bytes: number
          renderer_version: number
          repository_full_name: string
          repository_id: string
          retry_source_run_id: string | null
          routing_decision_session_id: string | null
          run_id: string
          run_type: string
          sandbox_connection_revision: string | null
          sandbox_provider: string | null
          session_id: string
          source_checkpoint_run_id: string | null
          stage_id: string
          worker_runtime: string
          workspace_id: string
        }
        Insert: {
          agent_effort?: string | null
          attempt_count: number
          base_branch: string
          checkout_sha: string
          created_at?: string
          credential_owner_member_id?: string | null
          definition_delivery_policy_revision_id?: string | null
          definition_digest?: string | null
          definition_execution_policy_revision_id?: string | null
          definition_provenance: string
          definition_revision_id?: string | null
          definition_skill_ids: string[]
          definition_tool_ids: string[]
          execution_policy_revision_id?: string | null
          initial_base_sha: string
          input_ref?: string | null
          input_sha: string
          job_id: string
          max_turns?: number | null
          model_name: string
          model_provider: string
          predecessors: Json
          prompt_sha256: string
          prompt_utf8_bytes: number
          renderer_version: number
          repository_full_name: string
          repository_id: string
          retry_source_run_id?: string | null
          routing_decision_session_id?: string | null
          run_id: string
          run_type: string
          sandbox_connection_revision?: string | null
          sandbox_provider?: string | null
          session_id: string
          source_checkpoint_run_id?: string | null
          stage_id: string
          worker_runtime: string
          workspace_id: string
        }
        Update: {
          agent_effort?: string | null
          attempt_count?: number
          base_branch?: string
          checkout_sha?: string
          created_at?: string
          credential_owner_member_id?: string | null
          definition_delivery_policy_revision_id?: string | null
          definition_digest?: string | null
          definition_execution_policy_revision_id?: string | null
          definition_provenance?: string
          definition_revision_id?: string | null
          definition_skill_ids?: string[]
          definition_tool_ids?: string[]
          execution_policy_revision_id?: string | null
          initial_base_sha?: string
          input_ref?: string | null
          input_sha?: string
          job_id?: string
          max_turns?: number | null
          model_name?: string
          model_provider?: string
          predecessors?: Json
          prompt_sha256?: string
          prompt_utf8_bytes?: number
          renderer_version?: number
          repository_full_name?: string
          repository_id?: string
          retry_source_run_id?: string | null
          routing_decision_session_id?: string | null
          run_id?: string
          run_type?: string
          sandbox_connection_revision?: string | null
          sandbox_provider?: string | null
          session_id?: string
          source_checkpoint_run_id?: string | null
          stage_id?: string
          worker_runtime?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_attempt_manifests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_attempt_manifests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_attempt_manifests_routing_decision_session_id_fkey"
            columns: ["routing_decision_session_id"]
            isOneToOne: false
            referencedRelation: "session_factory_admission_inputs"
            referencedColumns: ["session_id"]
          },
          {
            foreignKeyName: "session_attempt_manifests_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_attempt_manifests_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_attempt_manifests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_browser_asset_withholdings: {
        Row: {
          asset_id: string
          cleanup_available_at: string
          cleanup_claim_id: string | null
          purged_at: string | null
          recorded_at: string
          state: string
        }
        Insert: {
          asset_id: string
          cleanup_available_at?: string
          cleanup_claim_id?: string | null
          purged_at?: string | null
          recorded_at?: string
          state: string
        }
        Update: {
          asset_id?: string
          cleanup_available_at?: string
          cleanup_claim_id?: string | null
          purged_at?: string | null
          recorded_at?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_browser_asset_withholdings_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "session_browser_verification_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      session_browser_verification_assets: {
        Row: {
          approval_scope_id: string
          browser_session_id: string
          capture_completed_at: string | null
          capture_started_at: string | null
          content_type: string
          duration_ms: number | null
          evidence_key: string
          frame_offsets_ms: number[] | null
          height_px: number | null
          id: string
          required: boolean
          run_id: string
          session_id: string
          sha256: string
          size_bytes: number
          storage_path: string
          width_px: number | null
          workspace_id: string
        }
        Insert: {
          approval_scope_id: string
          browser_session_id: string
          capture_completed_at?: string | null
          capture_started_at?: string | null
          content_type: string
          duration_ms?: number | null
          evidence_key: string
          frame_offsets_ms?: number[] | null
          height_px?: number | null
          id: string
          required: boolean
          run_id: string
          session_id: string
          sha256: string
          size_bytes: number
          storage_path: string
          width_px?: number | null
          workspace_id: string
        }
        Update: {
          approval_scope_id?: string
          browser_session_id?: string
          capture_completed_at?: string | null
          capture_started_at?: string | null
          content_type?: string
          duration_ms?: number | null
          evidence_key?: string
          frame_offsets_ms?: number[] | null
          height_px?: number | null
          id?: string
          required?: boolean
          run_id?: string
          session_id?: string
          sha256?: string
          size_bytes?: number
          storage_path?: string
          width_px?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_browser_verification__run_id_workspace_id_session__fkey"
            columns: ["run_id", "workspace_id", "session_id"]
            isOneToOne: false
            referencedRelation: "session_browser_verification_receipts"
            referencedColumns: ["run_id", "workspace_id", "session_id"]
          },
        ]
      }
      session_browser_verification_receipts: {
        Row: {
          created_at: string
          records: Json
          run_id: string
          session_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          records: Json
          run_id: string
          session_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          records?: Json
          run_id?: string
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_browser_verification_receipts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "session_validation_plans"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_browser_verification_receipts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_browser_verification_receipts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_checkpoint_cleanup: {
        Row: {
          attempt_count: number
          claim_id: string | null
          cleanup_attempt_count: number
          created_at: string
          eligible_after: string
          expected_sha: string
          github_repository_id: number | null
          job_id: string
          last_error_code: string | null
          lease_expires_at: string | null
          next_attempt_at: string
          remote_absent_at: string | null
          repository_full_name: string
          repository_id: string
          retained_ref: string
          run_id: string
          session_id: string
          status: string
          workspace_id: string
        }
        Insert: {
          attempt_count: number
          claim_id?: string | null
          cleanup_attempt_count?: number
          created_at?: string
          eligible_after: string
          expected_sha: string
          github_repository_id?: number | null
          job_id: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          remote_absent_at?: string | null
          repository_full_name: string
          repository_id: string
          retained_ref: string
          run_id: string
          session_id: string
          status?: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          claim_id?: string | null
          cleanup_attempt_count?: number
          created_at?: string
          eligible_after?: string
          expected_sha?: string
          github_repository_id?: number | null
          job_id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          remote_absent_at?: string | null
          repository_full_name?: string
          repository_id?: string
          retained_ref?: string
          run_id?: string
          session_id?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_checkpoint_cleanup_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_checkpoint_cleanup_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_checkpoint_cleanup_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "session_checkpoint_publications"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_checkpoint_cleanup_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_checkpoint_cleanup_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_checkpoint_publications: {
        Row: {
          adopted_at: string | null
          artifact_id: string | null
          artifact_md: string
          attempt_count: number
          claim_id: string | null
          created_at: string
          deadline_at: string
          expected_artifact_version: number
          job_id: string
          last_error_code: string | null
          lease_expires_at: string | null
          next_attempt_at: string
          publication_attempt_count: number
          remote_verified_at: string | null
          remote_verified_ref: string | null
          remote_verified_sha: string | null
          retained_ref: string | null
          run_id: string
          session_id: string
          status: string
          workspace_id: string
        }
        Insert: {
          adopted_at?: string | null
          artifact_id?: string | null
          artifact_md: string
          attempt_count: number
          claim_id?: string | null
          created_at?: string
          deadline_at: string
          expected_artifact_version: number
          job_id: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          publication_attempt_count?: number
          remote_verified_at?: string | null
          remote_verified_ref?: string | null
          remote_verified_sha?: string | null
          retained_ref?: string | null
          run_id: string
          session_id: string
          status?: string
          workspace_id: string
        }
        Update: {
          adopted_at?: string | null
          artifact_id?: string | null
          artifact_md?: string
          attempt_count?: number
          claim_id?: string | null
          created_at?: string
          deadline_at?: string
          expected_artifact_version?: number
          job_id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          publication_attempt_count?: number
          remote_verified_at?: string | null
          remote_verified_ref?: string | null
          remote_verified_sha?: string | null
          retained_ref?: string | null
          run_id?: string
          session_id?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_checkpoint_publications_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: true
            referencedRelation: "session_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_checkpoint_publications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_checkpoint_publications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_checkpoint_publications_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "session_source_deliveries"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_checkpoint_publications_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_checkpoint_publications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_conversation_messages: {
        Row: {
          artifact_id: string | null
          attempt_count: number | null
          author_kind: Database["public"]["Enums"]["session_conversation_author_kind"]
          author_label: string
          body_md: string
          body_truncated: boolean
          created_at: string
          external_actor_id: string | null
          external_message_id: string | null
          factory_id: string
          feedback_batch_id: string | null
          kind: Database["public"]["Enums"]["session_conversation_message_kind"]
          originating_member_id: string | null
          originating_service_principal_id: string | null
          provenance_version: number
          run_id: string | null
          sequence: number
          session_id: string
          source_id: string | null
          workspace_id: string
        }
        Insert: {
          artifact_id?: string | null
          attempt_count?: number | null
          author_kind: Database["public"]["Enums"]["session_conversation_author_kind"]
          author_label: string
          body_md: string
          body_truncated?: boolean
          created_at?: string
          external_actor_id?: string | null
          external_message_id?: string | null
          factory_id: string
          feedback_batch_id?: string | null
          kind: Database["public"]["Enums"]["session_conversation_message_kind"]
          originating_member_id?: string | null
          originating_service_principal_id?: string | null
          provenance_version?: number
          run_id?: string | null
          sequence: number
          session_id: string
          source_id?: string | null
          workspace_id: string
        }
        Update: {
          artifact_id?: string | null
          attempt_count?: number | null
          author_kind?: Database["public"]["Enums"]["session_conversation_author_kind"]
          author_label?: string
          body_md?: string
          body_truncated?: boolean
          created_at?: string
          external_actor_id?: string | null
          external_message_id?: string | null
          factory_id?: string
          feedback_batch_id?: string | null
          kind?: Database["public"]["Enums"]["session_conversation_message_kind"]
          originating_member_id?: string | null
          originating_service_principal_id?: string | null
          provenance_version?: number
          run_id?: string | null
          sequence?: number
          session_id?: string
          source_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_conversation_messages_session_id_source_id_fkey"
            columns: ["session_id", "source_id"]
            isOneToOne: false
            referencedRelation: "session_conversation_sources"
            referencedColumns: ["session_id", "id"]
          },
          {
            foreignKeyName: "session_conversation_messages_session_id_workspace_id_fact_fkey"
            columns: ["session_id", "workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "session_conversations"
            referencedColumns: ["session_id", "workspace_id", "factory_id"]
          },
        ]
      }
      session_conversation_sources: {
        Row: {
          created_at: string
          external_thread_id: string
          factory_id: string
          id: string
          label: string | null
          provider: string
          session_id: string
          source_namespace: string
          source_url: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          external_thread_id: string
          factory_id: string
          id?: string
          label?: string | null
          provider: string
          session_id: string
          source_namespace: string
          source_url?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          external_thread_id?: string
          factory_id?: string
          id?: string
          label?: string | null
          provider?: string
          session_id?: string
          source_namespace?: string
          source_url?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_conversation_sources_session_id_workspace_id_facto_fkey"
            columns: ["session_id", "workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "session_conversations"
            referencedColumns: ["session_id", "workspace_id", "factory_id"]
          },
        ]
      }
      session_conversations: {
        Row: {
          factory_id: string
          last_sequence: number
          session_id: string
          workspace_id: string
        }
        Insert: {
          factory_id: string
          last_sequence?: number
          session_id: string
          workspace_id: string
        }
        Update: {
          factory_id?: string
          last_sequence?: number
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_conversations_session_id_workspace_id_factory_id_fkey"
            columns: ["session_id", "workspace_id", "factory_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id", "workspace_id", "factory_id"]
          },
        ]
      }
      session_factory_admission_inputs: {
        Row: {
          activation_number: number
          budget_payer_member_id: string | null
          created_at: string
          credential_owner_member_id: string | null
          credential_owner_service_principal_id: string | null
          definition_digest: string
          definition_revision_id: string
          execution_grant_id: string | null
          execution_grant_version: number | null
          execution_policy_revision_id: string | null
          factory_id: string
          github_repository_id: string | null
          invoking_actor_member_id: string | null
          invoking_actor_service_principal_id: string | null
          model_name: string
          model_provider: string
          original_prompt_md: string | null
          original_title: string | null
          pipeline_id: string
          prompt_sha256: string
          routing_canary_arm: string | null
          routing_canary_baseline_execution: Json | null
          routing_canary_bucket: number | null
          routing_canary_eligible: boolean | null
          routing_canary_id: string | null
          routing_decision: Json | null
          routing_execution: Json | null
          selected_stage_ids: string[]
          session_id: string
          title_sha256: string
          workspace_id: string
        }
        Insert: {
          activation_number: number
          budget_payer_member_id?: string | null
          created_at?: string
          credential_owner_member_id?: string | null
          credential_owner_service_principal_id?: string | null
          definition_digest: string
          definition_revision_id: string
          execution_grant_id?: string | null
          execution_grant_version?: number | null
          execution_policy_revision_id?: string | null
          factory_id: string
          github_repository_id?: string | null
          invoking_actor_member_id?: string | null
          invoking_actor_service_principal_id?: string | null
          model_name: string
          model_provider: string
          original_prompt_md?: string | null
          original_title?: string | null
          pipeline_id: string
          prompt_sha256: string
          routing_canary_arm?: string | null
          routing_canary_baseline_execution?: Json | null
          routing_canary_bucket?: number | null
          routing_canary_eligible?: boolean | null
          routing_canary_id?: string | null
          routing_decision?: Json | null
          routing_execution?: Json | null
          selected_stage_ids: string[]
          session_id: string
          title_sha256: string
          workspace_id: string
        }
        Update: {
          activation_number?: number
          budget_payer_member_id?: string | null
          created_at?: string
          credential_owner_member_id?: string | null
          credential_owner_service_principal_id?: string | null
          definition_digest?: string
          definition_revision_id?: string
          execution_grant_id?: string | null
          execution_grant_version?: number | null
          execution_policy_revision_id?: string | null
          factory_id?: string
          github_repository_id?: string | null
          invoking_actor_member_id?: string | null
          invoking_actor_service_principal_id?: string | null
          model_name?: string
          model_provider?: string
          original_prompt_md?: string | null
          original_title?: string | null
          pipeline_id?: string
          prompt_sha256?: string
          routing_canary_arm?: string | null
          routing_canary_baseline_execution?: Json | null
          routing_canary_bucket?: number | null
          routing_canary_eligible?: boolean | null
          routing_canary_id?: string | null
          routing_decision?: Json | null
          routing_execution?: Json | null
          selected_stage_ids?: string[]
          session_id?: string
          title_sha256?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_factory_admission_canary_scope_fk"
            columns: [
              "workspace_id",
              "factory_id",
              "routing_canary_id",
              "activation_number",
            ]
            isOneToOne: false
            referencedRelation: "factory_routing_canaries"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "session_factory_admission_inp_workspace_id_definition_revi_fkey"
            columns: ["workspace_id", "definition_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_definition_revisions"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "session_factory_admission_inp_workspace_id_factory_id_acti_fkey"
            columns: ["workspace_id", "factory_id", "activation_number"]
            isOneToOne: false
            referencedRelation: "factory_definition_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "session_factory_admission_inputs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_factory_routing_overrides: {
        Row: {
          activation_number: number
          actor_member_id: string
          created_at: string
          factory_id: string
          reason: string
          routing_execution: Json
          rule_id: string
          session_id: string
          target: string
          workspace_id: string
        }
        Insert: {
          activation_number: number
          actor_member_id: string
          created_at?: string
          factory_id: string
          reason: string
          routing_execution: Json
          rule_id: string
          session_id: string
          target: string
          workspace_id: string
        }
        Update: {
          activation_number?: number
          actor_member_id?: string
          created_at?: string
          factory_id?: string
          reason?: string
          routing_execution?: Json
          rule_id?: string
          session_id?: string
          target?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_factory_routing_overr_session_id_workspace_id_fact_fkey"
            columns: ["session_id", "workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id", "workspace_id", "factory_id"]
          },
          {
            foreignKeyName: "session_factory_routing_overr_workspace_id_factory_id_acti_fkey"
            columns: ["workspace_id", "factory_id", "activation_number"]
            isOneToOne: false
            referencedRelation: "factory_routing_activations"
            referencedColumns: [
              "workspace_id",
              "factory_id",
              "activation_number",
            ]
          },
          {
            foreignKeyName: "session_factory_routing_overrides_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "session_factory_admission_inputs"
            referencedColumns: ["session_id"]
          },
        ]
      }
      session_git_checkpoints: {
        Row: {
          artifact_id: string
          attempt_count: number
          bundle_sha256: string | null
          checkpoint_path: string | null
          created_at: string
          initial_base_sha: string
          input_sha: string
          job_id: string
          output_kind: string
          output_ref: string | null
          output_sha: string
          repository_full_name: string
          repository_id: string
          run_id: string
          session_id: string
          workspace_id: string
        }
        Insert: {
          artifact_id: string
          attempt_count: number
          bundle_sha256?: string | null
          checkpoint_path?: string | null
          created_at?: string
          initial_base_sha: string
          input_sha: string
          job_id: string
          output_kind: string
          output_ref?: string | null
          output_sha: string
          repository_full_name: string
          repository_id: string
          run_id: string
          session_id: string
          workspace_id: string
        }
        Update: {
          artifact_id?: string
          attempt_count?: number
          bundle_sha256?: string | null
          checkpoint_path?: string | null
          created_at?: string
          initial_base_sha?: string
          input_sha?: string
          job_id?: string
          output_kind?: string
          output_ref?: string | null
          output_sha?: string
          repository_full_name?: string
          repository_id?: string
          run_id?: string
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_git_checkpoints_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: true
            referencedRelation: "session_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_source_delivery_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "session_source_deliveries"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_git_continuity_enrollments: {
        Row: {
          created_at: string
          release_version: number
          session_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          release_version?: number
          session_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          release_version?: number
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_git_continuity_enrollments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_continuity_enrollments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_git_heads: {
        Row: {
          checkpoint_run_id: string
          session_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          checkpoint_run_id: string
          session_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          checkpoint_run_id?: string
          session_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_git_heads_checkpoint_run_id_fkey"
            columns: ["checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_outputs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_git_heads_checkpoint_run_id_fkey"
            columns: ["checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "session_git_checkpoints"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_git_heads_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_heads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_git_roots: {
        Row: {
          base_branch: string
          created_at: string
          initial_base_sha: string
          repository_full_name: string
          repository_id: string
          session_id: string
          workspace_id: string
        }
        Insert: {
          base_branch: string
          created_at?: string
          initial_base_sha: string
          repository_full_name: string
          repository_id: string
          session_id: string
          workspace_id: string
        }
        Update: {
          base_branch?: string
          created_at?: string
          initial_base_sha?: string
          repository_full_name?: string
          repository_id?: string
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_git_roots_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_roots_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_job_git_inputs: {
        Row: {
          base_branch: string
          created_at: string
          initial_base_sha: string
          input_ref: string | null
          input_sha: string
          job_id: string
          pinned_attempt_count: number | null
          pinned_run_id: string | null
          repository_full_name: string
          repository_id: string
          session_id: string
          source_checkpoint_run_id: string | null
          workspace_id: string
        }
        Insert: {
          base_branch: string
          created_at?: string
          initial_base_sha: string
          input_ref?: string | null
          input_sha: string
          job_id: string
          pinned_attempt_count?: number | null
          pinned_run_id?: string | null
          repository_full_name: string
          repository_id: string
          session_id: string
          source_checkpoint_run_id?: string | null
          workspace_id: string
        }
        Update: {
          base_branch?: string
          created_at?: string
          initial_base_sha?: string
          input_ref?: string | null
          input_sha?: string
          job_id?: string
          pinned_attempt_count?: number | null
          pinned_run_id?: string | null
          repository_full_name?: string
          repository_id?: string
          session_id?: string
          source_checkpoint_run_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_job_git_inputs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_job_git_inputs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_job_git_inputs_pinned_run_id_fkey"
            columns: ["pinned_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_job_git_inputs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_job_git_inputs_source_checkpoint_run_id_fkey"
            columns: ["source_checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_outputs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_job_git_inputs_source_checkpoint_run_id_fkey"
            columns: ["source_checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "session_git_checkpoints"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_job_git_inputs_workspace_id_fkey"
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
      session_pr_epochs: {
        Row: {
          acknowledged_fence_sha: string | null
          acknowledged_head_sha: string | null
          base_branch: string
          branch_name: string
          create_attempted: boolean
          created_at: string
          epoch_number: number
          fence_branch: string
          github_repository_id: number
          id: string
          is_draft: boolean | null
          observation_id: string | null
          pr_head_sha: string | null
          pr_number: number | null
          pr_state: string | null
          pr_updated_at: string | null
          pr_url: string | null
          repository_full_name: string
          repository_id: string | null
          session_id: string
          workspace_id: string
        }
        Insert: {
          acknowledged_fence_sha?: string | null
          acknowledged_head_sha?: string | null
          base_branch: string
          branch_name: string
          create_attempted?: boolean
          created_at?: string
          epoch_number: number
          fence_branch: string
          github_repository_id: number
          id?: string
          is_draft?: boolean | null
          observation_id?: string | null
          pr_head_sha?: string | null
          pr_number?: number | null
          pr_state?: string | null
          pr_updated_at?: string | null
          pr_url?: string | null
          repository_full_name: string
          repository_id?: string | null
          session_id: string
          workspace_id: string
        }
        Update: {
          acknowledged_fence_sha?: string | null
          acknowledged_head_sha?: string | null
          base_branch?: string
          branch_name?: string
          create_attempted?: boolean
          created_at?: string
          epoch_number?: number
          fence_branch?: string
          github_repository_id?: number
          id?: string
          is_draft?: boolean | null
          observation_id?: string | null
          pr_head_sha?: string | null
          pr_number?: number | null
          pr_state?: string | null
          pr_updated_at?: string | null
          pr_url?: string | null
          repository_full_name?: string
          repository_id?: string | null
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_pr_epochs_repository_id_fkey"
            columns: ["repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_epochs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_epochs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_pr_operations: {
        Row: {
          attempt_count: number
          checkpoint_run_id: string
          claim_id: string | null
          created_at: string
          desired_fence_sha: string
          desired_sha: string
          epoch_id: string
          expected_fence_sha: string | null
          expected_head_sha: string | null
          fence_commit_body: string
          git_continuity_release_revision: number | null
          id: string
          last_error_code: string | null
          lease_expires_at: string | null
          next_attempt_at: string
          receipt_fence_sha: string | null
          receipt_head_sha: string | null
          receipt_observation_id: string | null
          receipt_pr_head_sha: string | null
          receipt_pr_number: number | null
          receipt_pr_state: string | null
          receipted_at: string | null
          session_id: string
          source_ref: string
          status: string
          target_generation: number
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          checkpoint_run_id: string
          claim_id?: string | null
          created_at?: string
          desired_fence_sha: string
          desired_sha: string
          epoch_id: string
          expected_fence_sha?: string | null
          expected_head_sha?: string | null
          fence_commit_body: string
          git_continuity_release_revision?: number | null
          id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          receipt_fence_sha?: string | null
          receipt_head_sha?: string | null
          receipt_observation_id?: string | null
          receipt_pr_head_sha?: string | null
          receipt_pr_number?: number | null
          receipt_pr_state?: string | null
          receipted_at?: string | null
          session_id: string
          source_ref: string
          status?: string
          target_generation: number
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          checkpoint_run_id?: string
          claim_id?: string | null
          created_at?: string
          desired_fence_sha?: string
          desired_sha?: string
          epoch_id?: string
          expected_fence_sha?: string | null
          expected_head_sha?: string | null
          fence_commit_body?: string
          git_continuity_release_revision?: number | null
          id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          receipt_fence_sha?: string | null
          receipt_head_sha?: string | null
          receipt_observation_id?: string | null
          receipt_pr_head_sha?: string | null
          receipt_pr_number?: number | null
          receipt_pr_state?: string | null
          receipted_at?: string | null
          session_id?: string
          source_ref?: string
          status?: string
          target_generation?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_pr_operations_checkpoint_run_id_fkey"
            columns: ["checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_outputs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_pr_operations_checkpoint_run_id_fkey"
            columns: ["checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "session_git_checkpoints"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_pr_operations_epoch_id_fkey"
            columns: ["epoch_id"]
            isOneToOne: false
            referencedRelation: "session_pr_epochs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_operations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_operations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_pr_refresh_queue: {
        Row: {
          attempt_count: number
          claim_generation: number | null
          claim_token: string | null
          context: Json | null
          last_error_code: string | null
          last_observation_id: string | null
          lease_expires_at: string | null
          next_attempt_at: string
          requested_generation: number
          session_id: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          claim_generation?: number | null
          claim_token?: string | null
          context?: Json | null
          last_error_code?: string | null
          last_observation_id?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          requested_generation?: number
          session_id: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          claim_generation?: number | null
          claim_token?: string | null
          context?: Json | null
          last_error_code?: string | null
          last_observation_id?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          requested_generation?: number
          session_id?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_pr_refresh_queue_last_observation_id_fkey"
            columns: ["last_observation_id"]
            isOneToOne: false
            referencedRelation: "session_pr_verification_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_refresh_queue_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_refresh_queue_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_pr_sync: {
        Row: {
          current_epoch_id: string | null
          desired_checkpoint_run_id: string
          last_error_code: string | null
          next_attempt_at: string
          observed_fence_sha: string | null
          observed_head_sha: string | null
          observed_pr_head_sha: string | null
          session_id: string
          status: string
          target_generation: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          current_epoch_id?: string | null
          desired_checkpoint_run_id: string
          last_error_code?: string | null
          next_attempt_at?: string
          observed_fence_sha?: string | null
          observed_head_sha?: string | null
          observed_pr_head_sha?: string | null
          session_id: string
          status: string
          target_generation?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          current_epoch_id?: string | null
          desired_checkpoint_run_id?: string
          last_error_code?: string | null
          next_attempt_at?: string
          observed_fence_sha?: string | null
          observed_head_sha?: string | null
          observed_pr_head_sha?: string | null
          session_id?: string
          status?: string
          target_generation?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_pr_sync_desired_checkpoint_run_id_fkey"
            columns: ["desired_checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_outputs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_pr_sync_desired_checkpoint_run_id_fkey"
            columns: ["desired_checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "session_git_checkpoints"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_pr_sync_epoch_fkey"
            columns: ["current_epoch_id"]
            isOneToOne: false
            referencedRelation: "session_pr_epochs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_sync_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_sync_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_pr_verification_observations: {
        Row: {
          artifact_review_revision: number
          base_sha: string | null
          checkpoint_run_id: string | null
          created_at: string
          head_sha: string | null
          id: string
          observed_at: string
          payload: Json
          policy_revision_id: string
          pr_epoch_id: string | null
          pr_number: number | null
          repository_full_name: string | null
          repository_id: string | null
          session_id: string
          source: string
          workspace_id: string
        }
        Insert: {
          artifact_review_revision: number
          base_sha?: string | null
          checkpoint_run_id?: string | null
          created_at?: string
          head_sha?: string | null
          id?: string
          observed_at: string
          payload: Json
          policy_revision_id: string
          pr_epoch_id?: string | null
          pr_number?: number | null
          repository_full_name?: string | null
          repository_id?: string | null
          session_id: string
          source: string
          workspace_id: string
        }
        Update: {
          artifact_review_revision?: number
          base_sha?: string | null
          checkpoint_run_id?: string | null
          created_at?: string
          head_sha?: string | null
          id?: string
          observed_at?: string
          payload?: Json
          policy_revision_id?: string
          pr_epoch_id?: string | null
          pr_number?: number | null
          repository_full_name?: string | null
          repository_id?: string | null
          session_id?: string
          source?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_pr_verification_observations_checkpoint_run_id_fkey"
            columns: ["checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_outputs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_pr_verification_observations_checkpoint_run_id_fkey"
            columns: ["checkpoint_run_id"]
            isOneToOne: false
            referencedRelation: "session_git_checkpoints"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_pr_verification_observations_policy_revision_id_fkey"
            columns: ["policy_revision_id"]
            isOneToOne: false
            referencedRelation: "delivery_policy_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_verification_observations_pr_epoch_id_fkey"
            columns: ["pr_epoch_id"]
            isOneToOne: false
            referencedRelation: "session_pr_epochs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_verification_observations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_verification_observations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_pr_verification_results: {
        Row: {
          blockers: Json
          created_at: string
          id: string
          observation_id: string
          session_id: string
          state: Database["public"]["Enums"]["pr_readiness_state"]
          workspace_id: string
        }
        Insert: {
          blockers: Json
          created_at?: string
          id?: string
          observation_id: string
          session_id: string
          state: Database["public"]["Enums"]["pr_readiness_state"]
          workspace_id: string
        }
        Update: {
          blockers?: Json
          created_at?: string
          id?: string
          observation_id?: string
          session_id?: string
          state?: Database["public"]["Enums"]["pr_readiness_state"]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_pr_verification_results_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "session_pr_verification_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_verification_results_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_verification_results_workspace_id_fkey"
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
          github_observation_token: string | null
          github_repository_id: string | null
          github_updated_at: string | null
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
          github_observation_token?: string | null
          github_repository_id?: string | null
          github_updated_at?: string | null
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
          github_observation_token?: string | null
          github_repository_id?: string | null
          github_updated_at?: string | null
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
      session_restart_lineages: {
        Row: {
          created_at: string
          linear_issue_context_id: string | null
          session_id: string
          source_session_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          linear_issue_context_id?: string | null
          session_id: string
          source_session_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          linear_issue_context_id?: string | null
          session_id?: string
          source_session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_restart_lineages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_restart_lineages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_retained_content_erasures: {
        Row: {
          actor_member_id: string
          archived_at: string
          erased_at: string
          factory_id: string
          session_id: string
          workspace_id: string
        }
        Insert: {
          actor_member_id: string
          archived_at: string
          erased_at?: string
          factory_id: string
          session_id: string
          workspace_id: string
        }
        Update: {
          actor_member_id?: string
          archived_at?: string
          erased_at?: string
          factory_id?: string
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_retained_content_erasures_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_retained_content_erasures_workspace_id_factory_id_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      session_retry_checkpoint_jobs: {
        Row: {
          job_id: string
          source_run_id: string
          workspace_id: string
        }
        Insert: {
          job_id: string
          source_run_id: string
          workspace_id: string
        }
        Update: {
          job_id?: string
          source_run_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_retry_checkpoint_jobs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_retry_checkpoint_jobs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_retry_checkpoint_jobs_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: false
            referencedRelation: "session_retry_checkpoints"
            referencedColumns: ["source_run_id"]
          },
          {
            foreignKeyName: "session_retry_checkpoint_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_retry_checkpoints: {
        Row: {
          bundle_sha256: string
          checkpoint_path: string
          head_sha: string
          input_sha: string
          rejection_count: number
          source_attempt_count: number
          source_run_id: string
          workspace_id: string
        }
        Insert: {
          bundle_sha256: string
          checkpoint_path: string
          head_sha: string
          input_sha: string
          rejection_count: number
          source_attempt_count: number
          source_run_id: string
          workspace_id: string
        }
        Update: {
          bundle_sha256?: string
          checkpoint_path?: string
          head_sha?: string
          input_sha?: string
          rejection_count?: number
          source_attempt_count?: number
          source_run_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_retry_checkpoints_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_retry_checkpoints_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_run_context_manifests: {
        Row: {
          attempt_count: number
          created_at: string
          job_id: string
          manifest: Json
          manifest_sha256: string
          origin_run_id: string | null
          run_id: string
          session_id: string
          workspace_id: string
        }
        Insert: {
          attempt_count: number
          created_at?: string
          job_id: string
          manifest: Json
          manifest_sha256: string
          origin_run_id?: string | null
          run_id: string
          session_id: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          job_id?: string
          manifest?: Json
          manifest_sha256?: string
          origin_run_id?: string | null
          run_id?: string
          session_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_run_context_manifests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_run_context_manifests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_run_context_manifests_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_run_context_manifests_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_run_context_manifests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_selected_stages: {
        Row: {
          created_at: string
          session_id: string
          stage_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          session_id: string
          stage_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          session_id?: string
          stage_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_selected_stages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_selected_stages_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_selected_stages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_source_deliveries: {
        Row: {
          attempt_count: number
          base_branch: string
          base_sha: string
          body: string
          branch_name: string
          bundle_base64: string | null
          bundle_sha256: string | null
          checkpoint_path: string | null
          claim_id: string | null
          created_at: string
          delivered_at: string | null
          delivered_ref: string | null
          delivery_attempt_count: number
          head_sha: string
          installation_id: number
          job_id: string
          last_error_code: string | null
          lease_expires_at: string | null
          next_attempt_at: string
          repository_full_name: string
          repository_id: string | null
          run_id: string
          session_id: string
          status: string
          title: string
          workspace_id: string
        }
        Insert: {
          attempt_count: number
          base_branch: string
          base_sha: string
          body: string
          branch_name: string
          bundle_base64?: string | null
          bundle_sha256?: string | null
          checkpoint_path?: string | null
          claim_id?: string | null
          created_at?: string
          delivered_at?: string | null
          delivered_ref?: string | null
          delivery_attempt_count?: number
          head_sha: string
          installation_id: number
          job_id: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          repository_full_name: string
          repository_id?: string | null
          run_id: string
          session_id: string
          status?: string
          title: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          base_branch?: string
          base_sha?: string
          body?: string
          branch_name?: string
          bundle_base64?: string | null
          bundle_sha256?: string | null
          checkpoint_path?: string | null
          claim_id?: string | null
          created_at?: string
          delivered_at?: string | null
          delivered_ref?: string | null
          delivery_attempt_count?: number
          head_sha?: string
          installation_id?: number
          job_id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          next_attempt_at?: string
          repository_full_name?: string
          repository_id?: string | null
          run_id?: string
          session_id?: string
          status?: string
          title?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_source_deliveries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_source_deliveries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_source_deliveries_repository_id_fkey"
            columns: ["repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_source_deliveries_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_source_deliveries_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_source_deliveries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_specification_clarifications: {
        Row: {
          answer_text: string | null
          answered_at: string | null
          answered_by_member_id: string | null
          answered_by_service_principal_id: string | null
          artifact_id: string
          artifact_version: number
          attempt_count: number
          created_at: string
          execution_exhausted: boolean
          factory_id: string
          feedback_batch_id: string | null
          id: string
          ordinal: number
          question: string
          run_id: string
          session_id: string
          stage_id: string
          status: Database["public"]["Enums"]["session_specification_clarification_status"]
          successor_job_id: string | null
          successor_run_id: string | null
          workspace_id: string
        }
        Insert: {
          answer_text?: string | null
          answered_at?: string | null
          answered_by_member_id?: string | null
          answered_by_service_principal_id?: string | null
          artifact_id: string
          artifact_version: number
          attempt_count: number
          created_at?: string
          execution_exhausted?: boolean
          factory_id: string
          feedback_batch_id?: string | null
          id?: string
          ordinal: number
          question: string
          run_id: string
          session_id: string
          stage_id: string
          status?: Database["public"]["Enums"]["session_specification_clarification_status"]
          successor_job_id?: string | null
          successor_run_id?: string | null
          workspace_id: string
        }
        Update: {
          answer_text?: string | null
          answered_at?: string | null
          answered_by_member_id?: string | null
          answered_by_service_principal_id?: string | null
          artifact_id?: string
          artifact_version?: number
          attempt_count?: number
          created_at?: string
          execution_exhausted?: boolean
          factory_id?: string
          feedback_batch_id?: string | null
          id?: string
          ordinal?: number
          question?: string
          run_id?: string
          session_id?: string
          stage_id?: string
          status?: Database["public"]["Enums"]["session_specification_clarification_status"]
          successor_job_id?: string | null
          successor_run_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_specification_clarifi_session_id_workspace_id_fact_fkey"
            columns: ["session_id", "workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id", "workspace_id", "factory_id"]
          },
        ]
      }
      session_stage_approval_receipts: {
        Row: {
          approval_number: number
          approved_at: string
          approved_by_member_id: string
          artifact_digest: string
          artifact_id: string
          artifact_version: number
          completion_id: string
          id: string
          session_id: string
          stage_id: string
          workspace_id: string
        }
        Insert: {
          approval_number?: never
          approved_at?: string
          approved_by_member_id: string
          artifact_digest: string
          artifact_id: string
          artifact_version: number
          completion_id: string
          id?: string
          session_id: string
          stage_id: string
          workspace_id: string
        }
        Update: {
          approval_number?: never
          approved_at?: string
          approved_by_member_id?: string
          artifact_digest?: string
          artifact_id?: string
          artifact_version?: number
          completion_id?: string
          id?: string
          session_id?: string
          stage_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_stage_approval_receipts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_stage_approval_receipts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_validation_asset_withholdings: {
        Row: {
          asset_id: string
          cleanup_available_at: string
          cleanup_claim_id: string | null
          purged_at: string | null
          recorded_at: string
          state: string
        }
        Insert: {
          asset_id: string
          cleanup_available_at?: string
          cleanup_claim_id?: string | null
          purged_at?: string | null
          recorded_at?: string
          state: string
        }
        Update: {
          asset_id?: string
          cleanup_available_at?: string
          cleanup_claim_id?: string | null
          purged_at?: string | null
          recorded_at?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_validation_asset_withholdings_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "session_validation_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      session_validation_assets: {
        Row: {
          content_type: string
          evidence_key: string
          id: string
          kind: string
          required: boolean
          run_id: string
          session_id: string
          sha256: string
          size_bytes: number
          storage_path: string
          workspace_id: string
        }
        Insert: {
          content_type: string
          evidence_key: string
          id: string
          kind: string
          required: boolean
          run_id: string
          session_id: string
          sha256: string
          size_bytes: number
          storage_path: string
          workspace_id: string
        }
        Update: {
          content_type?: string
          evidence_key?: string
          id?: string
          kind?: string
          required?: boolean
          run_id?: string
          session_id?: string
          sha256?: string
          size_bytes?: number
          storage_path?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_validation_assets_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "session_validation_evidence"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "session_validation_assets_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_validation_assets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_validation_evidence: {
        Row: {
          assets: Json
          attempt_count: number
          commit_sha: string
          created_at: string
          job_id: string
          records: Json
          repository_full_name: string
          repository_id: string
          run_id: string
          session_id: string
          validation_tree_sha: string
          workspace_id: string
        }
        Insert: {
          assets: Json
          attempt_count: number
          commit_sha: string
          created_at?: string
          job_id: string
          records: Json
          repository_full_name: string
          repository_id: string
          run_id: string
          session_id: string
          validation_tree_sha: string
          workspace_id: string
        }
        Update: {
          assets?: Json
          attempt_count?: number
          commit_sha?: string
          created_at?: string
          job_id?: string
          records?: Json
          repository_full_name?: string
          repository_id?: string
          run_id?: string
          session_id?: string
          validation_tree_sha?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_validation_evidence_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_validation_evidence_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_validation_evidence_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_validation_evidence_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_validation_evidence_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      session_validation_plans: {
        Row: {
          attempt_count: number
          commit_sha: string
          created_at: string
          job_id: string
          plan: Json
          repository_id: string
          run_id: string
          session_id: string
          validation_tree_sha: string
          workspace_id: string
        }
        Insert: {
          attempt_count: number
          commit_sha: string
          created_at?: string
          job_id: string
          plan: Json
          repository_id: string
          run_id: string
          session_id: string
          validation_tree_sha: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          commit_sha?: string
          created_at?: string
          job_id?: string
          plan?: Json
          repository_id?: string
          run_id?: string
          session_id?: string
          validation_tree_sha?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_validation_plans_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_validation_plans_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "session_validation_plans_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_validation_plans_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_validation_plans_workspace_id_fkey"
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
          artifact_review_revision: number
          created_at: string
          creator_member_id: string | null
          creator_service_principal_id: string | null
          current_artifact_id: string | null
          current_artifact_version: number
          current_stage_id: string
          execute_pinned_definition: boolean
          execution_exhausted_at: string | null
          execution_exhaustion_code: string | null
          execution_exhaustion_detail: Json | null
          execution_policy_revision_id: string | null
          execution_purpose: string
          execution_repair_attempts: number
          factory_definition_provenance: string
          factory_definition_revision_id: string | null
          factory_id: string
          github_repository_id: string | null
          id: string
          linear_issue_id: string | null
          linear_issue_url: string | null
          number: number
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          pinned_delivery_policy_revision_id: string | null
          pipeline_id: string
          prompt_md: string
          rejection_count: number
          search_document: unknown
          search_text: string | null
          specification_stage_id: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          artifact_review_revision?: number
          created_at?: string
          creator_member_id?: string | null
          creator_service_principal_id?: string | null
          current_artifact_id?: string | null
          current_artifact_version?: number
          current_stage_id: string
          execute_pinned_definition?: boolean
          execution_exhausted_at?: string | null
          execution_exhaustion_code?: string | null
          execution_exhaustion_detail?: Json | null
          execution_policy_revision_id?: string | null
          execution_purpose?: string
          execution_repair_attempts?: number
          factory_definition_provenance?: string
          factory_definition_revision_id?: string | null
          factory_id: string
          github_repository_id?: string | null
          id?: string
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          number: number
          phase_status?: Database["public"]["Enums"]["pipeline_phase_status"]
          pinned_delivery_policy_revision_id?: string | null
          pipeline_id: string
          prompt_md?: string
          rejection_count?: number
          search_document?: unknown
          search_text?: string | null
          specification_stage_id?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          artifact_review_revision?: number
          created_at?: string
          creator_member_id?: string | null
          creator_service_principal_id?: string | null
          current_artifact_id?: string | null
          current_artifact_version?: number
          current_stage_id?: string
          execute_pinned_definition?: boolean
          execution_exhausted_at?: string | null
          execution_exhaustion_code?: string | null
          execution_exhaustion_detail?: Json | null
          execution_policy_revision_id?: string | null
          execution_purpose?: string
          execution_repair_attempts?: number
          factory_definition_provenance?: string
          factory_definition_revision_id?: string | null
          factory_id?: string
          github_repository_id?: string | null
          id?: string
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          number?: number
          phase_status?: Database["public"]["Enums"]["pipeline_phase_status"]
          pinned_delivery_policy_revision_id?: string | null
          pipeline_id?: string
          prompt_md?: string
          rejection_count?: number
          search_document?: unknown
          search_text?: string | null
          specification_stage_id?: string | null
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
            foreignKeyName: "sessions_current_artifact_id_fkey"
            columns: ["current_artifact_id"]
            isOneToOne: false
            referencedRelation: "session_artifacts"
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
            foreignKeyName: "sessions_execution_policy_revision_id_fkey"
            columns: ["execution_policy_revision_id"]
            isOneToOne: false
            referencedRelation: "execution_policy_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_factory_definition_revision_fk"
            columns: ["workspace_id", "factory_definition_revision_id"]
            isOneToOne: false
            referencedRelation: "factory_definition_revisions"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "sessions_github_repository_id_fkey"
            columns: ["github_repository_id"]
            isOneToOne: false
            referencedRelation: "github_repositories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_pinned_delivery_policy_revision_id_fkey"
            columns: ["pinned_delivery_policy_revision_id"]
            isOneToOne: false
            referencedRelation: "delivery_policy_revisions"
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
            foreignKeyName: "sessions_specification_stage_id_fkey"
            columns: ["specification_stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_workspace_factory_fkey"
            columns: ["workspace_id", "factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["workspace_id", "id"]
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
          auth_reconnect_reason: string | null
          auth_reconnect_required: boolean
          created_at: string
          credential_generation: string
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
          auth_reconnect_reason?: string | null
          auth_reconnect_required?: boolean
          created_at?: string
          credential_generation?: string
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
          auth_reconnect_reason?: string | null
          auth_reconnect_required?: boolean
          created_at?: string
          credential_generation?: string
          credential_type?: string
          credential_version?: number
          encrypted_credential?: string
          scope?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_cursor_credentials: {
        Row: {
          account_email: string | null
          api_key_expires_at: string
          created_at: string
          credential_generation: string
          encrypted_api_key: string
          reconnect_reason: string | null
          reconnect_required: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          account_email?: string | null
          api_key_expires_at: string
          created_at?: string
          credential_generation?: string
          encrypted_api_key: string
          reconnect_reason?: string | null
          reconnect_required?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          account_email?: string | null
          api_key_expires_at?: string
          created_at?: string
          credential_generation?: string
          encrypted_api_key?: string
          reconnect_reason?: string | null
          reconnect_required?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_opencode_credentials: {
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
      user_opencode_provider_credentials: {
        Row: {
          created_at: string
          encrypted_api_key: string
          provider_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_api_key: string
          provider_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_api_key?: string
          provider_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      worker_auth_dispatches: {
        Row: {
          claim_token: string
          created_at: string
          dispatched_at: string | null
          execution_started_at: string | null
          expires_at: string
          flow_id: string
          workflow_id: string
        }
        Insert: {
          claim_token: string
          created_at?: string
          dispatched_at?: string | null
          execution_started_at?: string | null
          expires_at: string
          flow_id: string
          workflow_id: string
        }
        Update: {
          claim_token?: string
          created_at?: string
          dispatched_at?: string | null
          execution_started_at?: string | null
          expires_at?: string
          flow_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_auth_dispatches_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "cursor_auth_flows"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_dispatches: {
        Row: {
          attempt_count: number
          created_at: string
          deadline_at: string
          dispatched_at: string | null
          execution_started_at: string | null
          job_id: string
          workflow_id: string
          workspace_id: string
        }
        Insert: {
          attempt_count: number
          created_at?: string
          deadline_at: string
          dispatched_at?: string | null
          execution_started_at?: string | null
          job_id: string
          workflow_id: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          deadline_at?: string
          dispatched_at?: string | null
          execution_started_at?: string | null
          job_id?: string
          workflow_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_dispatches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_dispatches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "worker_dispatches_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_heartbeats: {
        Row: {
          active_job_ids: string[]
          id: string
          last_heartbeat_at: string
          metadata: Json
          started_at: string
          worker_id: string
        }
        Insert: {
          active_job_ids?: string[]
          id?: string
          last_heartbeat_at?: string
          metadata?: Json
          started_at?: string
          worker_id: string
        }
        Update: {
          active_job_ids?: string[]
          id?: string
          last_heartbeat_at?: string
          metadata?: Json
          started_at?: string
          worker_id?: string
        }
        Relationships: []
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
      workspace_daytona_sandbox_connections: {
        Row: {
          api_key_preview: string | null
          api_url: string
          connection_revision: string
          created_at: string
          created_by_member_id: string | null
          encrypted_api_key: string
          last_validated_at: string | null
          last_validation_error: string | null
          status: string
          target: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          api_key_preview?: string | null
          api_url?: string
          connection_revision?: string
          created_at?: string
          created_by_member_id?: string | null
          encrypted_api_key: string
          last_validated_at?: string | null
          last_validation_error?: string | null
          status?: string
          target?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          api_key_preview?: string | null
          api_url?: string
          connection_revision?: string
          created_at?: string
          created_by_member_id?: string | null
          encrypted_api_key?: string
          last_validated_at?: string | null
          last_validation_error?: string | null
          status?: string
          target?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_daytona_sandbox_connections_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_daytona_sandbox_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_e2b_sandbox_connections: {
        Row: {
          api_key_preview: string | null
          connection_revision: string
          created_at: string
          created_by_member_id: string | null
          encrypted_api_key: string
          last_validated_at: string | null
          last_validation_error: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          api_key_preview?: string | null
          connection_revision?: string
          created_at?: string
          created_by_member_id?: string | null
          encrypted_api_key: string
          last_validated_at?: string | null
          last_validation_error?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          api_key_preview?: string | null
          connection_revision?: string
          created_at?: string
          created_by_member_id?: string | null
          encrypted_api_key?: string
          last_validated_at?: string | null
          last_validation_error?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_e2b_sandbox_connections_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_e2b_sandbox_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
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
          full_name: string | null
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
          full_name?: string | null
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
          full_name?: string | null
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
      workspace_linear_routing: {
        Row: {
          created_at: string
          id: string
          land_stage_id: string | null
          land_stage_slug: string | null
          rework_stage_id: string | null
          rework_stage_slug: string
          status_mappings: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          land_stage_id?: string | null
          land_stage_slug?: string | null
          rework_stage_id?: string | null
          rework_stage_slug?: string
          status_mappings?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          land_stage_id?: string | null
          land_stage_slug?: string | null
          rework_stage_id?: string | null
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
      workspace_resource_operations: {
        Row: {
          connection_revision: string | null
          created_at: string
          id: string
          kind: string
          provider: string | null
          recovery_after: string
          resource_id: string | null
          settled_at: string | null
          storage_bucket: string | null
          workspace_id: string
        }
        Insert: {
          connection_revision?: string | null
          created_at?: string
          id?: string
          kind: string
          provider?: string | null
          recovery_after: string
          resource_id?: string | null
          settled_at?: string | null
          storage_bucket?: string | null
          workspace_id: string
        }
        Update: {
          connection_revision?: string | null
          created_at?: string
          id?: string
          kind?: string
          provider?: string | null
          recovery_after?: string
          resource_id?: string | null
          settled_at?: string | null
          storage_bucket?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_resource_operations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_run_retention: {
        Row: {
          context_days: number | null
          evidence_days: number | null
          last_swept_at: string | null
          transcript_days: number | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          context_days?: number | null
          evidence_days?: number | null
          last_swept_at?: string | null
          transcript_days?: number | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          context_days?: number | null
          evidence_days?: number | null
          last_swept_at?: string | null
          transcript_days?: number | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_run_retention_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_sandbox_cleanup_receipts: {
        Row: {
          confirmed_at: string
          connection_revision: string
          provider: string
          sandbox_id: string
          workspace_id: string
        }
        Insert: {
          confirmed_at?: string
          connection_revision: string
          provider: string
          sandbox_id: string
          workspace_id: string
        }
        Update: {
          confirmed_at?: string
          connection_revision?: string
          provider?: string
          sandbox_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_sandbox_cleanup_receipts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_sandbox_connection_mutations: {
        Row: {
          created_at: string
          expires_at: string
          lock_id: string
          provider: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          lock_id?: string
          provider: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          lock_id?: string
          provider?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_sandbox_connection_mutations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_sandbox_settings: {
        Row: {
          active_provider: string
          created_at: string
          revision: number
          updated_at: string
          updated_by_member_id: string | null
          workspace_id: string
        }
        Insert: {
          active_provider?: string
          created_at?: string
          revision?: number
          updated_at?: string
          updated_by_member_id?: string | null
          workspace_id: string
        }
        Update: {
          active_provider?: string
          created_at?: string
          revision?: number
          updated_at?: string
          updated_by_member_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_sandbox_settings_updated_by_member_id_fkey"
            columns: ["updated_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_sandbox_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
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
          material_revision: number
          material_rotated_at: string | null
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
          material_revision?: number
          material_rotated_at?: string | null
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
          material_revision?: number
          material_rotated_at?: string | null
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
      workspace_vercel_sandbox_connections: {
        Row: {
          connection_revision: string
          created_at: string
          created_by_member_id: string | null
          encrypted_token: string
          last_validated_at: string | null
          last_validation_error: string | null
          project_id: string
          project_name: string | null
          status: string
          team_id: string
          token_preview: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          connection_revision?: string
          created_at?: string
          created_by_member_id?: string | null
          encrypted_token: string
          last_validated_at?: string | null
          last_validation_error?: string | null
          project_id: string
          project_name?: string | null
          status?: string
          team_id: string
          token_preview?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          connection_revision?: string
          created_at?: string
          created_by_member_id?: string | null
          encrypted_token?: string
          last_validated_at?: string | null
          last_validation_error?: string | null
          project_id?: string
          project_name?: string | null
          status?: string
          team_id?: string
          token_preview?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_vercel_sandbox_connections_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_vercel_sandbox_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
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
          deletion_requested_at: string | null
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          avatar_path?: string | null
          created_at?: string
          created_by?: string | null
          deletion_requested_at?: string | null
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          created_by?: string | null
          deletion_requested_at?: string | null
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      artifact_feedback_outputs: {
        Row: {
          artifact_id: string | null
          artifact_version: number | null
          batch_id: string | null
          created_at: string | null
          job_id: string | null
          run_id: string | null
          session_id: string | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "artifact_feedback_batch_jobs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "artifact_feedback_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_jobs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_jobs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "pinned_job_recovery_settings"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_jobs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifact_feedback_batch_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: true
            referencedRelation: "session_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_git_checkpoints_source_delivery_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "session_source_deliveries"
            referencedColumns: ["run_id"]
          },
        ]
      }
      pinned_job_recovery_settings: {
        Row: {
          job_id: string | null
          max_retries: number | null
          stall_timeout_ms: number | null
        }
        Relationships: []
      }
      session_pr_verification_currentness: {
        Row: {
          blockers: Json | null
          created_at: string | null
          id: string | null
          is_current: boolean | null
          observation_id: string | null
          session_id: string | null
          state: Database["public"]["Enums"]["pr_readiness_state"] | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_pr_verification_results_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "session_pr_verification_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_verification_results_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_pr_verification_results_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
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
      acquire_factory_workflow_ownership: {
        Args: {
          p_candidate_ownership_token: string
          p_expected_generation: number
          p_factory_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          execution_generation: number
          ownership_token: string
        }[]
      }
      activate_factory_routing_canary: {
        Args: {
          p_actor_user_id: string
          p_candidate_bps: number
          p_draft_id: string
          p_enabled_sandbox_providers: string[]
          p_expected_activation_number: number
          p_factory_id: string
          p_required_probes: string[]
          p_task_class_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      activate_reviewed_factory_routing: {
        Args: {
          p_actor_user_id: string
          p_draft_id: string
          p_enabled_sandbox_providers: string[]
          p_expected_activation_number: number
          p_factory_id: string
          p_required_probes: string[]
          p_workspace_id: string
        }
        Returns: Json
      }
      adjudicate_factory_evaluation_receipt: {
        Args: {
          p_actor_user_id: string
          p_adjudication_id: string
          p_attempt_id: string
          p_disposition: string
          p_expected_status?: string
          p_factory_id: string
          p_note: string
          p_workspace_id: string
        }
        Returns: Json
      }
      admit_factory_benchmark_trial: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_fixture_key: string
          p_policy_digest: string
          p_policy_revision_id: string
          p_sandbox_connection_revision: string
          p_task_revision_id: string
          p_trial_id: string
          p_workspace_id: string
        }
        Returns: {
          actor_user_id: string
          attempt_count: number | null
          created_at: string
          deadline_at: string | null
          effective_execution_digest: string | null
          factory_id: string
          failure_code: string | null
          finished_at: string | null
          fixture_key: string | null
          fixture_revision_id: string | null
          id: string
          inference_connection_revision: string | null
          job_id: string
          policy_digest: string
          policy_revision_id: string
          replay_execution_id: string
          run_id: string
          runner_revision: string
          sandbox_connection_revision: string
          session_id: string
          status: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_benchmark_trials"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admit_factory_command:
        | {
            Args: {
              p_credential_digest: string
              p_credential_id: string
              p_credential_kind: Database["public"]["Enums"]["factory_command_credential_kind"]
              p_factory_id: string
              p_request_hash: string
              p_request_id: string
              p_scope: Database["public"]["Enums"]["factory_command_scope"]
              p_surface: Database["public"]["Enums"]["factory_command_surface"]
              p_workspace_id: string
            }
            Returns: {
              admission_id: string
              consenting_member_id: string
              execution_grant_id: string
              execution_grant_version: number
              factory_id: string
              lease_expires_at: string
              lease_id: string
              retry_after_seconds: number
              scope: Database["public"]["Enums"]["factory_command_scope"]
              service_principal_id: string
              status: Database["public"]["Enums"]["factory_command_admission_status"]
              workspace_id: string
            }[]
          }
        | {
            Args: {
              p_credential_digest: string
              p_credential_id: string
              p_credential_kind: Database["public"]["Enums"]["factory_command_credential_kind"]
              p_factory_id: string
              p_request_hash: string
              p_request_id: string
              p_resource: string
              p_scope: Database["public"]["Enums"]["factory_command_scope"]
              p_surface: Database["public"]["Enums"]["factory_command_surface"]
              p_workspace_id: string
            }
            Returns: {
              admission_id: string
              consenting_member_id: string
              execution_grant_id: string
              execution_grant_version: number
              factory_id: string
              lease_expires_at: string
              lease_id: string
              retry_after_seconds: number
              scope: Database["public"]["Enums"]["factory_command_scope"]
              service_principal_id: string
              status: Database["public"]["Enums"]["factory_command_admission_status"]
              workspace_id: string
            }[]
          }
      admit_factory_workflow_branch_slot: {
        Args: {
          p_branch_edge_id: string
          p_expected_generation: number
          p_factory_id: string
          p_group_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          child_session_id: string
          created: boolean
          job_id: string
          run_id: string
          target_occurrence_id: string
        }[]
      }
      admit_factory_workflow_delegated_session: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_parent_session_id: string
          p_prompt_md: string
          p_root_session_id: string
          p_source_checkpoint_run_id: string
          p_target_occurrence_id: string
          p_title: string
          p_workspace_id: string
        }
        Returns: {
          child_session_id: string
          created: boolean
          job_id: string
          run_id: string
        }[]
      }
      admit_factory_workflow_next: {
        Args: {
          p_edge_id: string
          p_expected_generation: number
          p_expected_result_id: string
          p_factory_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_source_occurrence_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          target_occurrence_id: string
          transition_id: string
        }[]
      }
      admit_factory_workflow_review_repair: {
        Args: {
          p_expected_generation: number
          p_expected_head_run_id: string
          p_factory_id: string
          p_ownership_token: string
          p_review_id: string
          p_review_receipt_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      admit_factory_workflow_route_decision: {
        Args: {
          p_confidence?: number
          p_destination_id?: string
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_reason: string
          p_root_session_id: string
          p_route_occurrence_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          decision_id: string
          resolution: string
          target_occurrence_id: string
          transition_id: string
        }[]
      }
      admit_next_factory_automation_occurrence: { Args: never; Returns: Json }
      adopt_factory_improvement: {
        Args: {
          p_actor_user_id: string
          p_candidate_digest: string
          p_enabled_sandbox_providers: string[]
          p_expected_activation_number: number
          p_factory_id: string
          p_head_commit_sha: string
          p_proposal_id: string
          p_proposal_revision_id: string
          p_publication_id: string
          p_required_probes: string[]
          p_review: Json
          p_reviewed_definition_json: string
          p_workspace_id: string
        }
        Returns: Json
      }
      adopt_session_checkpoint_publication: {
        Args: {
          p_claim_id: string
          p_remote_ref?: string
          p_remote_sha?: string
          p_run_id: string
        }
        Returns: boolean
      }
      advance_factory_improvement_publication: {
        Args: {
          p_action: string
          p_actor_user_id: string
          p_claim_id: string
          p_factory_id: string
          p_publication_id: string
          p_values: Json
          p_workspace_id: string
        }
        Returns: Json
      }
      advance_factory_workflow_branch_occurrence: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_occurrence_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      advance_factory_workflow_generation: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          execution_generation: number
          ownership_token: string
        }[]
      }
      answer_session_specification_clarification_once: {
        Args: {
          p_actor_member_id: string
          p_agent_model_name?: string
          p_agent_model_provider?: string
          p_answer_text: string
          p_clarification_id: string
          p_expected_artifact_id: string
          p_expected_artifact_version: number
          p_expected_review_revision: number
          p_factory_id: string
          p_request_id: string
          p_run_type?: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: {
          clarification_id: string
          execution_exhausted: boolean
          feedback_batch_id: string
          job_id: string
          replayed: boolean
          run_id: string
        }[]
      }
      append_agent_run_event: {
        Args: {
          p_attempt_count: number
          p_causation_sequence?: number
          p_job_id: string
          p_kind: string
          p_payload: Json
          p_run_id: string
          p_sequence: number
          p_truncated: boolean
        }
        Returns: boolean
      }
      append_session_conversation_message_once: {
        Args: {
          p_actor_member_id: string
          p_body_md: string
          p_external_actor_id?: string
          p_external_message_id?: string
          p_factory_id: string
          p_request_id: string
          p_session_id: string
          p_source_id?: string
          p_workspace_id: string
        }
        Returns: {
          replayed: boolean
          sequence: number
        }[]
      }
      apply_github_pull_request_event: {
        Args: {
          source_head_repository_matches?: boolean
          source_is_draft: boolean
          source_pull_request_number: number
          source_pull_request_state: string
          source_pull_request_url: string
          source_updated_at: string
          target_branch_name: string
          target_repository_id: string
          target_workspace_id: string
        }
        Returns: boolean
      }
      apply_linear_session_transition: {
        Args: {
          p_agent_model_name?: string
          p_agent_model_provider?: string
          p_expected_routing_updated_at: string
          p_expected_session_updated_at: string
          p_linear_issue_id: string
          p_run_type?: string
          p_session_id: string
          p_source_issue_updated_at: string
          p_source_span_id: string
          p_source_started_at: string
          p_source_state_id: string
          p_status_name: string
          p_workspace_id: string
        }
        Returns: {
          job_id: string
          job_ids: string[]
          outcome: string
          run_id: string
          run_ids: string[]
        }[]
      }
      apply_terminal_linear_session_transition: {
        Args: {
          p_agent_model_name?: string
          p_agent_model_provider?: string
          p_expected_routing_updated_at: string
          p_expected_session_updated_at: string
          p_observation: Json
          p_run_type?: string
          p_status_name: string
          p_workspace_id: string
        }
        Returns: {
          job_id: string
          job_ids: string[]
          outcome: string
          run_id: string
          run_ids: string[]
        }[]
      }
      approve_factory_deployment_source: {
        Args: {
          p_actor_user_id: string
          p_environment: string
          p_execution_grant_id: string
          p_execution_grant_version: number
          p_factory_id: string
          p_provider: string
          p_provider_project_id: string
          p_provider_time_authoritative: boolean
          p_workspace_id: string
        }
        Returns: Json
      }
      approve_factory_execution_grant: {
        Args: {
          p_actor_user_id: string
          p_budget_payer_member_id: string
          p_command_scopes?: Database["public"]["Enums"]["factory_command_scope"][]
          p_execution_policy_revision_id: string
          p_expected_version: number
          p_expires_at: string
          p_factory_id: string
          p_github_repository_id: string
          p_grant_id?: string
          p_read_context_repository_ids: string[]
          p_service_principal_id: string
          p_tool_ids: string[]
          p_workspace_id: string
        }
        Returns: {
          approved_at: string
          approved_by_member_id: string
          budget_payer_member_id: string
          command_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          execution_policy_revision_id: string
          expires_at: string
          factory_id: string
          github_repository_id: string
          id: string
          read_context_repository_ids: string[]
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          service_principal_id: string
          tool_ids: string[]
          version: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_execution_grants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_session_stage: {
        Args: {
          approver_member_id: string
          expected_artifact_id: string
          expected_stage_id: string
          expected_version: number
          expected_workspace_id: string
          p_agent_model_name: string
          p_agent_model_provider: string
          p_expected_review_revision?: number
          p_run_type?: string
          target_session_id: string
        }
        Returns: {
          archived_at: string
          current_artifact_version: number
          current_stage_id: string
          current_stage_slug: string
          id: string
          job_created: boolean
          job_id: string
          linear_issue_url: string
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          pipeline_id: string
          rejection_count: number
          run_id: string
          workspace_id: string
        }[]
      }
      archive_factory: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_reason?: string
          p_workspace_id: string
        }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          archived_reason: string | null
          created_at: string
          id: string
          is_default: boolean
          name: string
          slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factories"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      archive_factory_automation: {
        Args: {
          p_actor_user_id: string
          p_automation_id: string
          p_expected_publication: Json
          p_expected_revision_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      archive_session_job_attempts: {
        Args: {
          p_completed?: boolean
          p_reason: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: {
          job_ids: string[]
          run_ids: string[]
        }[]
      }
      arm_factory_benchmark_live_sandbox_binding: {
        Args: {
          p_attempt_count: number
          p_expires_at: string
          p_job_id: string
          p_nonce_sha256: string
          p_run_id: string
          p_trial_id: string
        }
        Returns: boolean
      }
      arm_session_pr_creation: {
        Args: { p_claim_id: string; p_epoch_id: string; p_operation_id: string }
        Returns: boolean
      }
      assert_factory_benchmark_replay_access: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_task_revision_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      assert_session_checkpoint_cleanup_claim: {
        Args: { p_claim_id: string; p_run_id: string }
        Returns: boolean
      }
      assert_session_checkpoint_publication_claim: {
        Args: { p_claim_id: string; p_run_id: string }
        Returns: boolean
      }
      assert_session_pr_sync_claim: {
        Args: { p_claim_id: string; p_operation_id: string }
        Returns: boolean
      }
      assert_session_source_delivery_claim: {
        Args: { p_claim_id: string; p_run_id: string }
        Returns: boolean
      }
      authorize_factory_oauth_access_token: {
        Args: {
          p_access_token_digest: string
          p_access_token_id: string
          p_factory_id: string
          p_scope: Database["public"]["Enums"]["factory_command_scope"]
          p_workspace_id: string
        }
        Returns: {
          execution_grant_id: string
          execution_grant_version: number
          factory_id: string
          oauth_grant_id: string
          service_principal_id: string
          workspace_id: string
        }[]
      }
      authorize_session_browser_screenshot: {
        Args: {
          p_approval_scope_id: string
          p_attempt_count: number
          p_commit_sha: string
          p_run_id: string
          p_validation_tree_sha: string
        }
        Returns: boolean
      }
      authorize_session_browser_video: {
        Args: {
          p_approval_scope_id: string
          p_attempt_count: number
          p_commit_sha: string
          p_run_id: string
          p_validation_tree_sha: string
        }
        Returns: boolean
      }
      authorize_session_pr_successor: {
        Args: {
          p_actor_user_id: string
          p_expected_epoch_id: string
          p_request_id: string
          p_session_id: string
        }
        Returns: string
      }
      backfill_factory_scorer_samples: {
        Args: {
          p_after_finished_at?: string
          p_after_run_id?: string
          p_before: string
          p_closed_before?: string
          p_factory_id: string
          p_limit?: number
          p_policy_id: string
          p_workspace_id: string
        }
        Returns: {
          candidate_count: number
          closed_before: string
          eligible_count: number
          excluded_count: number
          next_finished_at: string
          next_run_id: string
          sampled_count: number
        }[]
      }
      begin_codex_device_auth_flow: {
        Args: {
          flow_id: string
          target_connection_revision: string
          target_expires_at: string
          target_provider: string
          target_user_id: string
          target_workspace_id: string
        }
        Returns: string
      }
      begin_factory_benchmark_inference_request: {
        Args: {
          p_project_id: string
          p_request_digest: string
          p_signed_sandbox_id: string
          p_team_id: string
        }
        Returns: Json
      }
      begin_factory_diagnosis: {
        Args: {
          p_attempt_id: string
          p_diagnosis_id: string
          p_evidence_digest: string
          p_factory_id: string
          p_lease_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      begin_factory_event_send: {
        Args: {
          p_delivery_id: string
          p_lease_id: string
          p_subscription_revision: number
        }
        Returns: {
          attempt_id: string
          event_id: string
          event_type: Database["public"]["Enums"]["factory_outbound_event_type"]
          outcome: string
          payload: Json
          signing_secret_encrypted: string
        }[]
      }
      begin_factory_event_subscription_verification: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_subscription_id: string
          p_verification_digest: string
          p_workspace_id: string
        }
        Returns: {
          endpoint_url: string
          subscription_revision: number
        }[]
      }
      begin_factory_judge_invocation: {
        Args: {
          p_attempt_id: string
          p_evidence_digest: string
          p_factory_id: string
          p_job_id: string
          p_lease_id: string
          p_profile_revision_id: string
          p_worker_runtime: string
          p_workspace_id: string
        }
        Returns: Json
      }
      begin_factory_oauth_authorization: {
        Args: {
          p_actor_session_id: string
          p_actor_user_id: string
          p_client_id: string
          p_code_challenge: string
          p_redirect_uri: string
          p_requested_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          p_resource?: string
          p_state?: string
        }
        Returns: {
          authorization_id: string
          client_name: string
          expires_at: string
          factories: Json
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          workspace_id: string
          workspace_name: string
        }[]
      }
      begin_factory_workflow_foreman_inference: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_route_occurrence_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      begin_github_pull_request_observation: {
        Args: {
          source_is_draft: boolean
          source_pull_request_number: number
          source_pull_request_state: string
          source_updated_at: string
          target_branch_name: string
          target_repository_id: string
          target_workspace_id: string
        }
        Returns: string
      }
      begin_sandbox_connection_mutation: {
        Args: { target_provider: string; target_workspace_id: string }
        Returns: string
      }
      begin_session_pr_observation: {
        Args: {
          p_branch_name: string
          p_pr_number: number
          p_repository_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      begin_session_pr_sync_observation: {
        Args: {
          p_claim_id: string
          p_operation_id: string
          p_pr_number: number
          p_pr_url: string
        }
        Returns: string
      }
      begin_worker_dispatch: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_workflow_id: string
        }
        Returns: boolean
      }
      begin_workspace_deletion: {
        Args: {
          p_confirmation: string
          p_owner_member_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      begin_workspace_resource_operation: {
        Args: {
          p_connection_revision?: string
          p_kind: string
          p_provider: string
          p_recovery_after: string
          p_resource_id: string
          p_storage_bucket: string
          p_workspace_id: string
        }
        Returns: string
      }
      benchmark_list_factory_context_source_access: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_source_ids: string[]
          p_task_revision_id: string
          p_workspace_id: string
        }
        Returns: {
          source_id: string
          status: string
        }[]
      }
      bind_session_conversation_source_once: {
        Args: {
          p_actor_member_id: string
          p_external_thread_id: string
          p_factory_id: string
          p_label?: string
          p_provider: string
          p_session_id: string
          p_source_namespace: string
          p_source_url?: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          external_thread_id: string
          factory_id: string
          id: string
          label: string | null
          provider: string
          session_id: string
          source_namespace: string
          source_url: string | null
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "session_conversation_sources"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      cancel_factory_benchmark_trial: {
        Args: {
          p_actor_user_id: string
          p_expected_run_id: string
          p_factory_id: string
          p_trial_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      cancel_factory_definition_smoke_test: {
        Args: {
          p_actor_user_id: string
          p_definition_digest: string
          p_test_id: string
          p_workspace_id: string
        }
        Returns: {
          base_activation_number: number
          created_at: string
          created_by: string
          definition_digest: string
          error_text: string | null
          evidence: Json
          factory_id: string
          finished_at: string | null
          id: string
          lease_expires_at: string
          policy_version: number
          sandbox_connection_revision: string | null
          status: string
          target_id: string
          target_kind: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_smoke_tests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_factory_diagnosis: {
        Args: {
          p_actor_user_id: string
          p_diagnosis_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      cancel_factory_evaluation_job: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_job_id: string
          p_workspace_id: string
        }
        Returns: {
          attempt_count: number
          attempt_limit: number
          available_at: string | null
          benchmark_deferral_count: number
          canceled_recorded_xact_id: unknown
          created_at: string
          factory_id: string
          finished_at: string | null
          id: string
          requested_by: string | null
          run_id: string
          sample_receipt_id: string
          scorer_revision_id: string
          session_id: string
          source_attempt_id: string | null
          status: string
          target_commit_sha: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_evaluation_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_session_command_once: {
        Args: {
          actor_member_id: string
          expected_run_id: string
          target_factory_id: string
          target_request_hash: string
          target_request_id: string
          target_session_id: string
          target_workspace_id: string
        }
        Returns: {
          job_ids: string[]
          replayed: boolean
          run_ids: string[]
        }[]
      }
      cancel_session_job_attempts: {
        Args: {
          p_expected_run_id?: string
          p_park_phase_status?: boolean
          p_reason: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: {
          job_ids: string[]
          run_ids: string[]
        }[]
      }
      capture_factory_benchmark_run: {
        Args: {
          p_acceptance_criteria: string
          p_actor_user_id: string
          p_eligibility_reason?: string
          p_expected_revision_id?: string
          p_expected_task_revision_id?: string
          p_factory_id: string
          p_new_suite_name?: string
          p_new_suite_purpose?: string
          p_replay_eligibility: string
          p_source_run_id: string
          p_suite_id: string
          p_task_name: string
          p_workspace_id: string
        }
        Returns: Json
      }
      check_factory_credential_binding: {
        Args: {
          p_agent_model: string
          p_agent_provider: string
          p_binding_id: string
          p_execution_grant_id: string
          p_execution_grant_version: number
          p_factory_agent_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      check_factory_workflow_execution_policy: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_occurrence_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          exhaustion_code: string
          policy_revision_id: string
        }[]
      }
      check_session_agent_credential: {
        Args: {
          p_agent_model: string
          p_agent_provider: string
          p_creator_member_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      claim_expired_session_attachments: {
        Args: { max_count?: number }
        Returns: {
          delete_claimed_at: string
          id: string
          storage_path: string
        }[]
      }
      claim_factory_context_source_sync: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_source_id: string
          p_workspace_id: string
        }
        Returns: {
          file_path: string
          installation_id: number
          lease_id: string
          repository_full_name: string
          repository_id: number
          status: string
        }[]
      }
      claim_factory_diagnosis: { Args: never; Returns: Json }
      claim_factory_evaluation_job: {
        Args: never
        Returns: {
          attempt_id: string
          attempt_number: number
          factory_id: string
          job_id: string
          lease_expires_at: string
          lease_id: string
          run_id: string
          sample_receipt_id: string
          scorer_revision_id: string
          session_id: string
          target_commit_sha: string
          workspace_id: string
        }[]
      }
      claim_factory_event_delivery: {
        Args: never
        Returns: {
          delivery_id: string
          endpoint_url: string
          lease_id: string
          subscription_revision: number
        }[]
      }
      claim_factory_improvement_publication: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_proposal_id: string
          p_proposal_revision_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      claim_factory_judge_job: {
        Args: never
        Returns: {
          attempt_id: string
          attempt_number: number
          factory_id: string
          job_id: string
          lease_expires_at: string
          lease_id: string
          run_id: string
          sample_receipt_id: string
          scorer_revision_id: string
          session_id: string
          target_commit_sha: string
          workspace_id: string
        }[]
      }
      claim_factory_workflow_accepted_triage_route: {
        Args: { p_candidate_token: string }
        Returns: {
          execution_generation: number
          factory_id: string
          node_id: string
          occurrence_id: string
          ownership_token: string
          root_session_id: string
          workflow_digest: string
          workspace_id: string
        }[]
      }
      claim_factory_workflow_authoring_dispatch: {
        Args: { p_lease_id: string }
        Returns: Json
      }
      claim_factory_workflow_exact_review: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_permit: string
          p_review_occurrence_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      claim_factory_workflow_join_conflict_cleanup: {
        Args: { p_operation_id: string; p_path: string; p_workspace_id: string }
        Returns: boolean
      }
      claim_factory_workflow_repository_delivery: {
        Args: {
          p_factory_id: string
          p_generation: number
          p_join_id: string
          p_owner: string
          p_repository_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      claim_factory_workflow_sandbox_stops: {
        Args: { p_limit: number }
        Returns: {
          lease_token: string
          obligation_id: string
          run_id: string
          sandbox_connection_revision: string
          sandbox_id: string
          sandbox_provider: string
          sandbox_vercel_project_id: string
          sandbox_vercel_team_id: string
          workspace_id: string
        }[]
      }
      claim_github_pr_refresh: {
        Args: { p_workspace_id?: string }
        Returns: Json
      }
      claim_next_agent_job:
        | {
            Args: {
              accept_benchmark_trials: boolean
              default_concurrency_limit?: number
            }
            Returns: {
              attempt_count: number
              claimed_worker_runtime: string | null
              created_at: string
              dedupe_key: string | null
              finished_at: string | null
              git_continuity_release_revision: number | null
              id: string
              is_repair: boolean
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
        | {
            Args: {
              accept_benchmark_trials: boolean
              default_concurrency_limit: number
              p_worker_runtime: string
            }
            Returns: {
              attempt_count: number
              claimed_worker_runtime: string | null
              created_at: string
              dedupe_key: string | null
              finished_at: string | null
              git_continuity_release_revision: number | null
              id: string
              is_repair: boolean
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
        | {
            Args: { default_concurrency_limit?: number }
            Returns: {
              attempt_count: number
              claimed_worker_runtime: string | null
              created_at: string
              dedupe_key: string | null
              finished_at: string | null
              git_continuity_release_revision: number | null
              id: string
              is_repair: boolean
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
      claim_next_worker_auth_dispatch: {
        Args: never
        Returns: {
          claim_token: string
          created_at: string
          dispatched_at: string | null
          execution_started_at: string | null
          expires_at: string
          flow_id: string
          workflow_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "worker_auth_dispatches"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_next_worker_dispatch:
        | {
            Args: {
              accept_benchmark_trials: boolean
              p_default_workspace_limit?: number
              p_max_concurrent?: number
              p_timeout_ms?: number
            }
            Returns: {
              attempt_count: number
              created_at: string
              deadline_at: string
              dispatched_at: string | null
              execution_started_at: string | null
              job_id: string
              workflow_id: string
              workspace_id: string
            }[]
            SetofOptions: {
              from: "*"
              to: "worker_dispatches"
              isOneToOne: false
              isSetofReturn: true
            }
          }
        | {
            Args: {
              p_default_workspace_limit?: number
              p_max_concurrent?: number
              p_timeout_ms?: number
            }
            Returns: {
              attempt_count: number
              created_at: string
              deadline_at: string
              dispatched_at: string | null
              execution_started_at: string | null
              job_id: string
              workflow_id: string
              workspace_id: string
            }[]
            SetofOptions: {
              from: "*"
              to: "worker_dispatches"
              isOneToOne: false
              isSetofReturn: true
            }
          }
      claim_run_evidence_purges: {
        Args: { p_limit?: number }
        Returns: {
          asset_id: string
          claim_id: string
          storage_path: string
        }[]
      }
      claim_run_export: {
        Args: never
        Returns: {
          export_id: string
          lease_token: string
          next_ordinal: number
          snapshot_at: string
          status: string
          workspace_id: string
        }[]
      }
      claim_session_checkpoint_cleanup: {
        Args: { p_run_id?: string }
        Returns: string
      }
      claim_session_checkpoint_publication: {
        Args: { p_run_id?: string }
        Returns: string
      }
      claim_session_pr_sync: {
        Args: { p_session_id?: string }
        Returns: string
      }
      claim_session_source_delivery: { Args: never; Returns: string }
      close_factory_benchmark_live_inference: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_run_id: string
          p_trial_id: string
        }
        Returns: Json
      }
      commit_linear_automation_span_page: {
        Args: {
          p_expected_generation: number
          p_observations: Json
          p_session_links: Json
          p_workspace_id?: string
        }
        Returns: {
          after_session_id: string
          generation: number
          occurrence_count: number
        }[]
      }
      commit_run_export_page: {
        Args: {
          p_entries: Json
          p_export_id: string
          p_first_ordinal: number
          p_lease_token: string
          p_page_sha256: string
          p_page_size_bytes: number
        }
        Returns: boolean
      }
      complete_cursor_auth_flow: {
        Args: {
          p_account_email?: string
          p_api_key_expires_at: string
          p_claimed_by: string
          p_completed_at: string
          p_encrypted_api_key: string
          p_flow_id: string
        }
        Returns: boolean
      }
      complete_run_evidence_purges: {
        Args: { p_claim_ids: string[] }
        Returns: number
      }
      complete_run_export: {
        Args: { p_export_id: string; p_lease_token: string }
        Returns: boolean
      }
      complete_session_job_attempt: {
        Args: { p_attempt_count: number; p_job_id: string; p_run_id: string }
        Returns: boolean
      }
      configure_factory_automation_admission: {
        Args: {
          p_actor_user_id: string
          p_automation_id: string
          p_expected_generation: number
          p_factory_id: string
          p_max_concurrent_sessions: number
          p_paused: boolean
          p_workspace_id: string
        }
        Returns: Json
      }
      configure_factory_benchmark_inference_connection: {
        Args: {
          p_actor_user_id: string
          p_encrypted_api_key: string
          p_factory_id: string
          p_profile: Json
          p_workspace_id: string
        }
        Returns: Json
      }
      configure_factory_benchmark_live_schedule: {
        Args: {
          p_actor_user_id: string
          p_budget_limit_usd: number
          p_evaluation_reserve_usd: number
          p_execution_reserve_usd: number
          p_experiment_id: string
          p_factory_concurrency_limit: number
          p_factory_id: string
          p_inference_connection_revision: string
          p_max_admitted_trials: number
          p_workspace_id: string
        }
        Returns: Json
      }
      configure_factory_benchmark_schedule: {
        Args: {
          p_actor_user_id: string
          p_budget_limit_usd: number
          p_evaluation_reserve_usd: number
          p_execution_reserve_usd: number
          p_experiment_id: string
          p_factory_concurrency_limit: number
          p_factory_id: string
          p_max_admitted_trials: number
          p_runner_revision: string
          p_sandbox_connection_revision: string
          p_task_fixtures: Json
          p_workspace_id: string
        }
        Returns: Json
      }
      configure_factory_command_quotas: {
        Args: {
          p_actor_user_id: string
          p_lease_seconds?: number
          p_principal_concurrency_limit: number
          p_principal_rate_limit: number
          p_window_seconds?: number
          p_workspace_concurrency_limit: number
          p_workspace_id: string
          p_workspace_rate_limit: number
        }
        Returns: undefined
      }
      configure_factory_evaluation_lane: {
        Args: {
          p_actor_user_id: string
          p_expected_revision: number
          p_max_concurrent: number
          p_paused: boolean
          p_workspace_id: string
        }
        Returns: {
          max_concurrent: number
          paused: boolean
          revision: number
          updated_at: string | null
          updated_by: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_evaluation_lanes"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      configure_factory_judge_profile: {
        Args: {
          p_actor_user_id: string
          p_allow_images: boolean
          p_allow_video: boolean
          p_encrypted_api_key?: string
          p_expected_revision: number
          p_model_id: string
          p_provider_route: string
          p_workspace_id: string
        }
        Returns: {
          allow_images: boolean
          allow_video: boolean
          approved_by_member_id: string
          created_at: string
          enabled: boolean
          id: string
          model_id: string
          provider: string
          provider_route: string
          revision: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_judge_profile_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      configure_factory_scorer_pause: {
        Args: {
          p_actor_user_id: string
          p_expected_revision: number
          p_factory_id: string
          p_paused: boolean
          p_scorer_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      configure_factory_workflow_triage: {
        Args: {
          p_actor_user_id: string
          p_definition_revision_id: string
          p_expected_version: number
          p_factory_id: string
          p_graph_revision_id: string
          p_stage_id: string
          p_workflow_digest: string
          p_workspace_id: string
        }
        Returns: {
          configuration_version: number
          created: boolean
        }[]
      }
      confirm_factory_event_subscription: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_subscription_id: string
          p_verification_digest: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      consume_factory_benchmark_live_sandbox_binding: {
        Args: {
          p_nonce_sha256: string
          p_project_id: string
          p_signed_sandbox_id: string
          p_team_id: string
        }
        Returns: boolean
      }
      control_factory_benchmark_schedule: {
        Args: {
          p_action: string
          p_actor_user_id: string
          p_experiment_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      control_factory_flow_projection: {
        Args: { p_action: string; p_factory_id: string; p_workspace_id: string }
        Returns: Json
      }
      control_factory_workflow_lifecycle: {
        Args: {
          p_action: string
          p_expected_generation: number
          p_factory_id: string
          p_request_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      control_factory_workflow_lifecycle_for_user: {
        Args: {
          p_action: string
          p_actor_user_id: string
          p_expected_generation: number
          p_factory_id: string
          p_request_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      correct_factory_memory: {
        Args: {
          p_body_md: string
          p_expected_current_revision_id?: string
          p_expected_pending_revision_id?: string
          p_expires_at?: string
          p_factory_id: string
          p_memory_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          current_approval_id: string | null
          current_revision_id: string | null
          factory_id: string
          forgotten_at: string | null
          id: string
          pending_revision_id: string | null
          source_artifact_id: string
          source_artifact_version: number
          source_attempt_count: number
          source_commit_sha: string
          source_content_sha256: string
          source_run_id: string
          source_session_id: string
          title: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_memories"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_artifact_review_thread: {
        Args: {
          p_anchor: Json
          p_artifact_id: string
          p_artifact_version: number
          p_body: string
          p_kind: string
          p_session_id: string
          p_stage_id: string
          p_workspace_id: string
        }
        Returns: {
          anchor: Json
          artifact_id: string
          artifact_version: number
          author_label: string
          author_member_id: string
          created_at: string
          id: string
          kind: string
          revision: number
          session_id: string
          stage_id: string
          stage_slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "artifact_review_threads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_artifact_review_thread_once: {
        Args: {
          p_anchor: Json
          p_artifact_id: string
          p_artifact_version: number
          p_body: string
          p_kind: string
          p_request_id: string
          p_session_id: string
          p_stage_id: string
          p_workspace_id: string
        }
        Returns: {
          anchor: Json
          artifact_id: string
          artifact_version: number
          author_label: string
          author_member_id: string
          created_at: string
          id: string
          kind: string
          revision: number
          session_id: string
          stage_id: string
          stage_slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "artifact_review_threads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_confirmed_factory_session_once_with_first_job: {
        Args: {
          agent_model_name: string
          agent_model_provider: string
          creator_member_id: string
          expected_factory_definition_digest: string
          selected_pipeline_id?: string
          selected_stage_ids?: string[]
          session_attachment_ids: string[]
          session_github_repository_id?: string
          session_linear_issue_id?: string
          session_linear_issue_url?: string
          session_prompt_md: string
          session_title: string
          source_session_id?: string
          target_request_hash: string
          target_request_id: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
      }
      create_factory: {
        Args: {
          p_actor_user_id: string
          p_name: string
          p_slug: string
          p_workspace_id: string
        }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          archived_reason: string | null
          created_at: string
          id: string
          is_default: boolean
          name: string
          slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factories"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_factory_agent: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_name: string
          p_prompt_md?: string
          p_slug: string
          p_workspace_id: string
        }
        Returns: {
          agent_id: string
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          prompt_md: string
          prompt_sha256: string
          revision_number: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_agent_prompt_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_factory_analytics_export: {
        Args: {
          p_compare_previous?: boolean
          p_dimension?: string
          p_environment?: string
          p_factory_id: string
          p_from: string
          p_request_id: string
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      create_factory_automation: {
        Args: {
          p_actor_user_id: string
          p_automation_id: string
          p_definition: Json
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      create_factory_benchmark_comparison_export: {
        Args: {
          p_actor_user_id: string
          p_experiment_id: string
          p_factory_id: string
          p_request_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      create_factory_benchmark_task: {
        Args: {
          p_acceptance_criteria: string
          p_actor_user_id: string
          p_eligibility_reason?: string
          p_factory_id: string
          p_name: string
          p_replay_eligibility?: string
          p_source_run_id: string
          p_tags: string[]
          p_workspace_id: string
        }
        Returns: {
          acceptance_criteria: string
          created_at: string
          created_by: string
          eligibility_reason: string | null
          factory_id: string
          id: string
          name: string
          replay_eligibility: string
          revision_number: number
          tags: string[]
          task_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_benchmark_task_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_factory_event_subscription: {
        Args: {
          p_actor_user_id: string
          p_credential_id: string
          p_credential_kind: Database["public"]["Enums"]["factory_event_subscription_credential_kind"]
          p_endpoint_url: string
          p_event_types: Database["public"]["Enums"]["factory_outbound_event_type"][]
          p_factory_id: string
          p_name: string
          p_signing_secret_encrypted: string
          p_workspace_id: string
        }
        Returns: string
      }
      create_factory_mcp_secret_binding: {
        Args: {
          p_actor_user_id: string
          p_execution_grant_id: string
          p_execution_grant_version: number
          p_factory_agent_id: string
          p_factory_id: string
          p_tool_revision_id: string
          p_workspace_id: string
          p_workspace_secret_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id: string
          revoked_at: string | null
          revoked_by: string | null
          service_principal_id: string
          tool_revision_id: string
          workspace_id: string
          workspace_secret_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_mcp_secret_bindings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_factory_mcp_server: {
        Args: {
          p_actor_user_id: string
          p_auth_kind: string
          p_endpoint: string
          p_factory_id: string
          p_name: string
          p_operation_names: string[]
          p_slug: string
          p_workspace_id: string
        }
        Returns: {
          auth_kind: string
          created_at: string
          created_by: string
          endpoint: string
          factory_id: string
          id: string
          operation_names: string[]
          revision_number: number
          revoked_at: string | null
          revoked_by: string | null
          server_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_mcp_server_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_factory_scorer: {
        Args: {
          p_actor_user_id: string
          p_definition: Json
          p_factory_id: string
          p_name: string
          p_slug: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          definition: Json
          factory_id: string
          id: string
          revision_number: number
          scorer_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_scorer_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_factory_secret_binding: {
        Args: {
          p_actor_user_id: string
          p_agent_provider: string
          p_execution_grant_id: string
          p_execution_grant_version: number
          p_factory_agent_id: string
          p_factory_id: string
          p_open_code_provider_id?: string
          p_workspace_id: string
          p_workspace_secret_id: string
        }
        Returns: {
          agent_provider: string
          created_at: string
          created_by_member_id: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id: string
          open_code_provider_id: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          service_principal_id: string
          version: number
          workspace_id: string
          workspace_secret_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_secret_bindings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_factory_skill: {
        Args: {
          p_actor_user_id: string
          p_content_md: string
          p_factory_id: string
          p_name: string
          p_slug: string
          p_source_kind?: string
          p_source_ref?: string
          p_workspace_id: string
        }
        Returns: {
          content_md: string
          content_sha256: string
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          revision_number: number
          revoked_at: string | null
          revoked_by: string | null
          skill_id: string
          source_kind: string
          source_ref: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_skill_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_factory_workflow_authoring: {
        Args: {
          p_actor_user_id: string
          p_display_name: string
          p_factory_id: string
          p_template_id?: string
          p_template_version?: number
          p_workflow_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      create_service_principal: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_name: string
          p_slug: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by_member_id: string
          factory_id: string
          id: string
          name: string
          slug: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "service_principals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_session_command_once: {
        Args: {
          agent_model_name: string
          agent_model_provider: string
          creator_member_id: string
          draft_specification?: boolean
          expected_factory_definition_digest: string
          p_workflow_selection?: Json
          selected_pipeline_id?: string
          selected_stage_ids?: string[]
          session_attachment_ids: string[]
          session_github_repository_id?: string
          session_linear_issue_id?: string
          session_linear_issue_url?: string
          session_prompt_md: string
          session_title: string
          source_session_id?: string
          target_factory_id?: string
          target_request_hash: string
          target_request_id: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
      }
      create_session_command_with_routing_override: {
        Args: {
          agent_model_name: string
          agent_model_provider: string
          creator_member_id: string
          draft_specification?: boolean
          expected_factory_definition_digest: string
          p_routing_override: Json
          selected_pipeline_id?: string
          selected_stage_ids?: string[]
          session_attachment_ids: string[]
          session_github_repository_id?: string
          session_linear_issue_id?: string
          session_linear_issue_url?: string
          session_prompt_md: string
          session_title: string
          source_session_id?: string
          target_factory_id?: string
          target_request_hash: string
          target_request_id: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
      }
      create_session_once_with_first_job: {
        Args: {
          agent_model_name: string
          agent_model_provider: string
          creator_member_id: string
          selected_pipeline_id?: string
          selected_stage_ids?: string[]
          session_attachment_ids: string[]
          session_github_repository_id?: string
          session_linear_issue_id?: string
          session_linear_issue_url?: string
          session_prompt_md: string
          session_title: string
          target_request_hash: string
          target_request_id: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
      }
      create_session_with_first_job: {
        Args: {
          agent_model_name: string
          agent_model_provider: string
          creator_member_id: string
          selected_pipeline_id?: string
          selected_stage_ids?: string[]
          session_github_repository_id?: string
          session_linear_issue_id?: string
          session_linear_issue_url?: string
          session_prompt_md: string
          session_title: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
      }
      create_session_with_first_job_and_attachments: {
        Args: {
          agent_model_name: string
          agent_model_provider: string
          creator_member_id: string
          selected_pipeline_id?: string
          selected_stage_ids?: string[]
          session_attachment_ids: string[]
          session_github_repository_id?: string
          session_linear_issue_id?: string
          session_linear_issue_url?: string
          session_prompt_md: string
          session_title: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
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
          deletion_requested_at: string | null
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
      decide_factory_oauth_authorization: {
        Args: {
          p_actor_session_id: string
          p_actor_user_id: string
          p_allow: boolean
          p_authorization_id: string
          p_code_digest?: string
          p_code_id?: string
          p_factory_ids?: string[]
        }
        Returns: {
          approved: boolean
          redirect_uri: string
          state: string
        }[]
      }
      defer_session_job_for_continuity_release: {
        Args: { p_attempt_count: number; p_job_id: string }
        Returns: boolean
      }
      delete_factory_context_source: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_source_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          current_revision_id: string | null
          deleted_at: string | null
          factory_id: string
          file_path: string
          github_installation_id: string
          grant_id: string
          grant_version: number
          id: string
          last_successful_sync_at: string | null
          last_sync_attempt_at: string | null
          repository_id: string
          status: string
          sync_lease_expires_at: string | null
          sync_lease_id: string | null
          upstream_repository_id: number
          upstream_revision: string | null
          upstream_updated_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_context_sources"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      dispatch_factory_workflow_foreman_command: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_foreman_run_id: string
          p_ordinal: number
          p_ownership_token: string
          p_root_session_id: string
          p_route_occurrence_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      dispatch_next_factory_workflow_branch: { Args: never; Returns: boolean }
      dispatch_next_factory_workflow_exact_review: {
        Args: { p_permit: string }
        Returns: Json
      }
      dispatch_next_factory_workflow_repository_validation: {
        Args: never
        Returns: boolean
      }
      dispatch_next_factory_workflow_review_repair: {
        Args: never
        Returns: boolean
      }
      dry_run_factory_automation: {
        Args: {
          p_automation_id: string
          p_event: Json
          p_factory_id: string
          p_revision_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      enable_factory_benchmark_live_inference: {
        Args: {
          p_attempt_count: number
          p_input_bundle_sha256: string
          p_job_id: string
          p_replay_prompt_sha256: string
          p_restoration_receipt_sha256: string
          p_run_id: string
          p_signed_sandbox_id: string
          p_trial_id: string
        }
        Returns: boolean
      }
      enqueue_due_github_pr_refreshes: {
        Args: { p_limit?: number; p_workspace_id?: string }
        Returns: number
      }
      enqueue_factory_flow_rebuild: {
        Args: {
          p_after_session_id?: string
          p_factory_id: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: Json
      }
      enqueue_factory_workflow_join_for_user: {
        Args: {
          p_actor_user_id: string
          p_branch_group_id: string
          p_expected_generation: number
          p_expected_head_run_id: string
          p_factory_id: string
          p_request_id: string
          p_root_session_id: string
          p_selected_outcome_ids: string[]
          p_workspace_id: string
        }
        Returns: Json
      }
      enqueue_github_pr_refresh_event: {
        Args: {
          p_base_branch?: string
          p_delivery_id: string
          p_github_repository_id: number
          p_head_sha?: string
          p_installation_id: number
          p_pr_numbers?: number[]
        }
        Returns: number
      }
      enqueue_session_job_with_run: {
        Args: {
          p_agent_model_name?: string
          p_agent_model_provider?: string
          p_expected_stage_id: string
          p_requested_by_member_id?: string
          p_run_type?: string
          p_session_id: string
          p_trigger_type?: Database["public"]["Enums"]["agent_trigger_type"]
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          job_id: string
          run_id: string
        }[]
      }
      enqueue_session_pr_refresh: {
        Args: { p_session_id: string; p_workspace_id: string }
        Returns: boolean
      }
      enqueue_session_retry_with_checkpoint: {
        Args: {
          p_agent_model_name: string
          p_agent_model_provider: string
          p_expected_stage_id: string
          p_requested_by_member_id: string
          p_retry_run_id: string
          p_run_type: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          job_id: string
          run_id: string
        }[]
      }
      ensure_own_profile: {
        Args: {
          actor_avatar_url?: string
          actor_email?: string
          actor_full_name?: string
        }
        Returns: {
          avatar_overridden: boolean
          avatar_path: string | null
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          primary_email: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      erase_session_retained_content: {
        Args: {
          expected_archived_at: string
          target_factory_id: string
          target_session_id: string
          target_workspace_id: string
        }
        Returns: {
          actor_member_id: string
          archived_at: string
          erased_at: string
          factory_id: string
          session_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_retained_content_erasures"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      exchange_factory_oauth_code: {
        Args: {
          p_access_token_digest: string
          p_access_token_id: string
          p_client_id: string
          p_code_digest: string
          p_code_id: string
          p_pkce_challenge: string
          p_redirect_uri: string
          p_refresh_token_digest: string
          p_refresh_token_id: string
          p_resource?: string
        }
        Returns: {
          expires_in: number
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          status: string
        }[]
      }
      execute_factory_deployment_observation: {
        Args: {
          p_admission_id: string
          p_credential_digest: string
          p_credential_id: string
          p_credential_kind: Database["public"]["Enums"]["factory_command_credential_kind"]
          p_environment: string
          p_external_deployment_id: string
          p_factory_id: string
          p_lease_id: string
          p_outcome: string
          p_provider_occurred_at?: string
          p_request_hash: string
          p_request_id: string
          p_revision: number
          p_source_id: string
          p_source_sha?: string
          p_surface: Database["public"]["Enums"]["factory_command_surface"]
          p_workspace_id: string
        }
        Returns: Json
      }
      execute_factory_session_mutation: {
        Args: {
          p_admission_id: string
          p_credential_digest: string
          p_credential_id: string
          p_credential_kind: Database["public"]["Enums"]["factory_command_credential_kind"]
          p_factory_id: string
          p_lease_id: string
          p_operation: Database["public"]["Enums"]["factory_session_mutation_operation"]
          p_payload: Json
          p_request_hash: string
          p_request_id: string
          p_request_key: string
          p_surface: Database["public"]["Enums"]["factory_command_surface"]
          p_workspace_id: string
        }
        Returns: Json
      }
      expire_next_factory_workflow_exact_review: {
        Args: never
        Returns: boolean
      }
      fail_deadline_session_job_attempt: {
        Args: {
          p_attempt_count: number
          p_error: string
          p_job_id: string
          p_run_id?: string
        }
        Returns: string
      }
      fail_factory_benchmark_trial: {
        Args: {
          p_attempt_count: number
          p_failure_code: string
          p_job_id: string
          p_run_id: string
          p_trial_id: string
        }
        Returns: boolean
      }
      fail_factory_workflow_exact_review: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_permit: string
          p_reason: string
          p_review_id: string
          p_review_run_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      fail_session_checkpoint_cleanup: {
        Args: { p_claim_id: string; p_error_code: string; p_run_id: string }
        Returns: boolean
      }
      fail_session_job_attempt: {
        Args: {
          p_attempt_count: number
          p_error: string
          p_job_id: string
          p_max_retries: number
          p_retry: boolean
          p_run_id?: string
        }
        Returns: string
      }
      fail_session_pr_sync: {
        Args: {
          p_claim_id: string
          p_error_code: string
          p_is_conflict?: boolean
          p_operation_id: string
          p_retry_creation_safe?: boolean
        }
        Returns: boolean
      }
      fail_stalled_session_job_attempt: {
        Args: {
          p_attempt_count: number
          p_error: string
          p_job_id: string
          p_max_retries: number
          p_retry: boolean
          p_run_id?: string
        }
        Returns: string
      }
      find_factory_benchmark_experiment_retry: {
        Args: {
          p_actor_user_id: string
          p_definition_revision_ids: string[]
          p_experiment_id: string
          p_factory_id: string
          p_policy_revision_id: string
          p_repetitions: number
          p_seed: number
          p_suite_revision_id: string
          p_timeout_ms: number
          p_worker_runtime?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      find_factory_benchmark_experiment_retry_with_evaluation: {
        Args: {
          p_actor_user_id: string
          p_definition_revision_ids: string[]
          p_evaluation_plan: Json
          p_experiment_id: string
          p_factory_id: string
          p_policy_revision_id: string
          p_repetitions: number
          p_seed: number
          p_suite_revision_id: string
          p_timeout_ms: number
          p_worker_runtime: string
          p_workspace_id: string
        }
        Returns: Json
      }
      find_factory_workflow_authoring_receipt: {
        Args: {
          p_action: string
          p_actor_user_id: string
          p_factory_id: string
          p_request_fingerprint: string
          p_request_id: string
          p_workflow_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      find_session_creation_command: {
        Args: {
          creator_member_id: string
          draft_specification?: boolean
          p_workflow_selection?: Json
          source_session_id?: string
          target_factory_id?: string
          target_request_hash: string
          target_request_id: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
      }
      find_session_creation_request: {
        Args: {
          creator_member_id: string
          target_request_hash: string
          target_request_id: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
      }
      finish_factory_benchmark_inference_request: {
        Args: {
          p_input_tokens?: number
          p_observed_model?: string
          p_output_tokens?: number
          p_request_id: string
          p_status: string
        }
        Returns: boolean
      }
      finish_factory_benchmark_live_trial: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_result: Json
          p_run_id: string
          p_trial_id: string
        }
        Returns: boolean
      }
      finish_factory_benchmark_trial: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_result: Json
          p_run_id: string
          p_trial_id: string
        }
        Returns: boolean
      }
      finish_factory_definition_smoke_test: {
        Args: {
          p_error_text?: string
          p_evidence: Json
          p_status: string
          p_test_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      finish_factory_diagnosis: {
        Args: {
          p_attempt_id: string
          p_diagnosis_id: string
          p_factory_id: string
          p_lease_id: string
          p_result?: Json
          p_status: string
          p_trace?: Json
          p_usage?: Json
          p_workspace_id: string
        }
        Returns: boolean
      }
      finish_factory_judge_invocation: {
        Args: {
          p_attempt_id: string
          p_candidate_result?: Json
          p_cost_provenance?: string
          p_cost_usd?: number
          p_estimation_revision?: string
          p_evidence_locations?: Json
          p_explanation?: string
          p_factory_id: string
          p_input_tokens?: number
          p_job_id: string
          p_lease_id: string
          p_output_tokens?: number
          p_provider_model?: string
          p_provider_name?: string
          p_provider_request_id?: string
          p_status: string
          p_token_provenance?: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      finish_factory_workflow_accepted_triage_route: {
        Args: {
          p_completed: boolean
          p_expected_generation: number
          p_factory_id: string
          p_occurrence_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      finish_factory_workflow_authoring_dispatch: {
        Args: {
          p_expected_generation: number
          p_input_run_id: string
          p_lease_id: string
          p_session_id: string
        }
        Returns: string
      }
      finish_factory_workflow_repository_validation: {
        Args: {
          p_attempt_count: number
          p_bundle_base64?: string
          p_bundle_sha256?: string
          p_candidate_sha?: string
          p_factory_id: string
          p_generation: number
          p_job_id: string
          p_join_id: string
          p_owner: string
          p_repository_id: string
          p_result: string
          p_root_session_id: string
          p_run_id: string
          p_tree_sha?: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      finish_github_pr_refresh: {
        Args: {
          p_base_sha?: string
          p_claim_token: string
          p_error_code?: string
          p_head_sha?: string
          p_payload?: Json
          p_session_id: string
        }
        Returns: boolean
      }
      finish_github_pull_request_observation: {
        Args: {
          observation_token: string
          source_is_draft: boolean
          source_pull_request_number: number
          source_pull_request_state: string
          source_pull_request_url: string
          source_updated_at: string
          target_branch_name: string
          target_repository_id: string
          target_workspace_id: string
        }
        Returns: boolean
      }
      finish_run_export_cleanup: {
        Args: { p_export_id: string; p_workspace_id: string }
        Returns: boolean
      }
      finish_session_checkpoint_cleanup: {
        Args: { p_claim_id: string; p_remote_absent: boolean; p_run_id: string }
        Returns: boolean
      }
      finish_session_pr_observation: {
        Args: {
          p_is_draft: boolean
          p_observation_id: string
          p_pr_head_sha: string
          p_pr_state: string
          p_pr_updated_at: string
          p_pr_url: string
        }
        Returns: boolean
      }
      finish_session_pr_observation_with_merge: {
        Args: {
          p_is_draft: boolean
          p_merge_commit_sha: string
          p_merge_source_head_sha: string
          p_merged_at: string
          p_observation_id: string
          p_pr_head_sha: string
          p_pr_state: string
          p_pr_updated_at: string
          p_pr_url: string
        }
        Returns: boolean
      }
      finish_session_pr_sync: {
        Args: {
          p_claim_id: string
          p_is_draft: boolean
          p_observation_id?: string
          p_observed_fence_sha: string
          p_observed_head_sha: string
          p_operation_id: string
          p_pr_head_sha: string
          p_pr_number: number
          p_pr_state: string
          p_pr_updated_at: string
          p_pr_url: string
        }
        Returns: boolean
      }
      finish_session_pr_sync_with_merge: {
        Args: {
          p_claim_id: string
          p_is_draft: boolean
          p_merge_commit_sha: string
          p_merge_source_head_sha: string
          p_merged_at: string
          p_observation_id: string
          p_observed_fence_sha: string
          p_observed_head_sha: string
          p_operation_id: string
          p_pr_head_sha: string
          p_pr_number: number
          p_pr_state: string
          p_pr_updated_at: string
          p_pr_url: string
        }
        Returns: boolean
      }
      finish_session_source_delivery: {
        Args: { p_claim_id: string; p_delivered: boolean; p_run_id: string }
        Returns: boolean
      }
      finish_session_source_delivery_with_ref: {
        Args: { p_claim_id: string; p_delivered_ref?: string; p_run_id: string }
        Returns: boolean
      }
      finish_workspace_deletion: {
        Args: { p_workspace_id: string }
        Returns: boolean
      }
      forget_factory_memory: {
        Args: {
          p_expected_current_revision_id?: string
          p_expected_pending_revision_id?: string
          p_factory_id: string
          p_memory_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          current_approval_id: string | null
          current_revision_id: string | null
          factory_id: string
          forgotten_at: string | null
          id: string
          pending_revision_id: string | null
          source_artifact_id: string
          source_artifact_version: number
          source_attempt_count: number
          source_commit_sha: string
          source_content_sha256: string
          source_run_id: string
          source_session_id: string
          title: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_memories"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      freeze_factory_benchmark_experiment: {
        Args: {
          p_actor_user_id: string
          p_candidates: Json
          p_experiment_id: string
          p_factory_id: string
          p_policy_revision_id: string
          p_repetitions: number
          p_seed: number
          p_suite_revision_id: string
          p_timeout_ms: number
          p_workspace_id: string
        }
        Returns: Json
      }
      freeze_factory_benchmark_experiment_axes: {
        Args: {
          p_actor_user_id: string
          p_candidates: Json
          p_experiment_id: string
          p_factory_id: string
          p_policy_revision_id: string
          p_repetitions: number
          p_seed: number
          p_suite_revision_id: string
          p_timeout_ms: number
          p_workspace_id: string
        }
        Returns: Json
      }
      freeze_factory_benchmark_experiment_axes_with_evaluation: {
        Args: {
          p_actor_user_id: string
          p_candidates: Json
          p_evaluation_plan: Json
          p_experiment_id: string
          p_factory_id: string
          p_policy_revision_id: string
          p_repetitions: number
          p_seed: number
          p_suite_revision_id: string
          p_timeout_ms: number
          p_workspace_id: string
        }
        Returns: Json
      }
      freeze_factory_benchmark_experiment_with_evaluation: {
        Args: {
          p_actor_user_id: string
          p_candidates: Json
          p_evaluation_plan: Json
          p_experiment_id: string
          p_factory_id: string
          p_policy_revision_id: string
          p_repetitions: number
          p_seed: number
          p_suite_revision_id: string
          p_timeout_ms: number
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_cost_summary: {
        Args: {
          p_factory_id: string
          p_from: string
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_diagnosis: {
        Args: {
          p_diagnosis_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_evaluation_lane: {
        Args: { p_actor_user_id: string; p_workspace_id: string }
        Returns: {
          max_concurrent: number
          paused: boolean
          revision: number
          updated_at: string | null
          updated_by: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_evaluation_lanes"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_factory_failure_cohort: {
        Args: {
          p_after_member_id?: string
          p_cohort_id: string
          p_definition_revision_id?: string
          p_factory_id: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_flow_projection_health: {
        Args: { p_factory_id: string; p_workspace_id: string }
        Returns: Json
      }
      get_factory_flow_summary: {
        Args: {
          p_environment?: string
          p_factory_id: string
          p_from: string
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_improvement_adoption: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_proposal_id: string
          p_proposal_revision_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_improvement_outcomes: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_proposal_id: string
          p_proposal_revision_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_improvement_proposal_revision: {
        Args: {
          p_factory_id: string
          p_proposal_id: string
          p_revision_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_improvement_publication: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_proposal_id: string
          p_proposal_revision_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_improvement_validation: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_proposal_id: string
          p_proposal_revision_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_inbox: {
        Args: {
          p_before_artifact_id?: string
          p_before_at?: string
          p_factory_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_judge_profile: {
        Args: { p_actor_user_id: string; p_workspace_id: string }
        Returns: {
          allow_images: boolean
          allow_video: boolean
          approved_by_member_id: string
          created_at: string
          enabled: boolean
          id: string
          model_id: string
          provider: string
          provider_route: string
          revision: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_judge_profile_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_factory_revert_summary: {
        Args: {
          p_factory_id: string
          p_from: string
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_revert_target: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_original_merge_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_routing_canary_alert: {
        Args: {
          p_alert_id?: string
          p_canary_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_routing_canary_report: {
        Args: {
          p_canary_id?: string
          p_factory_id: string
          p_from?: string
          p_to?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_routing_qualification_status: {
        Args: {
          p_activation_number?: number
          p_draft_id?: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_scorer_pause: {
        Args: {
          p_before_pause_revision?: number
          p_factory_id: string
          p_scorer_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_factory_throughput_breakdown: {
        Args: {
          p_dimension?: string
          p_factory_id: string
          p_from: string
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_git_continuity_release_state: {
        Args: never
        Returns: {
          enabled: boolean
          reason: string
          revision: number
          updated_at: string
        }[]
      }
      get_pipeline_dashboard_page: {
        Args: {
          cursor_seen_ids?: string[]
          page_limit?: number
          target_factory_id?: string
          target_pipeline_id?: string
          target_stage_id?: string
          target_workspace_id: string
        }
        Returns: Json
      }
      get_run_context_inputs: {
        Args: {
          target_attempt_count: number
          target_run_id: string
          target_workspace_id: string
        }
        Returns: Json
      }
      get_run_execution_profile: {
        Args: {
          target_attempt_count: number
          target_run_id: string
          target_workspace_id: string
        }
        Returns: Json
      }
      get_run_export_access: {
        Args: {
          p_export_id: string
          p_session_id: string
          p_user_id: string
          p_workspace_id: string
        }
        Returns: {
          cleaned_at: string | null
          completed_at: string | null
          expires_at: string
          failure_code: string | null
          id: string
          item_count: number
          lease_expires_at: string | null
          lease_token: string | null
          next_ordinal: number
          ready_at: string
          request_id: string
          requested_at: string
          requested_by: string
          snapshot_at: string | null
          snapshot_visibility: unknown
          source_expires_at: string | null
          status: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "run_exports"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_run_mcp_manifest: {
        Args: {
          target_attempt_count?: number
          target_run_id: string
          target_workspace_id: string
        }
        Returns: Json
      }
      get_run_routing_decision: {
        Args: {
          target_attempt_count: number
          target_run_id: string
          target_workspace_id: string
        }
        Returns: Json
      }
      get_run_skill_revisions: {
        Args: {
          target_attempt_count: number
          target_run_id: string
          target_workspace_id: string
        }
        Returns: Json
      }
      get_session_detail_page: {
        Args: { target_session_number: number; target_workspace_slug: string }
        Returns: Json
      }
      get_session_execution_budget: {
        Args: { p_session_id: string }
        Returns: {
          cost_unavailable: boolean
          elapsed_ms: number
          exhaustion_code: string
          max_cost_usd: number
          max_execution_ms: number
          max_repair_attempts: number
          max_total_tokens: number
          policy_revision: number
          remaining_execution_ms: number
          repair_attempts_used: number
          tokens_unavailable: boolean
          total_cost_usd: number
          total_tokens: number
        }[]
      }
      get_session_factory_routing_execution: {
        Args: {
          p_factory_id: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      get_session_git_continuity_state: {
        Args: { p_session_id: string }
        Returns: {
          enabled: boolean
          revision: number
          state: string
        }[]
      }
      get_session_list_page: {
        Args: {
          cursor_id?: string
          cursor_number?: number
          cursor_updated_at?: string
          page_limit?: number
          search_query?: string
          session_scope?: string
          sort_key?: string
          stage_filter_slug?: string
          target_factory_id?: string
          target_workspace_slug: string
        }
        Returns: Json
      }
      get_session_prompt_attachments: {
        Args: { target_session_number: number; target_workspace_slug: string }
        Returns: {
          attachment_position: number
          content_type: string
          id: string
          original_filename: string
          size_bytes: number
        }[]
      }
      get_session_retained_content_erasure: {
        Args: { target_session_id: string; target_workspace_id: string }
        Returns: {
          actor_member_id: string
          archived_at: string
          erased_at: string
          factory_id: string
          session_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_retained_content_erasures"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_session_retry_checkpoint: {
        Args: { p_attempt_count: number; p_job_id: string; p_run_id: string }
        Returns: {
          bundle_sha256: string
          checkpoint_path: string
          head_sha: string
          input_sha: string
          source_attempt_count: number
          source_run_id: string
        }[]
      }
      get_workspace_usage: {
        Args: { target_workspace_id: string }
        Returns: {
          cost_unavailable: boolean
          has_estimated_cost: boolean
          has_estimated_tokens: boolean
          tokens_unavailable: boolean
          total_cost_usd: number
          total_input_tokens: number
          total_output_tokens: number
          total_runs: number
        }[]
      }
      grant_factory_membership: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_member_id: string
          p_role?: string
          p_workspace_id: string
        }
        Returns: {
          factory_id: string
          granted_at: string
          granted_by_member_id: string | null
          id: string
          member_id: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          role: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      has_factory_run_memory_proposal: {
        Args: {
          p_artifact_id: string
          p_artifact_version: number
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      ingest_factory_github_automation_pr: {
        Args: {
          p_action: string
          p_base_branch: string
          p_delivery_id: string
          p_draft: boolean
          p_github_repository_id: number
          p_head_branch: string
          p_head_repository_id?: number
          p_head_sha: string
          p_installation_id: number
          p_merge_commit_sha?: string
          p_provider_updated_at: string
          p_pull_request_id: number
          p_pull_request_number: number
          p_state: string
        }
        Returns: Json
      }
      inspect_factory_mcp_identity: {
        Args: {
          p_credential_digest: string
          p_credential_id: string
          p_credential_kind: Database["public"]["Enums"]["factory_command_credential_kind"]
          p_factory_id: string
          p_resource: string
          p_workspace_id: string
        }
        Returns: {
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          status: string
        }[]
      }
      is_factory_benchmark_inference_request_open: {
        Args: { p_request_id: string }
        Returns: boolean
      }
      is_factory_diagnosis_claim_current: {
        Args: {
          p_attempt_id: string
          p_diagnosis_id: string
          p_factory_id: string
          p_lease_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      is_factory_workflow_exact_review_active: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_permit: string
          p_review_id: string
          p_review_run_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      is_factory_workflow_join_attempt_active: {
        Args: {
          p_attempt_count: number
          p_expected_generation: number
          p_factory_id: string
          p_job_id: string
          p_join_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      is_factory_workflow_repository_validation_active: {
        Args: {
          p_attempt_count: number
          p_factory_id: string
          p_generation: number
          p_job_id: string
          p_join_id: string
          p_owner: string
          p_repository_id: string
          p_root_session_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      issue_factory_machine_token: {
        Args: {
          p_actor_user_id: string
          p_digest: string
          p_expires_at?: string
          p_factory_id: string
          p_grant_id: string
          p_grant_version: number
          p_name: string
          p_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          p_token_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by_member_id: string
          execution_grant_id: string
          execution_grant_version: number
          expires_at: string | null
          factory_id: string
          id: string
          last_used_at: string | null
          last_used_scope:
            | Database["public"]["Enums"]["factory_command_scope"]
            | null
          name: string
          revoked_at: string | null
          revoked_by_member_id: string | null
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          service_principal_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_machine_tokens"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      list_artifact_review_comments: {
        Args: {
          p_after_created_at?: string
          p_after_id?: string
          p_limit?: number
          p_thread_id: string
          p_workspace_id: string
        }
        Returns: {
          author_label: string
          author_member_id: string
          body: string
          created_at: string
          id: string
          revision: number
          thread_id: string
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "artifact_review_comments"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      list_artifact_review_events: {
        Args: {
          p_after_created_at?: string
          p_after_id?: string
          p_limit?: number
          p_thread_id: string
          p_workspace_id: string
        }
        Returns: {
          actor_label: string
          actor_member_id: string
          created_at: string
          detail: Json
          event_type: string
          id: string
          review_revision: number
          thread_id: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "artifact_review_events"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      list_artifact_review_threads: {
        Args: {
          p_after_created_at?: string
          p_after_id?: string
          p_artifact_id: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: {
          anchor: Json
          artifact_id: string
          artifact_version: number
          author_label: string
          author_member_id: string
          created_at: string
          id: string
          kind: string
          revision: number
          session_id: string
          stage_id: string
          stage_slug: string
          status: string
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "artifact_review_threads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      list_factory_automations: {
        Args: {
          p_after_id?: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_benchmark_axis_profiles: {
        Args: {
          p_factory_id: string
          p_suite_revision_id: string
          p_workspace_id: string
        }
        Returns: {
          definition_digest: string
          definition_id: string
          harness: string
          harness_model: string
          id: string
          model_key: string
          sandbox_connection_revision: string
          sandbox_provider: string
          toolchain: string
          toolchain_digest: string
          unavailable_reason: string
          worker_runtime: string
        }[]
      }
      list_factory_benchmark_comparison_exports: {
        Args: {
          p_actor_user_id: string
          p_before_captured_at?: string
          p_before_export_id?: string
          p_experiment_id: string
          p_factory_id: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_benchmark_comparisons: {
        Args: {
          p_actor_user_id: string
          p_before_created_at?: string
          p_before_experiment_id?: string
          p_factory_id: string
          p_limit?: number
          p_suite_revision_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_bindable_workspace_secrets: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: {
          id: string
          key: string
        }[]
      }
      list_factory_context_repository_options: {
        Args: {
          target_after_grant_id?: string
          target_after_repository_id?: string
          target_factory_id: string
          target_limit?: number
          target_workspace_id: string
        }
        Returns: {
          grant_id: string
          grant_version: number
          repository_full_name: string
          repository_id: string
        }[]
      }
      list_factory_context_source_access: {
        Args: {
          target_factory_id: string
          target_source_ids: string[]
          target_workspace_id: string
        }
        Returns: {
          source_id: string
          status: string
        }[]
      }
      list_factory_cost_contributions: {
        Args: {
          p_after_run_id?: string
          p_basis: string
          p_facet?: string
          p_factory_id: string
          p_from: string
          p_limit?: number
          p_merge_id?: string
          p_to: string
          p_workspace_id: string
        }
        Returns: {
          attempt_count: number
          attribution: string
          candidate_merge_id: string
          cost_state: string
          cost_usd: number
          finished_at: string
          merge_id: string
          merge_observation_id: string
          run_id: string
          run_status: string
          session_id: string
          started_at: string
          usage_estimation_revision: string
          usage_finalized_at: string
          usage_recorded_at: string
        }[]
      }
      list_factory_cost_merges: {
        Args: {
          p_cursor_at?: string
          p_cursor_merge_id?: string
          p_factory_id: string
          p_from: string
          p_limit?: number
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_evaluation_receipts: {
        Args: {
          p_actor_user_id: string
          p_before_attempt_id?: string
          p_before_finished_at?: string
          p_factory_id: string
          p_job_id?: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_event_authorizations: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: {
          credential_id: string
          credential_kind: Database["public"]["Enums"]["factory_event_subscription_credential_kind"]
          credential_name: string
          service_principal_id: string
        }[]
      }
      list_factory_event_deliveries: {
        Args: {
          p_actor_user_id: string
          p_before_created_at?: string
          p_before_id?: string
          p_factory_id: string
          p_limit?: number
          p_subscription_id: string
          p_workspace_id: string
        }
        Returns: {
          attempt_count: number
          created_at: string
          delivered_at: string
          event_id: string
          event_type: Database["public"]["Enums"]["factory_outbound_event_type"]
          has_unknown_outcome: boolean
          id: string
          last_attempt_at: string
          last_http_status: number
          last_outcome: Database["public"]["Enums"]["factory_outbound_delivery_outcome"]
          next_attempt_at: string
          retryable: boolean
          status: Database["public"]["Enums"]["factory_outbound_delivery_status"]
        }[]
      }
      list_factory_event_subscriptions: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: {
          authorized: boolean
          created_at: string
          credential_id: string
          credential_kind: Database["public"]["Enums"]["factory_event_subscription_credential_kind"]
          endpoint_url: string
          event_types: Database["public"]["Enums"]["factory_outbound_event_type"][]
          id: string
          name: string
          revoked_at: string
          status: Database["public"]["Enums"]["factory_event_subscription_status"]
          verified_at: string
        }[]
      }
      list_factory_failure_cohorts: {
        Args: {
          p_after_cohort_id?: string
          p_definition_revision_id?: string
          p_disposition?: string
          p_factory_id: string
          p_limit?: number
          p_symptom_kind?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_flow_evidence: {
        Args: {
          p_cursor_at?: string
          p_cursor_end_at?: string
          p_cursor_session_id?: string
          p_environment?: string
          p_facet?: string
          p_factory_id: string
          p_from: string
          p_limit?: number
          p_metric_key: string
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_improvement_workbench: {
        Args: {
          p_after_proposal_id?: string
          p_cohort_id?: string
          p_factory_id: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_revert_evidence: {
        Args: {
          p_cursor_at?: string
          p_cursor_merge_id?: string
          p_factory_id: string
          p_from: string
          p_has_verified_revert?: boolean
          p_limit?: number
          p_status?: string
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_run_score_results: {
        Args: {
          p_attempt_id?: string
          p_factory_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_score_cohorts: {
        Args: {
          p_before_created_at?: string
          p_before_policy_id?: string
          p_factory_id: string
          p_limit?: number
          p_scorer_id?: string
          p_scorer_revision_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_scorer_reevaluations: {
        Args: {
          p_before_created_at?: string
          p_before_job_id?: string
          p_factory_id: string
          p_prior_attempt_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_secret_bindings: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: {
          agent_provider: string
          created_at: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id: string
          material_revision: number
          open_code_provider_id: string
          revoked_at: string
          rotated_at: string
          secret_key: string
          service_principal_id: string
          status: string
          version: number
          workspace_id: string
          workspace_secret_id: string
        }[]
      }
      list_factory_throughput_contributions: {
        Args: {
          p_bucket_key?: string
          p_cursor_at?: string
          p_cursor_attempt_count?: number
          p_cursor_merge_id?: string
          p_cursor_run_id?: string
          p_dimension?: string
          p_factory_id: string
          p_from: string
          p_limit?: number
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_workflow_authoring: {
        Args: {
          p_after_id?: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      list_factory_workflow_branch_repository_bases: {
        Args: never
        Returns: {
          base_branch: string
          factory_id: string
          generation: number
          group_id: string
          installation_id: string
          installation_numeric_id: number
          repository_full_name: string
          repository_id: string
          repository_numeric_id: number
          requires_observation: boolean
          root_session_id: string
          workspace_id: string
        }[]
      }
      list_factory_workflow_intake_options: {
        Args: { p_factory_id: string; p_workspace_id: string }
        Returns: {
          activation_id: string
          definition_digest: string
          display_name: string
          workflow_id: string
        }[]
      }
      list_factory_workflow_repository_deliveries: {
        Args: never
        Returns: {
          factory_id: string
          generation: number
          join_id: string
          ownership_token: string
          repository_id: string
          root_session_id: string
          workspace_id: string
        }[]
      }
      list_run_artifacts: {
        Args: {
          p_after_id?: string
          p_after_kind?: string
          p_artifact_id?: string
          p_kind?: string
          p_limit?: number
          p_run_id: string
          p_workspace_id: string
        }
        Returns: {
          accepted_commit_sha: string
          artifact_id: string
          artifact_kind: string
          attempt_count: number
          availability: string
          checkpoint_run_id: string
          content_type: string
          digest: string
          digest_algorithm: string
          downloadable: boolean
          label: string
          recorded_at: string
          run_id: string
          session_id: string
          size_bytes: number
          validation_commit_sha: string
          validation_run_id: string
          validation_tree_sha: string
        }[]
      }
      list_run_export_cleanup: {
        Args: { p_limit?: number }
        Returns: {
          export_id: string
          workspace_id: string
        }[]
      }
      list_run_exports: {
        Args: { p_limit?: number; p_user_id: string; p_workspace_id: string }
        Returns: {
          cleaned_at: string | null
          completed_at: string | null
          expires_at: string
          failure_code: string | null
          id: string
          item_count: number
          lease_expires_at: string | null
          lease_token: string | null
          next_ordinal: number
          ready_at: string
          request_id: string
          requested_at: string
          requested_by: string
          snapshot_at: string | null
          snapshot_visibility: unknown
          source_expires_at: string | null
          status: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "run_exports"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      list_workspace_run_catalog: {
        Args: {
          p_before_created_at?: string
          p_before_id?: string
          p_factory_id?: string
          p_limit?: number
          p_provider?: string
          p_run_id?: string
          p_session_id?: string
          p_stage_id?: string
          p_status?: Database["public"]["Enums"]["agent_run_status"]
          p_workspace_id: string
        }
        Returns: {
          attempt_count: number
          capture_ended: boolean
          capture_interrupted: boolean
          cost_provenance: string
          created_at: string
          failure_receipt: string
          finished_at: string
          has_events: boolean
          input_tokens: number
          job_id: string
          last_activity_at: string
          model_name: string
          model_provider: string
          output_tokens: number
          run_id: string
          session_id: string
          session_number: number
          session_title: string
          source_recovery_required: boolean
          stage_id: string
          stage_name: string
          started_at: string
          status: Database["public"]["Enums"]["agent_run_status"]
          token_provenance: string
          total_cost_usd: number
          transcript_expired_at: string
          usage_finalized_at: string
        }[]
      }
      load_attempt_predecessor_approvals: {
        Args: { p_session_id: string }
        Returns: {
          approval_receipt_id: string
          artifact_digest: string
          artifact_id: string
          artifact_text: string
          artifact_version: number
          completion_id: string
          current_stage_slug: string
          stage_id: string
          stage_slug: string
        }[]
      }
      load_session_claude_code_credential: {
        Args: { p_creator_member_id: string; p_workspace_id: string }
        Returns: {
          created_at: string
          encrypted_api_key: string
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "user_claude_code_credentials"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      load_session_codex_credential: {
        Args: {
          p_creator_member_id: string
          p_expected_user_id?: string
          p_workspace_id: string
        }
        Returns: {
          access_token_expires_at: string | null
          account_email: string | null
          account_id: string | null
          auth_cache_last_refresh: string | null
          auth_reconnect_reason: string | null
          auth_reconnect_required: boolean
          created_at: string
          credential_generation: string
          credential_type: string
          credential_version: number
          encrypted_credential: string
          scope: string | null
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "user_codex_credentials"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      load_session_cursor_credential: {
        Args: { p_creator_member_id: string; p_workspace_id: string }
        Returns: {
          account_email: string | null
          api_key_expires_at: string
          created_at: string
          credential_generation: string
          encrypted_api_key: string
          reconnect_reason: string | null
          reconnect_required: boolean
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "user_cursor_credentials"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      load_session_opencode_credentials: {
        Args: {
          p_creator_member_id: string
          p_provider_id: string
          p_workspace_id: string
        }
        Returns: {
          encrypted_api_key: string
          user_id: string
          zen_encrypted_api_key: string
        }[]
      }
      load_workspace_onboarding_sandbox_checks: {
        Args: { target_workspace_id: string }
        Returns: Json
      }
      load_workspace_onboarding_secret_previews: {
        Args: { target_workspace_id: string }
        Returns: Json
      }
      maintain_factory_evaluation_queue: {
        Args: { p_limit?: number }
        Returns: {
          attempts_recovered: number
          jobs_admitted: number
          jobs_failed: number
          jobs_requeued: number
          receipts_processed: number
        }[]
      }
      mark_codex_auth_reconnect_required: {
        Args: {
          previous_credential_generation: string
          previous_credential_version: number
          reconnect_reason: string
          target_user_id: string
        }
        Returns: undefined
      }
      mark_expired_workspace_run_content: {
        Args: { p_item_limit?: number; p_workspace_limit?: number }
        Returns: {
          evidence_expired: number
          transcripts_expired: number
        }[]
      }
      open_factory_benchmark_replay_execution: {
        Args: {
          p_actor_user_id: string
          p_execution_id: string
          p_expected_policy_digest: string
          p_factory_id: string
          p_policy_revision_id: string
          p_restoration_receipt_sha256: string
          p_task_revision_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          policy_digest: string
          policy_revision_id: string
          profile: Database["public"]["Enums"]["benchmark_replay_profile"]
          restoration_receipt_sha256: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_benchmark_replay_executions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      open_factory_workflow_branch_group: {
        Args: {
          p_branch_occurrence_id: string
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_source_checkpoint_run_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          group_id: string
        }[]
      }
      persist_codex_auth_json: {
        Args: {
          new_account_email: string
          new_account_id: string
          new_auth_cache_last_refresh: string
          new_encrypted_credential: string
          previous_credential_generation: string
          previous_credential_version: number
          target_user_id: string
        }
        Returns: {
          credential_version: number
        }[]
      }
      pin_factory_run_context: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_manifest: Json
          p_origin_run_id?: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: {
          attempt_count: number
          created_at: string
          job_id: string
          manifest: Json
          manifest_sha256: string
          origin_run_id: string | null
          run_id: string
          session_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_run_context_manifests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      pin_factory_workflow_branch_repository_base: {
        Args: {
          p_base_branch: string
          p_expected_generation: number
          p_factory_id: string
          p_group_id: string
          p_installation_id: string
          p_installation_numeric_id: number
          p_observed_sha?: string
          p_repository_id: string
          p_repository_numeric_id: number
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      pin_session_attempt_manifest: {
        Args: {
          p_agent_effort?: string
          p_attempt_count: number
          p_checkout_sha: string
          p_credential_owner_member_id?: string
          p_job_id: string
          p_max_turns?: number
          p_predecessors: Json
          p_prompt_sha256: string
          p_prompt_utf8_bytes: number
          p_renderer_version: number
          p_run_id: string
          p_worker_runtime: string
        }
        Returns: boolean
      }
      pin_session_job_git_input: {
        Args: {
          p_attempt_count: number
          p_base_branch: string
          p_job_id: string
          p_observed_sha: string
          p_repository_id: string
          p_run_id: string
        }
        Returns: {
          base_branch: string
          created_at: string
          initial_base_sha: string
          input_ref: string | null
          input_sha: string
          job_id: string
          pinned_attempt_count: number | null
          pinned_run_id: string | null
          repository_full_name: string
          repository_id: string
          session_id: string
          source_checkpoint_run_id: string | null
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "session_job_git_inputs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      pin_session_validation_plan: {
        Args: {
          p_commit_sha: string
          p_plan: Json
          p_run_id: string
          p_validation_tree_sha: string
        }
        Returns: {
          attempt_count: number
          commit_sha: string
          created_at: string
          job_id: string
          plan: Json
          repository_id: string
          run_id: string
          session_id: string
          validation_tree_sha: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_validation_plans"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      prepare_factory_diagnosis: {
        Args: {
          p_attempt_id: string
          p_diagnosis_id: string
          p_factory_id: string
          p_lease_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      prepare_factory_improvement_proposal: {
        Args: {
          p_activation_number: number
          p_actor_user_id: string
          p_base_digest: string
          p_base_revision_id: string
          p_diagnosis_id: string
          p_edits: Json
          p_expected_benefit: string
          p_expected_revision_id?: string
          p_factory_id: string
          p_proposal_id?: string
          p_rationale: string
          p_regression_risks: string
          p_request_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      prepare_factory_judge_invocation: {
        Args: {
          p_attempt_id: string
          p_factory_id: string
          p_job_id: string
          p_lease_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      prepare_session_checkpoint_publication: {
        Args: {
          p_artifact_md: string
          p_deadline_at?: string
          p_expected_artifact_version: number
          p_run_id: string
        }
        Returns: boolean
      }
      prepare_session_source_and_checkpoint_publication: {
        Args: {
          p_artifact_md: string
          p_base_branch: string
          p_base_sha: string
          p_body: string
          p_bundle_base64: string
          p_bundle_sha256: string
          p_checkpoint_path: string
          p_deadline_at?: string
          p_expected_artifact_version: number
          p_head_sha: string
          p_input_tokens?: number
          p_output_tokens?: number
          p_repository_id: string
          p_run_id: string
          p_title: string
        }
        Returns: boolean
      }
      prepare_session_source_delivery: {
        Args: {
          p_base_branch: string
          p_base_sha: string
          p_body: string
          p_bundle_base64: string
          p_bundle_sha256: string
          p_checkpoint_path: string
          p_head_sha: string
          p_repository_id: string
          p_run_id: string
          p_title: string
        }
        Returns: boolean
      }
      preview_factory_model_routing: {
        Args: {
          p_actor_user_id: string
          p_draft_id: string
          p_expected_activation_number: number
          p_factory_id: string
          p_task_class_slug?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      process_factory_failure_cohorts: {
        Args: { p_batch_size?: number }
        Returns: number
      }
      process_factory_flow_projection: {
        Args: { p_limit?: number }
        Returns: Json
      }
      process_factory_routing_canary_alerts: {
        Args: { p_limit?: number }
        Returns: Json
      }
      process_factory_scorer_sampling: {
        Args: { p_limit?: number }
        Returns: {
          candidate_count: number
          eligible_count: number
          excluded_count: number
          sampled_count: number
        }[]
      }
      propose_factory_memory: {
        Args: {
          p_artifact_id: string
          p_artifact_version: number
          p_expires_at?: string
          p_factory_id: string
          p_title: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          current_approval_id: string | null
          current_revision_id: string | null
          factory_id: string
          forgotten_at: string | null
          id: string
          pending_revision_id: string | null
          source_artifact_id: string
          source_artifact_version: number
          source_attempt_count: number
          source_commit_sha: string
          source_content_sha256: string
          source_run_id: string
          source_session_id: string
          title: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_memories"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      prune_factory_analytics_exports: {
        Args: { p_limit?: number }
        Returns: number
      }
      prune_factory_command_admissions: {
        Args: { p_batch_size?: number }
        Returns: {
          admissions_deleted: number
          leases_deleted: number
        }[]
      }
      prune_factory_event_outbox: {
        Args: { p_batch_size?: number }
        Returns: {
          deliveries_deleted: number
          events_deleted: number
          subscriptions_deleted: number
        }[]
      }
      prune_factory_oauth_credentials: {
        Args: { p_batch_size?: number }
        Returns: {
          authorizations_deleted: number
          token_pairs_deleted: number
        }[]
      }
      publish_factory_automation: {
        Args: {
          p_actor_user_id: string
          p_automation_id: string
          p_expected_revision_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      publish_factory_benchmark_replay_fixture: {
        Args: {
          p_actor_user_id: string
          p_expected_revision_id?: string
          p_factory_id: string
          p_fixture_key: string
          p_operation: Database["public"]["Enums"]["benchmark_replay_operation"]
          p_response_json: string
          p_workspace_id: string
        }
        Returns: {
          id: string
          response_sha256: string
          revision_number: number
        }[]
      }
      publish_factory_benchmark_replay_policy: {
        Args: {
          p_actor_user_id: string
          p_expected_revision_id?: string
          p_factory_id: string
          p_fixture_revision_ids?: string[]
          p_profile: Database["public"]["Enums"]["benchmark_replay_profile"]
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          policy_digest: string
          profile: Database["public"]["Enums"]["benchmark_replay_profile"]
          revision_number: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_benchmark_replay_policy_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      publish_factory_definition_draft: {
        Args: {
          p_actor_user_id: string
          p_draft_id: string
          p_enabled_sandbox_providers: string[]
          p_expected_activation_number: number
          p_factory_id: string
          p_required_probes: string[]
          p_workspace_id: string
        }
        Returns: {
          activation_number: number
          created_at: string
          created_by: string
          factory_id: string
          id: string
          previous_activation_number: number | null
          revision_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_activations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      publish_factory_workflow_authoring_draft: {
        Args: {
          p_actor_user_id: string
          p_expected_activation_id?: string
          p_expected_base_activation_id: string
          p_expected_base_digest: string
          p_expected_base_revision_id: string
          p_expected_draft_id: string
          p_factory_id: string
          p_request_fingerprint?: string
          p_request_id: string
          p_verified_draft_digest: string
          p_workflow_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      publish_session_job_attempt: {
        Args: {
          p_artifact_json: string
          p_attempt_count: number
          p_deadline_at?: string
          p_expected_artifact_version: number
          p_job_id: string
          p_run_id: string
        }
        Returns: boolean
      }
      publish_session_job_with_source: {
        Args: {
          p_artifact_json: string
          p_attempt_count: number
          p_deadline_at?: string
          p_expected_artifact_version: number
          p_job_id: string
          p_run_id: string
        }
        Returns: boolean
      }
      publish_settings_factory_definition_draft: {
        Args: {
          p_actor_user_id: string
          p_draft_id: string
          p_enabled_sandbox_providers: string[]
          p_expected_activation_number: number
          p_factory_id: string
          p_required_probes: string[]
          p_workspace_id: string
        }
        Returns: {
          activation_number: number
          created_at: string
          created_by: string
          factory_id: string
          id: string
          previous_activation_number: number | null
          revision_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_activations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      purge_expired_factory_memory_bodies: {
        Args: { p_item_limit?: number }
        Returns: number
      }
      purge_expired_run_transcripts: {
        Args: { p_entry_limit?: number; p_run_limit?: number }
        Returns: number
      }
      read_factory_analytics_export: {
        Args: {
          p_export_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      read_factory_automation: {
        Args: {
          p_automation_id: string
          p_factory_id: string
          p_selected_revision_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_automation_admission_control: {
        Args: {
          p_automation_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_benchmark_comparison: {
        Args: {
          p_actor_user_id: string
          p_after_candidate_key?: string
          p_after_trial_id?: string
          p_candidate_limit?: number
          p_experiment_id: string
          p_factory_id: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_benchmark_comparison_export: {
        Args: {
          p_actor_user_id: string
          p_experiment_id: string
          p_export_id: string
          p_factory_id: string
          p_page_kind?: string
          p_page_ordinal?: number
          p_workspace_id: string
        }
        Returns: string
      }
      read_factory_benchmark_evaluation: {
        Args: {
          p_actor_user_id: string
          p_after_scorer_revision_id?: string
          p_after_trial_id?: string
          p_experiment_id: string
          p_factory_id: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_benchmark_frontier: {
        Args: {
          p_actor_user_id: string
          p_after_candidate_key?: string
          p_experiment_id: string
          p_factory_id: string
          p_limit?: number
          p_min_resolved_trials?: number
          p_quality_floor_bps?: number
          p_scorer_revision_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_benchmark_inference_connection: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_benchmark_live_sandbox_binding: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_run_id: string
          p_trial_id: string
        }
        Returns: Json
      }
      read_factory_benchmark_schedule: {
        Args: {
          p_actor_user_id: string
          p_experiment_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_benchmark_trial_evidence: {
        Args: {
          p_actor_user_id: string
          p_experiment_id: string
          p_factory_id: string
          p_trial_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_candidate_activation_eligibility: {
        Args: {
          p_actor_user_id: string
          p_definition_digest: string
          p_enabled_sandbox_providers: string[]
          p_factory_id: string
          p_required_probes: string[]
          p_target_id: string
          p_target_kind: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_credential_ownership: {
        Args: {
          p_after_id?: string
          p_binding_id?: string
          p_factory_id: string
          p_limit?: number
          p_workspace_id: string
        }
        Returns: {
          agent_provider: string
          created_at: string
          execution_grant_id: string
          factory_agent_id: string
          id: string
          material_revision: number
          open_code_provider_id: string
          revoked_at: string
          rotated_at: string
          service_principal_id: string
          status: string
          version: number
        }[]
      }
      read_factory_evaluation_review: {
        Args: {
          p_attempt_id: string
          p_before_adjudication_id?: string
          p_before_created_at?: string
          p_factory_id: string
          p_selected_adjudication_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_improvement_workbench: {
        Args: {
          p_before_event?: number
          p_factory_id: string
          p_proposal_id: string
          p_revision_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_memory_context: {
        Args: {
          p_factory_id: string
          p_revision_ids?: string[]
          p_workspace_id: string
        }
        Returns: {
          approval_id: string
          body_md: string
          content_sha256: string
          memory_id: string
          revision_id: string
        }[]
      }
      read_factory_run_context_origin: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: {
          manifest: Json
          origin_run_id: string
          status: string
        }[]
      }
      read_factory_run_context_revision: {
        Args: {
          p_attempt_count: number
          p_expected_content_sha256?: string
          p_job_id: string
          p_revision_id: string
          p_run_id: string
          p_source_id: string
          p_workspace_id: string
        }
        Returns: {
          content: string
          content_bytes: number
          content_sha256: string
          file_path: string
          installation_id: number
          repository_full_name: string
          repository_id: number
          stale: boolean
          status: string
          upstream_revision: string
        }[]
      }
      read_factory_scope: {
        Args: { p_actor_user_id: string; p_workspace_id: string }
        Returns: {
          factory_id: string
          is_default: boolean
          member_count: number
          name: string
          pipeline_count: number
          repository_count: number
          role: string
          session_count: number
          slug: string
          status: string
        }[]
      }
      read_factory_score_cohort: {
        Args: {
          p_before_run_finished_at?: string
          p_before_run_id?: string
          p_bucket_at?: string
          p_factory_id: string
          p_from: string
          p_limit?: number
          p_policy_id: string
          p_snapshot?: string
          p_status?: string
          p_to: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_scorer_calibration: {
        Args: {
          p_before_candidate_at?: string
          p_before_candidate_id?: string
          p_before_revision?: number
          p_before_set_at?: string
          p_before_set_id?: string
          p_factory_id: string
          p_scorer_id: string
          p_set_id?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_session_command: {
        Args: {
          p_admission_id: string
          p_artifact_id?: string
          p_before_created_at?: string
          p_before_id?: string
          p_before_session_number?: number
          p_conversation_direction?: string
          p_conversation_sequence?: number
          p_credential_digest: string
          p_credential_id: string
          p_credential_kind: Database["public"]["Enums"]["factory_command_credential_kind"]
          p_factory_id: string
          p_lease_id: string
          p_limit?: number
          p_operation: Database["public"]["Enums"]["factory_session_read_operation"]
          p_request_hash: string
          p_request_id: string
          p_run_id?: string
          p_session_id?: string
          p_surface: Database["public"]["Enums"]["factory_command_surface"]
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_authoring: {
        Args: {
          p_factory_id: string
          p_selected_draft_id?: string
          p_workflow_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_branch_group: {
        Args: {
          p_factory_id: string
          p_group_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_command_source: {
        Args: {
          p_factory_id: string
          p_occurrence_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          run_id: string
          session_id: string
        }[]
      }
      read_factory_workflow_delegated_scope: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_exact_review_progress: {
        Args: {
          p_factory_id: string
          p_occurrence_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_exact_review_provider: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_permit: string
          p_review_id: string
          p_review_run_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_execution: {
        Args: {
          p_factory_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_foreman_run: {
        Args: {
          p_factory_id: string
          p_root_session_id: string
          p_route_occurrence_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_inspection: {
        Args: {
          p_before?: Json
          p_page_size?: number
          p_run_id?: string
          p_session_id: string
        }
        Returns: Json
      }
      read_factory_workflow_join: {
        Args: {
          p_factory_id: string
          p_join_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_join_conflict_digest: {
        Args: {
          p_join_id: string
          p_root_session_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      read_factory_workflow_repository_bundle: {
        Args: {
          p_claim_id: string
          p_factory_id: string
          p_generation: number
          p_join_id: string
          p_owner: string
          p_repository_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      read_factory_workflow_repository_delivery: {
        Args: {
          p_factory_id: string
          p_join_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_review_repair_input: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_run_id: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_route_decision: {
        Args: {
          p_factory_id: string
          p_root_session_id: string
          p_route_occurrence_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      read_factory_workflow_triage_binding: {
        Args: {
          p_factory_id: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: {
          graph_revision_id: string
          stage_id: string
          workflow_digest: string
        }[]
      }
      read_linear_automation_span_cursor: {
        Args: { p_workspace_id?: string }
        Returns: {
          after_session_id: string
          generation: number
        }[]
      }
      read_run_export_page: {
        Args: { p_export_id: string; p_lease_token: string; p_limit?: number }
        Returns: {
          availability: string
          metadata: Json
          ordinal: number
          payload: Json
          record_id: string
          record_kind: string
          run_id: string
          source_asset_id: string
        }[]
      }
      reconcile_factory_benchmark_evaluations: {
        Args: { p_limit?: number }
        Returns: number
      }
      reconcile_factory_benchmark_schedules: {
        Args: { p_limit: number }
        Returns: number
      }
      record_active_factory_workflow_join_candidate: {
        Args: {
          p_attempt_count: number
          p_bundle_sha256?: string
          p_commit_sha: string
          p_expected_generation: number
          p_factory_id: string
          p_job_id: string
          p_join_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_run_id: string
          p_tree_sha: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      record_factory_automation_occurrence: {
        Args: {
          p_automation_id: string
          p_causal_session_id?: string
          p_event: Json
          p_expected_revision_id: string
          p_factory_id: string
          p_source_key: string
          p_source_namespace: string
          p_workspace_id: string
        }
        Returns: Json
      }
      record_factory_benchmark_replay_operation: {
        Args: {
          p_execution_id: string
          p_factory_id: string
          p_fixture_key?: string
          p_operation: Database["public"]["Enums"]["benchmark_replay_operation"]
          p_operation_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      record_factory_revert_coverage: {
        Args: {
          p_actor_user_id: string
          p_base_branch: string
          p_factory_id: string
          p_from: string
          p_repository_id: string
          p_request_id: string
          p_through: string
          p_workspace_id: string
        }
        Returns: Json
      }
      record_factory_scorer_sample: {
        Args: {
          p_factory_id: string
          p_policy_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: {
          attempt_count: number | null
          benchmark_result_digest: string | null
          benchmark_trial_id: string | null
          created_at: string
          definition_revision_id: string
          evidence: Json
          factory_id: string
          id: string
          missing_evidence: string[]
          outcome: string
          policy_id: string | null
          reason: string | null
          recorded_xact_id: unknown
          run_finished_at: string
          run_id: string
          scorer_revision_id: string
          session_id: string
          target_commit_sha: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_scorer_sample_receipts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_factory_workflow_accepted_scope: {
        Args: {
          p_approval_id: string
          p_factory_id: string
          p_graph_revision_id: string
          p_input_run_id: string
          p_session_id: string
          p_workflow_digest: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          receipt_id: string
        }[]
      }
      record_factory_workflow_branch_outcome: {
        Args: {
          p_attempt_count: number
          p_branch_edge_id: string
          p_expected_generation: number
          p_factory_id: string
          p_group_id: string
          p_job_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          outcome: Database["public"]["Enums"]["factory_workflow_node_outcome"]
          outcome_id: string
        }[]
      }
      record_factory_workflow_command_result: {
        Args: {
          p_evidence_ref: string
          p_expected_generation: number
          p_factory_id: string
          p_occurrence_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          result_id: string
        }[]
      }
      record_factory_workflow_delegated_result: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_occurrence_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          result_id: string
        }[]
      }
      record_factory_workflow_exact_review: {
        Args: {
          p_checkpoint_run_id: string
          p_commit_sha: string
          p_expected_generation: number
          p_factory_id: string
          p_ownership_token: string
          p_permit: string
          p_report: Json
          p_review_id: string
          p_review_run_id: string
          p_root_session_id: string
          p_tree_sha: string
          p_workspace_id: string
        }
        Returns: string
      }
      record_factory_workflow_node_result: {
        Args: {
          p_evidence_ref?: string
          p_expected_generation: number
          p_factory_id: string
          p_occurrence_id: string
          p_outcome: Database["public"]["Enums"]["factory_workflow_node_outcome"]
          p_ownership_token: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          result_id: string
        }[]
      }
      record_late_factory_workflow_sandbox: {
        Args: {
          p_attempt_count: number
          p_run_id: string
          p_sandbox_connection_revision: string
          p_sandbox_id: string
          p_sandbox_provider: string
          p_sandbox_vercel_project_id?: string
          p_sandbox_vercel_team_id?: string
        }
        Returns: boolean
      }
      record_pr_verification_observation: {
        Args: {
          p_artifact_review_revision: number
          p_base_sha: string
          p_checkpoint_run_id: string
          p_head_sha: string
          p_observed_at: string
          p_payload: Json
          p_policy_revision_id: string
          p_pr_epoch_id: string
          p_pr_number: number
          p_repository_full_name: string
          p_repository_id: string
          p_session_id: string
          p_source: string
          p_workspace_id: string
        }
        Returns: {
          artifact_review_revision: number
          base_sha: string | null
          checkpoint_run_id: string | null
          created_at: string
          head_sha: string | null
          id: string
          observed_at: string
          payload: Json
          policy_revision_id: string
          pr_epoch_id: string | null
          pr_number: number | null
          repository_full_name: string | null
          repository_id: string | null
          session_id: string
          source: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_pr_verification_observations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_pr_verification_result: {
        Args: {
          p_blockers: Json
          p_observation_id: string
          p_state: Database["public"]["Enums"]["pr_readiness_state"]
        }
        Returns: {
          blockers: Json
          created_at: string
          id: string
          observation_id: string
          session_id: string
          state: Database["public"]["Enums"]["pr_readiness_state"]
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_pr_verification_results"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_session_browser_media_verification: {
        Args: {
          p_attempt_count: number
          p_commit_sha: string
          p_records: Json
          p_run_id: string
          p_screenshot_approval_scope_id?: string
          p_transfers: Json
          p_validation_tree_sha: string
          p_video_approval_scope_id?: string
        }
        Returns: {
          created_at: string
          records: Json
          run_id: string
          session_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_browser_verification_receipts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_session_browser_screenshot_verification: {
        Args: {
          p_approval_scope_id?: string
          p_attempt_count: number
          p_commit_sha: string
          p_records: Json
          p_run_id: string
          p_transfers: Json
          p_validation_tree_sha: string
        }
        Returns: {
          created_at: string
          records: Json
          run_id: string
          session_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_browser_verification_receipts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_session_browser_verification: {
        Args: {
          p_attempt_count: number
          p_commit_sha: string
          p_records: Json
          p_run_id: string
          p_validation_tree_sha: string
        }
        Returns: {
          created_at: string
          records: Json
          run_id: string
          session_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_browser_verification_receipts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_session_pull_request: {
        Args: {
          source_is_draft: boolean
          source_pull_request_number: number
          source_pull_request_state: string
          source_pull_request_url: string
          source_updated_at: string
          target_branch_name: string
          target_repository_id: string
          target_session_id: string
          target_workspace_id: string
        }
        Returns: {
          branch_name: string
          created_at: string
          github_observation_token: string | null
          github_repository_id: string | null
          github_updated_at: string | null
          id: string
          is_draft: boolean | null
          pull_request_number: number | null
          pull_request_state: string | null
          pull_request_url: string | null
          session_id: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_pull_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_session_run_usage: {
        Args: {
          p_attempt_count: number
          p_cost_provenance?: string
          p_cost_usd?: number
          p_estimation_revision?: string
          p_finalize?: boolean
          p_input_tokens?: number
          p_job_id: string
          p_output_tokens?: number
          p_run_id: string
          p_token_provenance?: string
        }
        Returns: {
          accepted: boolean
          exhaustion_code: string
        }[]
      }
      record_session_validation_evidence: {
        Args: {
          p_assets?: Json
          p_commit_sha: string
          p_records: Json
          p_run_id: string
          p_validation_tree_sha: string
        }
        Returns: {
          assets: Json
          attempt_count: number
          commit_sha: string
          created_at: string
          job_id: string
          records: Json
          repository_full_name: string
          repository_id: string
          run_id: string
          session_id: string
          validation_tree_sha: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "session_validation_evidence"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_workspace_resource_operation: {
        Args: { p_operation_id: string; p_resource_id: string }
        Returns: boolean
      }
      record_workspace_sandbox_acquisition_stop: {
        Args: { p_operation_id: string; p_sandbox_id: string }
        Returns: boolean
      }
      register_factory_context_source: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_file_path: string
          p_grant_id: string
          p_grant_version: number
          p_repository_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          current_revision_id: string | null
          deleted_at: string | null
          factory_id: string
          file_path: string
          github_installation_id: string
          grant_id: string
          grant_version: number
          id: string
          last_successful_sync_at: string | null
          last_sync_attempt_at: string | null
          repository_id: string
          status: string
          sync_lease_expires_at: string | null
          sync_lease_id: string | null
          upstream_repository_id: number
          upstream_revision: string | null
          upstream_updated_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_context_sources"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      register_factory_oauth_client: {
        Args: {
          p_actor_user_id: string
          p_allowed_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          p_bindings: Json
          p_name: string
          p_redirect_uris: string[]
          p_workspace_id: string
        }
        Returns: {
          allowed_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          created_at: string
          created_by_member_id: string
          id: string
          name: string
          redirect_uris: string[]
          revoked_at: string | null
          revoked_by_member_id: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_oauth_clients"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      register_factory_workflow_graph_revision: {
        Args: {
          p_definition_digest: string
          p_definition_revision_id: string
          p_factory_id: string
          p_workflow_digest: string
          p_workflow_json: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          graph_revision_id: string
        }[]
      }
      register_factory_workflow_sandbox_acquisition: {
        Args: {
          p_attempt_count: number
          p_operation_id: string
          p_run_id: string
        }
        Returns: boolean
      }
      reject_session_stage: {
        Args: {
          p_agent_model_name: string
          p_agent_model_provider: string
          p_artifact_version: number
          p_expected_artifact_id: string
          p_expected_stage_id: string
          p_feedback_text: string
          p_requested_by_member_id?: string
          p_run_type?: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: {
          archived_at: string
          current_artifact_version: number
          current_stage_id: string
          job_created: boolean
          job_id: string
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          rejection_count: number
          run_id: string
          session_id: string
          workspace_id: string
        }[]
      }
      release_factory_command_admission: {
        Args: { p_admission_id: string; p_lease_id: string }
        Returns: boolean
      }
      release_run_export: {
        Args: { p_export_id: string; p_lease_token: string }
        Returns: boolean
      }
      release_session_checkpoint_publication: {
        Args: { p_claim_id: string; p_run_id: string }
        Returns: boolean
      }
      remove_workspace_member: {
        Args: { expected_workspace_id: string; target_member_id: string }
        Returns: {
          email: string
          full_name: string
          id: string
          role: Database["public"]["Enums"]["member_role"]
        }[]
      }
      request_factory_diagnosis: {
        Args: {
          p_actor_user_id: string
          p_cohort_id: string
          p_factory_id: string
          p_prompt_revision_id: string
          p_request_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      request_factory_scorer_reevaluation: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_prior_attempt_id: string
          p_target_revision_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      request_run_export: {
        Args: {
          p_request_id: string
          p_requested_by: string
          p_workspace_id: string
        }
        Returns: {
          cleaned_at: string | null
          completed_at: string | null
          expires_at: string
          failure_code: string | null
          id: string
          item_count: number
          lease_expires_at: string | null
          lease_token: string | null
          next_ordinal: number
          ready_at: string
          request_id: string
          requested_at: string
          requested_by: string
          snapshot_at: string | null
          snapshot_visibility: unknown
          source_expires_at: string | null
          status: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "run_exports"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reserve_factory_benchmark_evaluation_attempt: {
        Args: { p_attempt_id: string; p_trial_id: string }
        Returns: boolean
      }
      reserve_factory_workflow_join_conflict: {
        Args: {
          p_attempt_count: number
          p_digest: string
          p_expected_generation: number
          p_factory_id: string
          p_job_id: string
          p_join_id: string
          p_ownership_token: string
          p_root_session_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      resolve_factory_run_credential: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: {
          agent_provider: string
          binding_id: string
          binding_version: number
          encrypted_value: string
          material_revision: number
          service_principal_id: string
        }[]
      }
      resolve_factory_run_mcp_credentials: {
        Args: {
          p_attempt_count: number
          p_job_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: {
          binding_id: string
          encrypted_value: string
          material_revision: number
          tool_revision_id: string
        }[]
      }
      resolve_session_conversation_source: {
        Args: {
          p_external_thread_id: string
          p_provider: string
          p_source_namespace: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          external_thread_id: string
          factory_id: string
          id: string
          label: string | null
          provider: string
          session_id: string
          source_namespace: string
          source_url: string | null
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "session_conversation_sources"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      restart_session_once_with_first_job: {
        Args: {
          agent_model_name: string
          agent_model_provider: string
          creator_member_id: string
          selected_pipeline_id?: string
          selected_stage_ids?: string[]
          session_attachment_ids: string[]
          session_github_repository_id?: string
          session_linear_issue_id?: string
          session_linear_issue_url?: string
          session_prompt_md: string
          session_title: string
          source_session_id: string
          target_request_hash: string
          target_request_id: string
          target_workspace_id: string
        }
        Returns: {
          job_id: string
          run_id: string
          session_id: string
          session_number: number
          workspace_slug: string
        }[]
      }
      restore_factory: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          archived_reason: string | null
          created_at: string
          id: string
          is_default: boolean
          name: string
          slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factories"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      retry_factory_event_delivery: {
        Args: {
          p_actor_user_id: string
          p_delivery_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      review_factory_failure_cohort: {
        Args: {
          p_action: string
          p_cohort_id: string
          p_expected_membership_digest?: string
          p_expected_review_revision: number
          p_factory_id: string
          p_label?: string
          p_request_id: string
          p_selected_run_ids?: string[]
          p_workspace_id: string
        }
        Returns: Json
      }
      review_factory_memory: {
        Args: {
          p_decision: string
          p_expected_current_revision_id?: string
          p_expected_pending_revision_id?: string
          p_factory_id: string
          p_memory_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          current_approval_id: string | null
          current_revision_id: string | null
          factory_id: string
          forgotten_at: string | null
          id: string
          pending_revision_id: string | null
          source_artifact_id: string
          source_artifact_version: number
          source_attempt_count: number
          source_commit_sha: string
          source_content_sha256: string
          source_run_id: string
          source_session_id: string
          title: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_memories"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_benchmark_inference_connection: {
        Args: {
          p_actor_user_id: string
          p_connection_revision: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      revoke_factory_benchmark_replay_revision: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_fixture_revision_id?: string
          p_policy_revision_id?: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      revoke_factory_deployment_source: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_source_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      revoke_factory_event_subscription: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_subscription_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      revoke_factory_execution_grant: {
        Args: {
          p_actor_user_id: string
          p_expected_version: number
          p_factory_id: string
          p_grant_id: string
          p_reason?: string
          p_workspace_id: string
        }
        Returns: {
          approved_at: string
          approved_by_member_id: string
          budget_payer_member_id: string
          command_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          execution_policy_revision_id: string
          expires_at: string
          factory_id: string
          github_repository_id: string
          id: string
          read_context_repository_ids: string[]
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          service_principal_id: string
          tool_ids: string[]
          version: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_execution_grants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_judge_profile: {
        Args: {
          p_actor_user_id: string
          p_expected_revision: number
          p_workspace_id: string
        }
        Returns: {
          allow_images: boolean
          allow_video: boolean
          approved_by_member_id: string
          created_at: string
          enabled: boolean
          id: string
          model_id: string
          provider: string
          provider_route: string
          revision: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_judge_profile_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_machine_token: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_grant_id: string
          p_token_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by_member_id: string
          execution_grant_id: string
          execution_grant_version: number
          expires_at: string | null
          factory_id: string
          id: string
          last_used_at: string | null
          last_used_scope:
            | Database["public"]["Enums"]["factory_command_scope"]
            | null
          name: string
          revoked_at: string | null
          revoked_by_member_id: string | null
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          service_principal_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_machine_tokens"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_mcp_secret_binding: {
        Args: {
          p_actor_user_id: string
          p_binding_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id: string
          revoked_at: string | null
          revoked_by: string | null
          service_principal_id: string
          tool_revision_id: string
          workspace_id: string
          workspace_secret_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_mcp_secret_bindings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_mcp_server_revision: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_revision_id: string
          p_server_id: string
          p_workspace_id: string
        }
        Returns: {
          auth_kind: string
          created_at: string
          created_by: string
          endpoint: string
          factory_id: string
          id: string
          operation_names: string[]
          revision_number: number
          revoked_at: string | null
          revoked_by: string | null
          server_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_mcp_server_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_membership: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_member_id: string
          p_reason?: string
          p_workspace_id: string
        }
        Returns: {
          factory_id: string
          granted_at: string
          granted_by_member_id: string | null
          id: string
          member_id: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          role: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_oauth_client: {
        Args: {
          p_actor_user_id: string
          p_client_id: string
          p_workspace_id: string
        }
        Returns: {
          allowed_scopes: Database["public"]["Enums"]["factory_command_scope"][]
          created_at: string
          created_by_member_id: string
          id: string
          name: string
          redirect_uris: string[]
          revoked_at: string | null
          revoked_by_member_id: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_oauth_clients"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_oauth_grant: {
        Args: {
          p_actor_user_id: string
          p_grant_id: string
          p_workspace_id: string
        }
        Returns: {
          client_id: string
          consenting_member_id: string
          created_at: string
          expires_at: string
          id: string
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_oauth_grants"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_secret_binding: {
        Args: {
          p_actor_user_id: string
          p_binding_id: string
          p_expected_version: number
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: {
          agent_provider: string
          created_at: string
          created_by_member_id: string
          execution_grant_id: string
          factory_agent_id: string
          factory_id: string
          id: string
          open_code_provider_id: string | null
          revoked_at: string | null
          revoked_by_member_id: string | null
          service_principal_id: string
          version: number
          workspace_id: string
          workspace_secret_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_secret_bindings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_factory_skill_revision: {
        Args: {
          p_actor_user_id: string
          p_factory_id: string
          p_revision_id: string
          p_skill_id: string
          p_workspace_id: string
        }
        Returns: {
          content_md: string
          content_sha256: string
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          revision_number: number
          revoked_at: string | null
          revoked_by: string | null
          skill_id: string
          source_kind: string
          source_ref: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_skill_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      rewrite_default_pipeline: {
        Args: {
          operating_rules_md?: string
          pipeline_name: string
          stage_payload: Json
          target_workspace_id: string
        }
        Returns: Json
      }
      rewrite_default_pipeline_with_approval_policy: {
        Args: {
          operating_rules_md?: string
          pipeline_name: string
          stage_payload: Json
          target_workspace_id: string
        }
        Returns: Json
      }
      rollback_factory_definition: {
        Args: {
          p_actor_user_id: string
          p_enabled_sandbox_providers: string[]
          p_expected_activation_number: number
          p_factory_id: string
          p_required_probes: string[]
          p_revision_id: string
          p_workspace_id: string
        }
        Returns: {
          activation_number: number
          created_at: string
          created_by: string
          factory_id: string
          id: string
          previous_activation_number: number | null
          revision_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_activations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      rollback_factory_routing_activation: {
        Args: {
          p_actor_user_id: string
          p_enabled_sandbox_providers: string[]
          p_expected_activation_number: number
          p_factory_id: string
          p_required_probes: string[]
          p_revision_id: string
          p_target_activation_number: number
          p_workspace_id: string
        }
        Returns: {
          activation_number: number
          created_at: string
          created_by: string
          factory_id: string
          id: string
          previous_activation_number: number | null
          revision_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_activations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      rotate_factory_oauth_refresh_token: {
        Args: {
          p_client_id: string
          p_next_access_token_digest: string
          p_next_access_token_id: string
          p_next_refresh_token_digest: string
          p_next_refresh_token_id: string
          p_refresh_token_digest: string
          p_refresh_token_id: string
          p_requested_scopes?: Database["public"]["Enums"]["factory_command_scope"][]
          p_resource?: string
        }
        Returns: {
          expires_in: number
          scopes: Database["public"]["Enums"]["factory_command_scope"][]
          status: string
        }[]
      }
      save_delivery_policy: {
        Args: {
          p_actor_user_id: string
          p_expected_revision: number
          p_pipeline_id: string
          p_requirements: Json
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          id: string
          pipeline_id: string
          requirements: Json
          revision: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "delivery_policy_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_execution_policy: {
        Args: {
          p_actor_user_id: string
          p_expected_revision: number
          p_requirements: Json
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          id: string
          requirements: Json
          revision: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "execution_policy_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_agent_prompt_revision: {
        Args: {
          p_actor_user_id: string
          p_agent_id: string
          p_expected_revision_number: number
          p_factory_id: string
          p_prompt_md: string
          p_workspace_id: string
        }
        Returns: {
          agent_id: string
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          prompt_md: string
          prompt_sha256: string
          revision_number: number
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_agent_prompt_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_automation_draft: {
        Args: {
          p_actor_user_id: string
          p_automation_id: string
          p_definition: Json
          p_expected_revision_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      save_factory_benchmark_suite_revision: {
        Args: {
          p_actor_user_id: string
          p_expected_revision_id?: string
          p_factory_id: string
          p_name: string
          p_purpose: string
          p_selection_tags?: string[]
          p_suite_id?: string
          p_task_revision_ids?: string[]
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          name: string
          purpose: string
          revision_number: number
          selection_tags: string[] | null
          suite_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_benchmark_suite_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_benchmark_task_revision: {
        Args: {
          p_acceptance_criteria: string
          p_actor_user_id: string
          p_eligibility_reason?: string
          p_expected_revision_id: string
          p_factory_id: string
          p_name: string
          p_replay_eligibility: string
          p_tags: string[]
          p_task_id: string
          p_workspace_id: string
        }
        Returns: {
          acceptance_criteria: string
          created_at: string
          created_by: string
          eligibility_reason: string | null
          factory_id: string
          id: string
          name: string
          replay_eligibility: string
          revision_number: number
          tags: string[]
          task_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_benchmark_task_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_definition_draft: {
        Args: {
          p_actor_user_id: string
          p_canonical_digest: string
          p_definition_json: string
          p_expected_activation_number: number
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: {
          base_activation_number: number | null
          canonical_digest: string
          created_at: string
          created_by: string
          definition_json: string
          factory_id: string
          id: string
          routing_evidence_source_draft_id: string | null
          schema_version: number
          settings_metadata: Json
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_drafts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_improvement_proposal: {
        Args: {
          p_activation_number: number
          p_actor_user_id: string
          p_base_digest: string
          p_base_revision_id: string
          p_candidate_digest?: string
          p_definition_json?: string
          p_diagnosis_id: string
          p_diagnostics: Json
          p_diff?: Json
          p_edits: Json
          p_expected_benefit: string
          p_expected_revision_id?: string
          p_factory_id: string
          p_proposal_id?: string
          p_rationale: string
          p_regression_risks: string
          p_request_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      save_factory_improvement_review_event: {
        Args: {
          p_action: string
          p_actor_user_id: string
          p_expected_review_version: number
          p_factory_id: string
          p_note: string
          p_proposal_id: string
          p_proposal_revision_id: string
          p_request_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      save_factory_mcp_server_revision: {
        Args: {
          p_actor_user_id: string
          p_auth_kind: string
          p_endpoint: string
          p_expected_revision_number: number
          p_factory_id: string
          p_operation_names: string[]
          p_server_id: string
          p_workspace_id: string
        }
        Returns: {
          auth_kind: string
          created_at: string
          created_by: string
          endpoint: string
          factory_id: string
          id: string
          operation_names: string[]
          revision_number: number
          revoked_at: string | null
          revoked_by: string | null
          server_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_mcp_server_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_revert_relationship: {
        Args: {
          p_actor_user_id: string
          p_expected_revision: number
          p_factory_id: string
          p_original_merge_id: string
          p_original_observation_id?: string
          p_proof?: Json
          p_request_id: string
          p_revert_pr_number: number
          p_status: string
          p_workspace_id: string
        }
        Returns: Json
      }
      save_factory_routing_draft: {
        Args: {
          p_actor_user_id: string
          p_candidate_key: string
          p_canonical_digest: string
          p_definition_json: string
          p_expected_activation_number: number
          p_expected_draft_id?: string
          p_experiment_id: string
          p_factory_id: string
          p_request_digest: string
          p_request_id: string
          p_rule_id: string
          p_scorer_revision_id: string
          p_settings_metadata: Json
          p_suite_revision_id: string
          p_workspace_id: string
        }
        Returns: {
          base_activation_number: number | null
          canonical_digest: string
          created_at: string
          created_by: string
          definition_json: string
          factory_id: string
          id: string
          routing_evidence_source_draft_id: string | null
          schema_version: number
          settings_metadata: Json
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_drafts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_scorer_calibration_revision: {
        Args: {
          p_actor_user_id: string
          p_adjudication_ids: string[]
          p_expected_revision: number
          p_factory_id: string
          p_name: string
          p_scorer_id: string
          p_scorer_revision_id: string
          p_set_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      save_factory_scorer_revision: {
        Args: {
          p_actor_user_id: string
          p_definition: Json
          p_expected_revision: number
          p_factory_id: string
          p_scorer_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          definition: Json
          factory_id: string
          id: string
          revision_number: number
          scorer_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_scorer_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_scorer_sampling_policy: {
        Args: {
          p_actor_user_id: string
          p_expected_revision: number
          p_factory_id: string
          p_rate_bps: number
          p_scorer_revision_id: string
          p_seed: string
          p_stage_ids?: string[]
          p_terminal_statuses?: string[]
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          created_by: string
          factory_id: string
          id: string
          rate_bps: number
          revision_number: number
          scorer_revision_id: string
          seed: string
          stage_ids: string[]
          terminal_statuses: string[]
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_scorer_sampling_policies"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_skill_revision: {
        Args: {
          p_actor_user_id: string
          p_content_md: string
          p_expected_revision_number: number
          p_factory_id: string
          p_skill_id: string
          p_source_kind?: string
          p_source_ref?: string
          p_workspace_id: string
        }
        Returns: {
          content_md: string
          content_sha256: string
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          revision_number: number
          revoked_at: string | null
          revoked_by: string | null
          skill_id: string
          source_kind: string
          source_ref: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_skill_revisions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_factory_workflow_authoring_draft: {
        Args: {
          p_actor_user_id: string
          p_expected_activation_id?: string
          p_expected_base_activation_id: string
          p_expected_base_digest: string
          p_expected_base_revision_id: string
          p_expected_draft_id?: string
          p_factory_id: string
          p_rebase?: boolean
          p_request_fingerprint?: string
          p_request_id: string
          p_workflow_digest: string
          p_workflow_id: string
          p_workflow_json: string
          p_workspace_id: string
        }
        Returns: Json
      }
      save_linear_routing_config: {
        Args: {
          p_actor_user_id: string
          p_check_revision?: boolean
          p_expected_revision_id?: string
          p_land_slug?: string
          p_rework_slug: string
          p_status_mappings: Json
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          id: string
          land_stage_id: string | null
          land_stage_slug: string | null
          rework_stage_id: string | null
          rework_stage_slug: string
          status_mappings: Json
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "workspace_linear_routing"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_session_retry_checkpoint: {
        Args: {
          p_attempt_count: number
          p_bundle_sha256: string
          p_checkpoint_path: string
          p_deadline_at: string
          p_head_sha: string
          p_input_sha: string
          p_job_id: string
          p_run_id: string
          p_upload_operation_id: string
        }
        Returns: boolean
      }
      save_settings_factory_definition_draft: {
        Args: {
          p_actor_user_id: string
          p_canonical_digest: string
          p_definition_json: string
          p_expected_activation_number: number
          p_expected_draft_id?: string
          p_factory_id: string
          p_settings_metadata: Json
          p_workspace_id: string
        }
        Returns: {
          base_activation_number: number | null
          canonical_digest: string
          created_at: string
          created_by: string
          definition_json: string
          factory_id: string
          id: string
          routing_evidence_source_draft_id: string | null
          schema_version: number
          settings_metadata: Json
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_drafts"
          isOneToOne: true
          isSetofReturn: false
        }
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
      save_workspace_run_retention: {
        Args: {
          p_actor_user_id: string
          p_context_days?: number
          p_evidence_days?: number
          p_transcript_days?: number
          p_workspace_id: string
        }
        Returns: {
          context_days: number | null
          evidence_days: number | null
          last_swept_at: string | null
          transcript_days: number | null
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "workspace_run_retention"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_active_sandbox_provider: {
        Args: {
          actor_member_id: string
          expected_revision: number
          target_provider: string
          target_workspace_id: string
        }
        Returns: string
      }
      set_factory_improvement_publication_target: {
        Args: {
          p_actor_user_id: string
          p_base_branch: string
          p_factory_id: string
          p_repository_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      set_git_continuity_release: {
        Args: {
          p_enabled: boolean
          p_expected_revision: number
          p_reason: string
        }
        Returns: {
          enabled: boolean
          reason: string
          revision: number
          updated_at: string
        }[]
      }
      settle_factory_context_source_sync: {
        Args: {
          p_actor_user_id: string
          p_content?: string
          p_factory_id: string
          p_lease_id: string
          p_source_id: string
          p_status: string
          p_upstream_revision?: string
          p_upstream_updated_at?: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          current_revision_id: string | null
          deleted_at: string | null
          factory_id: string
          file_path: string
          github_installation_id: string
          grant_id: string
          grant_version: number
          id: string
          last_successful_sync_at: string | null
          last_sync_attempt_at: string | null
          repository_id: string
          status: string
          sync_lease_expires_at: string | null
          sync_lease_id: string | null
          upstream_repository_id: number
          upstream_revision: string | null
          upstream_updated_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_context_sources"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      settle_factory_evaluation_attempt: {
        Args: {
          p_attempt_id: string
          p_factory_id: string
          p_job_id: string
          p_lease_id: string
          p_outcome: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      settle_factory_event_delivery: {
        Args: {
          p_attempt_id?: string
          p_delivery_id: string
          p_http_status?: number
          p_lease_id: string
          p_outcome: Database["public"]["Enums"]["factory_outbound_delivery_outcome"]
          p_retry_after_seconds?: number
        }
        Returns: boolean
      }
      settle_factory_workflow_foreman_inference: {
        Args: {
          p_expected_generation: number
          p_factory_id: string
          p_issue_id: string
          p_outcome: Json
          p_ownership_token: string
          p_root_session_id: string
          p_route_occurrence_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      settle_factory_workflow_join_blocker: {
        Args: {
          p_attempt_count: number
          p_detail: Json
          p_expected_generation: number
          p_factory_id: string
          p_job_id: string
          p_join_id: string
          p_outcome: string
          p_ownership_token: string
          p_root_session_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      settle_factory_workflow_repository_delivery: {
        Args: {
          p_action: string
          p_claim_id: string
          p_factory_id: string
          p_generation: number
          p_join_id: string
          p_owner: string
          p_remote_ref?: string
          p_remote_repository_id?: number
          p_remote_sha?: string
          p_repository_id: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      settle_factory_workflow_sandbox_acquisition: {
        Args: { p_operation_id: string; p_stopped_sandbox_ids: string[] }
        Returns: boolean
      }
      settle_factory_workflow_sandbox_stop: {
        Args: {
          p_confirmed: boolean
          p_lease_token: string
          p_obligation_id: string
        }
        Returns: boolean
      }
      settle_workspace_resource_operation: {
        Args: { p_operation_id: string; p_transferred: boolean }
        Returns: undefined
      }
      stage_factory_benchmark_trial_diff: {
        Args: {
          p_attempt_count: number
          p_input_commit_sha: string
          p_input_tree_sha: string
          p_job_id: string
          p_output_commit_sha: string
          p_output_tree_sha: string
          p_patch: string
          p_patch_sha256: string
          p_run_id: string
          p_trial_id: string
        }
        Returns: boolean
      }
      stage_factory_run_memory_proposal: {
        Args: {
          p_artifact_sha256: string
          p_attempt_count: number
          p_body_md: string
          p_job_id: string
          p_run_id: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      start_factory_benchmark_live_trial: {
        Args: {
          p_attempt_count: number
          p_deadline_at: string
          p_job_id: string
          p_worker_runtime: string
        }
        Returns: Json
      }
      start_factory_benchmark_trial: {
        Args: {
          p_attempt_count: number
          p_deadline_at?: string
          p_job_id: string
        }
        Returns: {
          actor_user_id: string
          attempt_count: number | null
          created_at: string
          deadline_at: string | null
          effective_execution_digest: string | null
          factory_id: string
          failure_code: string | null
          finished_at: string | null
          fixture_key: string | null
          fixture_revision_id: string | null
          id: string
          inference_connection_revision: string | null
          job_id: string
          policy_digest: string
          policy_revision_id: string
          replay_execution_id: string
          run_id: string
          runner_revision: string
          sandbox_connection_revision: string
          session_id: string
          status: string
          task_id: string
          task_revision_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_benchmark_trials"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_factory_definition_capability_check: {
        Args: {
          target_actor_user_id: string
          target_agent_model: string
          target_agent_provider: string
          target_definition_digest: string
          target_github_repository_id: string
          target_sandbox_provider: string
          target_workspace_id: string
        }
        Returns: {
          agent_model: string | null
          agent_provider: string | null
          capabilities: Json
          checked_at: string
          created_at: string
          error_text: string | null
          factory_definition_digest: string | null
          github_repository_id: string | null
          id: string
          sandbox_connection_revision: string | null
          sandbox_id: string | null
          sandbox_provider: string | null
          sandbox_vercel_project_id: string | null
          sandbox_vercel_team_id: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "sandbox_capability_checks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_factory_definition_smoke_test: {
        Args: {
          p_actor_user_id: string
          p_definition_digest: string
          p_enabled_sandbox_providers: string[]
          p_expected_activation_number: number
          p_factory_id: string
          p_required_probes: string[]
          p_target_id: string
          p_target_kind: string
          p_workspace_id: string
        }
        Returns: {
          base_activation_number: number
          created_at: string
          created_by: string
          definition_digest: string
          error_text: string | null
          evidence: Json
          factory_id: string
          finished_at: string | null
          id: string
          lease_expires_at: string
          policy_version: number
          sandbox_connection_revision: string | null
          status: string
          target_id: string
          target_kind: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "factory_definition_smoke_tests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_factory_improvement_validation: {
        Args: {
          p_actor_user_id: string
          p_execution: Json
          p_factory_id: string
          p_holdout_candidates: Json
          p_holdout_suite_revision_id: string
          p_policy_revision_id: string
          p_proposal_id: string
          p_proposal_revision_id: string
          p_request_id: string
          p_scorer_revision_id: string
          p_targeted_candidates: Json
          p_targeted_suite_revision_id: string
          p_thresholds: Json
          p_workspace_id: string
        }
        Returns: Json
      }
      start_factory_workflow_execution: {
        Args: {
          p_definition_digest: string
          p_definition_revision_id: string
          p_factory_id: string
          p_root_session_id: string
          p_workflow_digest: string
          p_workflow_json: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          entry_occurrence_id: string
          execution_generation: number
          ownership_token: string
        }[]
      }
      start_factory_workflow_graph_execution: {
        Args: {
          p_factory_id: string
          p_graph_revision_id: string
          p_input_run_id?: string
          p_root_session_id: string
          p_workspace_id: string
        }
        Returns: {
          created: boolean
          entry_occurrence_id: string
          execution_generation: number
          ownership_token: string
        }[]
      }
      start_factory_workflow_join_attempt: {
        Args: {
          p_attempt_count: number
          p_deadline_at: string
          p_job_id: string
          p_session_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      start_sandbox_capability_check: {
        Args: {
          target_github_repository_id: string
          target_workspace_id: string
        }
        Returns: {
          agent_model: string | null
          agent_provider: string | null
          capabilities: Json
          checked_at: string
          created_at: string
          error_text: string | null
          factory_definition_digest: string | null
          github_repository_id: string | null
          id: string
          sandbox_connection_revision: string | null
          sandbox_id: string | null
          sandbox_provider: string | null
          sandbox_vercel_project_id: string | null
          sandbox_vercel_team_id: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "sandbox_capability_checks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_session_job_attempt: {
        Args: {
          p_attempt_count: number
          p_branch_name?: string
          p_expected_artifact_version: number
          p_expected_stage_id: string
          p_job_id: string
          p_model_name: string
          p_model_provider: string
          p_run_type: string
        }
        Returns: string
      }
      submit_artifact_feedback_batch: {
        Args: {
          p_agent_model_name?: string
          p_agent_model_provider?: string
          p_artifact_version: number
          p_expected_artifact_id: string
          p_expected_review_revision: number
          p_expected_stage_id: string
          p_feedback_text: string
          p_request_id: string
          p_requested_by_member_id?: string
          p_run_type?: string
          p_selected_thread_ids: string[]
          p_session_id: string
          p_workspace_id: string
        }
        Returns: {
          archived_at: string
          current_artifact_version: number
          current_stage_id: string
          feedback_batch_id: string
          job_created: boolean
          job_id: string
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          rejection_count: number
          run_id: string
          session_id: string
          workspace_id: string
        }[]
      }
      submit_session_follow_up_once: {
        Args: {
          p_agent_model_name?: string
          p_agent_model_provider?: string
          p_artifact_version: number
          p_expected_artifact_id: string
          p_expected_review_revision?: number
          p_expected_stage_id: string
          p_factory_id: string
          p_feedback_text: string
          p_request_id?: string
          p_requested_by_member_id?: string
          p_run_type?: string
          p_selected_thread_ids?: string[]
          p_session_id: string
          p_workspace_id: string
        }
        Returns: {
          archived_at: string
          current_artifact_version: number
          current_stage_id: string
          feedback_batch_id: string
          job_created: boolean
          job_id: string
          phase_status: Database["public"]["Enums"]["pipeline_phase_status"]
          rejection_count: number
          run_id: string
          session_id: string
          workspace_id: string
        }[]
      }
      touch_agent_run_activity: {
        Args: { p_attempt_count: number; p_job_id: string; p_run_id: string }
        Returns: boolean
      }
      transition_artifact_review_thread: {
        Args: {
          p_expected_revision: number
          p_reason: string
          p_status: string
          p_thread_id: string
          p_workspace_id: string
        }
        Returns: {
          anchor: Json
          artifact_id: string
          artifact_version: number
          author_label: string
          author_member_id: string
          created_at: string
          id: string
          kind: string
          revision: number
          session_id: string
          stage_id: string
          stage_slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "artifact_review_threads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      transition_artifact_review_thread_once: {
        Args: {
          p_expected_revision: number
          p_reason: string
          p_request_id: string
          p_status: string
          p_thread_id: string
          p_workspace_id: string
        }
        Returns: {
          anchor: Json
          artifact_id: string
          artifact_version: number
          author_label: string
          author_member_id: string
          created_at: string
          id: string
          kind: string
          revision: number
          session_id: string
          stage_id: string
          stage_slug: string
          status: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "artifact_review_threads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_user_profile: {
        Args: {
          actor_avatar_changed?: boolean
          actor_avatar_path?: string
          actor_avatar_url?: string
          actor_full_name: string
          actor_user_id: string
        }
        Returns: {
          saved_avatar_url: string
          saved_full_name: string
          superseded_avatar_path: string
        }[]
      }
      withdraw_factory_revert_coverage: {
        Args: {
          p_actor_user_id: string
          p_coverage_id: string
          p_factory_id: string
          p_workspace_id: string
        }
        Returns: Json
      }
      write_artifact_review_comment: {
        Args: {
          p_body: string
          p_comment_id?: string
          p_expected_revision?: number
          p_thread_id: string
          p_workspace_id: string
        }
        Returns: {
          author_label: string
          author_member_id: string
          body: string
          created_at: string
          id: string
          revision: number
          thread_id: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "artifact_review_comments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      write_artifact_review_comment_once: {
        Args: {
          p_body: string
          p_comment_id?: string
          p_expected_revision?: number
          p_request_id: string
          p_thread_id: string
          p_workspace_id: string
        }
        Returns: {
          author_label: string
          author_member_id: string
          body: string
          created_at: string
          id: string
          revision: number
          thread_id: string
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "artifact_review_comments"
          isOneToOne: true
          isSetofReturn: false
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
      benchmark_replay_operation:
        | "tool_read"
        | "tool_write"
        | "git_write"
        | "chat_write"
        | "issue_write"
        | "deployment_write"
        | "external_tool"
      benchmark_replay_profile:
        | "blocked"
        | "recorded_fixtures"
        | "isolated_test"
      factory_command_admission_status:
        | "admitted"
        | "unauthorized"
        | "forbidden"
        | "rate_limited"
        | "concurrency_limited"
        | "request_conflict"
        | "already_admitted"
      factory_command_credential_kind: "machine_token" | "oauth_access_token"
      factory_command_scope:
        | "sessions:read"
        | "sessions:create"
        | "sessions:follow-up"
        | "sessions:clarify"
        | "sessions:cancel"
        | "deployments:observe"
      factory_command_surface: "api" | "mcp"
      factory_event_subscription_credential_kind:
        | "machine_token"
        | "oauth_grant"
      factory_event_subscription_status: "pending" | "active" | "revoked"
      factory_outbound_delivery_outcome:
        | "delivered"
        | "retryable_failure"
        | "permanent_failure"
        | "unknown"
      factory_outbound_delivery_status:
        | "queued"
        | "claimed"
        | "sending"
        | "delivered"
        | "failed"
        | "unknown"
        | "revoked"
      factory_outbound_event_type:
        | "session.created"
        | "session.canceled"
        | "run.started"
        | "run.completed"
        | "conversation.message_added"
        | "review.ready"
        | "review.approved"
        | "review.changes_requested"
        | "review.clarification_requested"
        | "review.clarification_answered"
      factory_session_mutation_operation:
        | "create"
        | "follow_up"
        | "answer_clarification"
        | "cancel"
      factory_session_read_operation:
        | "sessions"
        | "session"
        | "conversation"
        | "runs"
        | "run"
        | "artifact"
      factory_workflow_node_outcome: "succeeded" | "failed" | "canceled"
      member_kind: "human" | "system"
      member_role: "owner" | "admin" | "member" | "agent"
      pipeline_phase_status:
        | "in_progress"
        | "awaiting_review"
        | "approved"
        | "rejected"
      pr_readiness_state:
        | "unknown"
        | "checking"
        | "blocked"
        | "ready"
        | "merged"
        | "closed"
        | "not_applicable"
      session_conversation_author_kind: "user" | "agent" | "system" | "service"
      session_conversation_message_kind:
        | "message"
        | "initial_prompt"
        | "artifact_feedback"
        | "review_ready"
        | "system"
      session_specification_clarification_status: "pending" | "answered"
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
      benchmark_replay_operation: [
        "tool_read",
        "tool_write",
        "git_write",
        "chat_write",
        "issue_write",
        "deployment_write",
        "external_tool",
      ],
      benchmark_replay_profile: [
        "blocked",
        "recorded_fixtures",
        "isolated_test",
      ],
      factory_command_admission_status: [
        "admitted",
        "unauthorized",
        "forbidden",
        "rate_limited",
        "concurrency_limited",
        "request_conflict",
        "already_admitted",
      ],
      factory_command_credential_kind: ["machine_token", "oauth_access_token"],
      factory_command_scope: [
        "sessions:read",
        "sessions:create",
        "sessions:follow-up",
        "sessions:clarify",
        "sessions:cancel",
        "deployments:observe",
      ],
      factory_command_surface: ["api", "mcp"],
      factory_event_subscription_credential_kind: [
        "machine_token",
        "oauth_grant",
      ],
      factory_event_subscription_status: ["pending", "active", "revoked"],
      factory_outbound_delivery_outcome: [
        "delivered",
        "retryable_failure",
        "permanent_failure",
        "unknown",
      ],
      factory_outbound_delivery_status: [
        "queued",
        "claimed",
        "sending",
        "delivered",
        "failed",
        "unknown",
        "revoked",
      ],
      factory_outbound_event_type: [
        "session.created",
        "session.canceled",
        "run.started",
        "run.completed",
        "conversation.message_added",
        "review.ready",
        "review.approved",
        "review.changes_requested",
        "review.clarification_requested",
        "review.clarification_answered",
      ],
      factory_session_mutation_operation: [
        "create",
        "follow_up",
        "answer_clarification",
        "cancel",
      ],
      factory_session_read_operation: [
        "sessions",
        "session",
        "conversation",
        "runs",
        "run",
        "artifact",
      ],
      factory_workflow_node_outcome: ["succeeded", "failed", "canceled"],
      member_kind: ["human", "system"],
      member_role: ["owner", "admin", "member", "agent"],
      pipeline_phase_status: [
        "in_progress",
        "awaiting_review",
        "approved",
        "rejected",
      ],
      pr_readiness_state: [
        "unknown",
        "checking",
        "blocked",
        "ready",
        "merged",
        "closed",
        "not_applicable",
      ],
      session_conversation_author_kind: ["user", "agent", "system", "service"],
      session_conversation_message_kind: [
        "message",
        "initial_prompt",
        "artifact_feedback",
        "review_ready",
        "system",
      ],
      session_specification_clarification_status: ["pending", "answered"],
      workspace_invitation_status: ["pending", "accepted", "revoked"],
    },
  },
} as const

