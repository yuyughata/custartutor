export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.5';
  };
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string;
          role: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          role: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          role?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      ai_jobs: {
        Row: {
          attempts: number;
          created_at: string;
          created_by: string | null;
          error: Json | null;
          finished_at: string | null;
          id: string;
          idempotency_key: string | null;
          input: Json;
          kind: string;
          lease_token: string | null;
          lease_until: string | null;
          params: Json;
          progress: Json;
          result: Json | null;
          scheme_id: string | null;
          state: Json;
          status: string;
          unit_id: string | null;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          created_by?: string | null;
          error?: Json | null;
          finished_at?: string | null;
          id?: string;
          idempotency_key?: string | null;
          input: Json;
          kind: string;
          lease_token?: string | null;
          lease_until?: string | null;
          params?: Json;
          progress?: Json;
          result?: Json | null;
          scheme_id?: string | null;
          state?: Json;
          status?: string;
          unit_id?: string | null;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          created_by?: string | null;
          error?: Json | null;
          finished_at?: string | null;
          id?: string;
          idempotency_key?: string | null;
          input?: Json;
          kind?: string;
          lease_token?: string | null;
          lease_until?: string | null;
          params?: Json;
          progress?: Json;
          result?: Json | null;
          scheme_id?: string | null;
          state?: Json;
          status?: string;
          unit_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ai_jobs_scheme_id_fkey';
            columns: ['scheme_id'];
            isOneToOne: false;
            referencedRelation: 'schemes';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ai_jobs_unit_id_fkey';
            columns: ['unit_id'];
            isOneToOne: false;
            referencedRelation: 'units';
            referencedColumns: ['id'];
          },
        ];
      };
      ai_usage: {
        Row: {
          cache_creation_tokens: number;
          cache_read_tokens: number;
          created_at: string;
          created_by: string | null;
          duration_ms: number;
          est_cost_usd: number | null;
          id: number;
          input_tokens: number;
          job_id: string | null;
          label: string;
          model: string;
          output_tokens: number;
          stop_reason: string | null;
          task: string;
        };
        Insert: {
          cache_creation_tokens?: number;
          cache_read_tokens?: number;
          created_at?: string;
          created_by?: string | null;
          duration_ms?: number;
          est_cost_usd?: number | null;
          id?: never;
          input_tokens?: number;
          job_id?: string | null;
          label: string;
          model: string;
          output_tokens?: number;
          stop_reason?: string | null;
          task: string;
        };
        Update: {
          cache_creation_tokens?: number;
          cache_read_tokens?: number;
          created_at?: string;
          created_by?: string | null;
          duration_ms?: number;
          est_cost_usd?: number | null;
          id?: never;
          input_tokens?: number;
          job_id?: string | null;
          label?: string;
          model?: string;
          output_tokens?: number;
          stop_reason?: string | null;
          task?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ai_usage_job_id_fkey';
            columns: ['job_id'];
            isOneToOne: false;
            referencedRelation: 'ai_jobs';
            referencedColumns: ['id'];
          },
        ];
      };
      app_settings: {
        Row: {
          key: string;
          updated_at: string;
          updated_by: string | null;
          value: Json;
        };
        Insert: {
          key: string;
          updated_at?: string;
          updated_by?: string | null;
          value: Json;
        };
        Update: {
          key?: string;
          updated_at?: string;
          updated_by?: string | null;
          value?: Json;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          action: string;
          actor: string | null;
          created_at: string;
          detail: Json | null;
          entity: string;
          entity_id: string | null;
          id: number;
        };
        Insert: {
          action: string;
          actor?: string | null;
          created_at?: string;
          detail?: Json | null;
          entity: string;
          entity_id?: string | null;
          id?: never;
        };
        Update: {
          action?: string;
          actor?: string | null;
          created_at?: string;
          detail?: Json | null;
          entity?: string;
          entity_id?: string | null;
          id?: never;
        };
        Relationships: [];
      };
      chapters: {
        Row: {
          created_at: string;
          deleted_at: string | null;
          id: string;
          number: number;
          scheme_id: string;
          status: string;
          sync_seq: number;
          theme_id: string | null;
          title: string;
        };
        Insert: {
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          number: number;
          scheme_id: string;
          status?: string;
          sync_seq?: number;
          theme_id?: string | null;
          title: string;
        };
        Update: {
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          number?: number;
          scheme_id?: string;
          status?: string;
          sync_seq?: number;
          theme_id?: string | null;
          title?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'chapters_scheme_id_fkey';
            columns: ['scheme_id'];
            isOneToOne: false;
            referencedRelation: 'schemes';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'chapters_theme_id_fkey';
            columns: ['theme_id'];
            isOneToOne: false;
            referencedRelation: 'themes';
            referencedColumns: ['id'];
          },
        ];
      };
      characters: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          name: string;
          slug: string;
          traits: Json;
          voice: Json;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          name: string;
          slug: string;
          traits?: Json;
          voice?: Json;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          name?: string;
          slug?: string;
          traits?: Json;
          voice?: Json;
        };
        Relationships: [];
      };
      child_access: {
        Row: {
          child_id: string;
          created_at: string;
          deleted_at: string | null;
          granted_by: string | null;
          household_id: string;
          id: string;
          revoked_at: string | null;
          sync_seq: number;
          tutor_user_id: string;
        };
        Insert: {
          child_id: string;
          created_at?: string;
          deleted_at?: string | null;
          granted_by?: string | null;
          household_id: string;
          id?: string;
          revoked_at?: string | null;
          sync_seq?: number;
          tutor_user_id: string;
        };
        Update: {
          child_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          granted_by?: string | null;
          household_id?: string;
          id?: string;
          revoked_at?: string | null;
          sync_seq?: number;
          tutor_user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'child_access_child_fk';
            columns: ['child_id', 'household_id'];
            isOneToOne: false;
            referencedRelation: 'children';
            referencedColumns: ['id', 'household_id'];
          },
          {
            foreignKeyName: 'child_access_member_fk';
            columns: ['household_id', 'tutor_user_id'];
            isOneToOne: false;
            referencedRelation: 'household_members';
            referencedColumns: ['household_id', 'user_id'];
          },
          {
            foreignKeyName: 'child_access_member_fk';
            columns: ['household_id', 'tutor_user_id'];
            isOneToOne: false;
            referencedRelation: 'member_display';
            referencedColumns: ['household_id', 'user_id'];
          },
        ];
      };
      child_secrets: {
        Row: {
          child_id: string;
          picture_passcode_hash: string | null;
          updated_at: string;
        };
        Insert: {
          child_id: string;
          picture_passcode_hash?: string | null;
          updated_at?: string;
        };
        Update: {
          child_id?: string;
          picture_passcode_hash?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'child_secrets_child_id_fkey';
            columns: ['child_id'];
            isOneToOne: true;
            referencedRelation: 'children';
            referencedColumns: ['id'];
          },
        ];
      };
      children: {
        Row: {
          avatar: string | null;
          created_at: string;
          daily_limit_min: number | null;
          deleted_at: string | null;
          display_alias: string;
          household_id: string;
          id: string;
          level_code: string;
          reading_mode: string;
          sync_seq: number;
        };
        Insert: {
          avatar?: string | null;
          created_at?: string;
          daily_limit_min?: number | null;
          deleted_at?: string | null;
          display_alias: string;
          household_id: string;
          id?: string;
          level_code: string;
          reading_mode?: string;
          sync_seq?: number;
        };
        Update: {
          avatar?: string | null;
          created_at?: string;
          daily_limit_min?: number | null;
          deleted_at?: string | null;
          display_alias?: string;
          household_id?: string;
          id?: string;
          level_code?: string;
          reading_mode?: string;
          sync_seq?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'children_household_id_fkey';
            columns: ['household_id'];
            isOneToOne: false;
            referencedRelation: 'households';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'children_level_code_fkey';
            columns: ['level_code'];
            isOneToOne: false;
            referencedRelation: 'levels';
            referencedColumns: ['code'];
          },
        ];
      };
      consents: {
        Row: {
          action: string;
          child_id: string | null;
          created_at: string;
          household_id: string;
          id: string;
          scope: string;
          user_id: string;
          version: string;
        };
        Insert: {
          action: string;
          child_id?: string | null;
          created_at?: string;
          household_id: string;
          id?: string;
          scope: string;
          user_id: string;
          version: string;
        };
        Update: {
          action?: string;
          child_id?: string | null;
          created_at?: string;
          household_id?: string;
          id?: string;
          scope?: string;
          user_id?: string;
          version?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'consents_child_household_fk';
            columns: ['child_id', 'household_id'];
            isOneToOne: false;
            referencedRelation: 'children';
            referencedColumns: ['id', 'household_id'];
          },
          {
            foreignKeyName: 'consents_household_id_fkey';
            columns: ['household_id'];
            isOneToOne: false;
            referencedRelation: 'households';
            referencedColumns: ['id'];
          },
        ];
      };
      grownup_elevations: {
        Row: {
          created_at: string;
          device_id: string;
          expires_at: string;
          id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          device_id: string;
          expires_at: string;
          id?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          device_id?: string;
          expires_at?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      grownup_pins: {
        Row: {
          failed_attempts: number;
          locked_until: string | null;
          pin_hash: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          failed_attempts?: number;
          locked_until?: string | null;
          pin_hash: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          failed_attempts?: number;
          locked_until?: string | null;
          pin_hash?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      household_members: {
        Row: {
          created_at: string;
          deleted_at: string | null;
          household_id: string;
          role: string;
          status: string;
          sync_seq: number;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          deleted_at?: string | null;
          household_id: string;
          role: string;
          status?: string;
          sync_seq?: number;
          user_id: string;
        };
        Update: {
          created_at?: string;
          deleted_at?: string | null;
          household_id?: string;
          role?: string;
          status?: string;
          sync_seq?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'household_members_household_id_fkey';
            columns: ['household_id'];
            isOneToOne: false;
            referencedRelation: 'households';
            referencedColumns: ['id'];
          },
        ];
      };
      households: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          membership_epoch: number;
          name: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          membership_epoch?: number;
          name: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          membership_epoch?: number;
          name?: string;
        };
        Relationships: [];
      };
      invites: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          child_ids: string[];
          created_at: string;
          created_by: string | null;
          expires_at: string;
          household_id: string;
          id: string;
          role: string;
          token_hash: string;
        };
        Insert: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          child_ids?: string[];
          created_at?: string;
          created_by?: string | null;
          expires_at: string;
          household_id: string;
          id?: string;
          role: string;
          token_hash: string;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          child_ids?: string[];
          created_at?: string;
          created_by?: string | null;
          expires_at?: string;
          household_id?: string;
          id?: string;
          role?: string;
          token_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'invites_household_id_fkey';
            columns: ['household_id'];
            isOneToOne: false;
            referencedRelation: 'households';
            referencedColumns: ['id'];
          },
        ];
      };
      levels: {
        Row: {
          code: string;
          deleted_at: string | null;
          name: string;
          sort: number;
          stage: string;
          sync_seq: number;
        };
        Insert: {
          code: string;
          deleted_at?: string | null;
          name: string;
          sort: number;
          stage: string;
          sync_seq?: number;
        };
        Update: {
          code?: string;
          deleted_at?: string | null;
          name?: string;
          sort?: number;
          stage?: string;
          sync_seq?: number;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string | null;
          id: string;
        };
        Insert: {
          created_at?: string;
          display_name?: string | null;
          id: string;
        };
        Update: {
          created_at?: string;
          display_name?: string | null;
          id?: string;
        };
        Relationships: [];
      };
      progress_events: {
        Row: {
          child_id: string;
          client_event_id: string;
          device_id: string;
          device_seq: number;
          event_type: string;
          household_id: string;
          occurred_at: string;
          payload: Json;
          received_at: string;
          unit_id: string;
        };
        Insert: {
          child_id: string;
          client_event_id: string;
          device_id: string;
          device_seq: number;
          event_type: string;
          household_id: string;
          occurred_at: string;
          payload?: Json;
          received_at?: string;
          unit_id: string;
        };
        Update: {
          child_id?: string;
          client_event_id?: string;
          device_id?: string;
          device_seq?: number;
          event_type?: string;
          household_id?: string;
          occurred_at?: string;
          payload?: Json;
          received_at?: string;
          unit_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'progress_events_child_household_fk';
            columns: ['child_id', 'household_id'];
            isOneToOne: false;
            referencedRelation: 'children';
            referencedColumns: ['id', 'household_id'];
          },
          {
            foreignKeyName: 'progress_events_unit_id_fkey';
            columns: ['unit_id'];
            isOneToOne: false;
            referencedRelation: 'units';
            referencedColumns: ['id'];
          },
        ];
      };
      published_units: {
        Row: {
          content: Json;
          content_hash: string | null;
          deleted_at: string | null;
          id: string;
          is_current: boolean;
          min_app_version: string;
          pack_built_at: string | null;
          pack_manifest_path: string | null;
          published_at: string;
          published_by: string | null;
          schema_version: number;
          sync_seq: number;
          unit_id: string;
          unit_version_id: string;
          version_no: number;
        };
        Insert: {
          content: Json;
          content_hash?: string | null;
          deleted_at?: string | null;
          id?: string;
          is_current?: boolean;
          min_app_version?: string;
          pack_built_at?: string | null;
          pack_manifest_path?: string | null;
          published_at?: string;
          published_by?: string | null;
          schema_version: number;
          sync_seq?: number;
          unit_id: string;
          unit_version_id: string;
          version_no: number;
        };
        Update: {
          content?: Json;
          content_hash?: string | null;
          deleted_at?: string | null;
          id?: string;
          is_current?: boolean;
          min_app_version?: string;
          pack_built_at?: string | null;
          pack_manifest_path?: string | null;
          published_at?: string;
          published_by?: string | null;
          schema_version?: number;
          sync_seq?: number;
          unit_id?: string;
          unit_version_id?: string;
          version_no?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'published_units_unit_id_fkey';
            columns: ['unit_id'];
            isOneToOne: false;
            referencedRelation: 'units';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'published_units_unit_version_id_fkey';
            columns: ['unit_version_id'];
            isOneToOne: true;
            referencedRelation: 'unit_versions';
            referencedColumns: ['id'];
          },
        ];
      };
      scheme_weeks: {
        Row: {
          id: string;
          kind: string;
          scheme_id: string;
          subtopics: string[];
          topic: string | null;
          week_no: number;
        };
        Insert: {
          id?: string;
          kind: string;
          scheme_id: string;
          subtopics?: string[];
          topic?: string | null;
          week_no: number;
        };
        Update: {
          id?: string;
          kind?: string;
          scheme_id?: string;
          subtopics?: string[];
          topic?: string | null;
          week_no?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'scheme_weeks_scheme_id_fkey';
            columns: ['scheme_id'];
            isOneToOne: false;
            referencedRelation: 'schemes';
            referencedColumns: ['id'];
          },
        ];
      };
      schemes: {
        Row: {
          created_at: string;
          id: string;
          level_code: string;
          source_note: string | null;
          status: string;
          subject_id: string;
          term: number;
        };
        Insert: {
          created_at?: string;
          id?: string;
          level_code: string;
          source_note?: string | null;
          status?: string;
          subject_id: string;
          term: number;
        };
        Update: {
          created_at?: string;
          id?: string;
          level_code?: string;
          source_note?: string | null;
          status?: string;
          subject_id?: string;
          term?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'schemes_level_code_fkey';
            columns: ['level_code'];
            isOneToOne: false;
            referencedRelation: 'levels';
            referencedColumns: ['code'];
          },
          {
            foreignKeyName: 'schemes_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
        ];
      };
      subjects: {
        Row: {
          active: boolean;
          colour: string | null;
          created_at: string;
          curriculum_source: string;
          deleted_at: string | null;
          icon: string | null;
          id: string;
          kind: string;
          name: string;
          slug: string;
          sort: number;
          sync_seq: number;
        };
        Insert: {
          active?: boolean;
          colour?: string | null;
          created_at?: string;
          curriculum_source: string;
          deleted_at?: string | null;
          icon?: string | null;
          id?: string;
          kind: string;
          name: string;
          slug: string;
          sort?: number;
          sync_seq?: number;
        };
        Update: {
          active?: boolean;
          colour?: string | null;
          created_at?: string;
          curriculum_source?: string;
          deleted_at?: string | null;
          icon?: string | null;
          id?: string;
          kind?: string;
          name?: string;
          slug?: string;
          sort?: number;
          sync_seq?: number;
        };
        Relationships: [];
      };
      theme_units: {
        Row: {
          lens: string | null;
          theme_id: string;
          unit_id: string;
        };
        Insert: {
          lens?: string | null;
          theme_id: string;
          unit_id: string;
        };
        Update: {
          lens?: string | null;
          theme_id?: string;
          unit_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'theme_units_theme_id_fkey';
            columns: ['theme_id'];
            isOneToOne: false;
            referencedRelation: 'themes';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'theme_units_unit_id_fkey';
            columns: ['unit_id'];
            isOneToOne: false;
            referencedRelation: 'units';
            referencedColumns: ['id'];
          },
        ];
      };
      themes: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          term: number;
          title: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          term: number;
          title: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          term?: number;
          title?: string;
        };
        Relationships: [];
      };
      unit_progress: {
        Row: {
          attempts: number;
          child_id: string;
          deleted_at: string | null;
          household_id: string;
          last_section: string | null;
          mastery_score: number | null;
          status: string;
          sync_seq: number;
          unit_id: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          child_id: string;
          deleted_at?: string | null;
          household_id: string;
          last_section?: string | null;
          mastery_score?: number | null;
          status: string;
          sync_seq?: number;
          unit_id: string;
          updated_at: string;
        };
        Update: {
          attempts?: number;
          child_id?: string;
          deleted_at?: string | null;
          household_id?: string;
          last_section?: string | null;
          mastery_score?: number | null;
          status?: string;
          sync_seq?: number;
          unit_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'unit_progress_child_household_fk';
            columns: ['child_id', 'household_id'];
            isOneToOne: false;
            referencedRelation: 'children';
            referencedColumns: ['id', 'household_id'];
          },
          {
            foreignKeyName: 'unit_progress_unit_id_fkey';
            columns: ['unit_id'];
            isOneToOne: false;
            referencedRelation: 'units';
            referencedColumns: ['id'];
          },
        ];
      };
      unit_versions: {
        Row: {
          base_version_id: string | null;
          content: Json;
          created_at: string;
          created_by: string | null;
          generated_by: string;
          id: string;
          lint_report: Json | null;
          model: string | null;
          prompt_version: string | null;
          schema_version: number;
          status: string;
          unit_id: string;
          version: number;
        };
        Insert: {
          base_version_id?: string | null;
          content?: Json;
          created_at?: string;
          created_by?: string | null;
          generated_by: string;
          id?: string;
          lint_report?: Json | null;
          model?: string | null;
          prompt_version?: string | null;
          schema_version: number;
          status?: string;
          unit_id: string;
          version: number;
        };
        Update: {
          base_version_id?: string | null;
          content?: Json;
          created_at?: string;
          created_by?: string | null;
          generated_by?: string;
          id?: string;
          lint_report?: Json | null;
          model?: string | null;
          prompt_version?: string | null;
          schema_version?: number;
          status?: string;
          unit_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'unit_versions_base_version_id_fkey';
            columns: ['base_version_id'];
            isOneToOne: false;
            referencedRelation: 'unit_versions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'unit_versions_unit_id_fkey';
            columns: ['unit_id'];
            isOneToOne: false;
            referencedRelation: 'units';
            referencedColumns: ['id'];
          },
        ];
      };
      units: {
        Row: {
          chapter_id: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          kind: string;
          objective: string | null;
          periods: number;
          stage: string;
          status: string;
          sync_seq: number;
          title: string;
          unit_no: number;
          week_no: number | null;
        };
        Insert: {
          chapter_id: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          kind: string;
          objective?: string | null;
          periods?: number;
          stage: string;
          status?: string;
          sync_seq?: number;
          title: string;
          unit_no: number;
          week_no?: number | null;
        };
        Update: {
          chapter_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          kind?: string;
          objective?: string | null;
          periods?: number;
          stage?: string;
          status?: string;
          sync_seq?: number;
          title?: string;
          unit_no?: number;
          week_no?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'units_chapter_id_fkey';
            columns: ['chapter_id'];
            isOneToOne: false;
            referencedRelation: 'chapters';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      member_display: {
        Row: {
          display_name: string | null;
          household_id: string | null;
          role: string | null;
          user_id: string | null;
        };
        Insert: {
          display_name?: never;
          household_id?: string | null;
          role?: string | null;
          user_id?: string | null;
        };
        Update: {
          display_name?: never;
          household_id?: string | null;
          role?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'household_members_household_id_fkey';
            columns: ['household_id'];
            isOneToOne: false;
            referencedRelation: 'households';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Functions: {
      accept_invite: {
        Args: { p_token: string };
        Returns: {
          household_id: string;
          role: string;
        }[];
      };
      ai_job_acquire_lease: {
        Args: { p_job_id: string; p_lease_seconds: number };
        Returns: Json;
      };
      ai_job_budget_check: { Args: { p_job_id: string }; Returns: Json };
      ai_job_complete_step: {
        Args: {
          p_job_id: string;
          p_lease_token: string;
          p_output: Json;
          p_progress: Json;
          p_result: Json;
          p_step: string;
          p_usage: Json;
        };
        Returns: boolean;
      };
      ai_job_fail_step: {
        Args: {
          p_error: Json;
          p_job_id: string;
          p_lease_token: string;
          p_retryable: boolean;
          p_step: string;
          p_usage?: Json;
        };
        Returns: boolean;
      };
      ai_job_fail_step_deprecated: {
        Args: {
          p_error: Json;
          p_job_id: string;
          p_lease_token: string;
          p_retryable: boolean;
          p_step: string;
        };
        Returns: boolean;
      };
      apply_chapter_plan: {
        Args: { p_plan: Json; p_scheme_id: string };
        Returns: Json;
      };
      approve_scheme: { Args: { p_scheme_id: string }; Returns: undefined };
      authorize_pack_download: {
        Args: { p_unit_id: string; p_version_no: number };
        Returns: Json;
      };
      cancel_ai_job: { Args: { p_job_id: string }; Returns: Json };
      create_ai_job: {
        Args: {
          p_idempotency_key: string;
          p_input: Json;
          p_kind: string;
          p_params: Json;
          p_scheme_id: string;
          p_unit_id: string;
        };
        Returns: Json;
      };
      create_household: { Args: { p_name: string }; Returns: string };
      create_invite: {
        Args: {
          p_child_ids: string[];
          p_household_id: string;
          p_role: string;
          p_ttl_hours?: number;
        };
        Returns: {
          expires_at: string;
          invite_id: string;
          token: string;
        }[];
      };
      create_unit_version_draft: {
        Args: {
          p_base_version_id: string;
          p_content: Json;
          p_generated_by: string;
          p_lint_report: Json;
          p_model: string;
          p_prompt_version: string;
          p_unit_id: string;
        };
        Returns: Json;
      };
      elevate_grownup: {
        Args: { p_device_id: string; p_pin: string };
        Returns: string;
      };
      end_grownup_elevation: { Args: never; Returns: undefined };
      get_ai_settings: { Args: never; Returns: Json };
      get_ai_usage_summary: {
        Args: { p_from: string; p_to: string };
        Returns: Json;
      };
      get_grownup_pin_status: {
        Args: never;
        Returns: {
          failed_attempts: number;
          has_pin: boolean;
          locked_until: string;
        }[];
      };
      get_pack_source: { Args: { p_published_unit_id: string }; Returns: Json };
      grant_child_access: {
        Args: { p_child_id: string; p_tutor_user_id: string };
        Returns: string;
      };
      ingest_progress_events: { Args: { p_events: Json }; Returns: Json };
      publish_unit_version: {
        Args: { p_unit_version_id: string };
        Returns: string;
      };
      remove_member: {
        Args: { p_household_id: string; p_user_id: string };
        Returns: undefined;
      };
      revoke_child_access: {
        Args: { p_child_id: string; p_tutor_user_id: string };
        Returns: number;
      };
      save_scheme_draft: {
        Args: {
          p_level_code: string;
          p_source_note: string;
          p_subject_id: string;
          p_term: number;
          p_weeks: Json;
        };
        Returns: string;
      };
      set_app_setting: {
        Args: { p_key: string; p_value: Json };
        Returns: undefined;
      };
      set_grownup_pin: { Args: { p_pin: string }; Returns: undefined };
      set_pack_info: {
        Args: {
          p_content_hash: string;
          p_manifest_path: string;
          p_published_unit_id: string;
        };
        Returns: Json;
      };
      set_unit_version_status: {
        Args: { p_status: string; p_unit_version_id: string };
        Returns: undefined;
      };
      sync_pull: {
        Args: { p_limit: number; p_since_seq: number };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
