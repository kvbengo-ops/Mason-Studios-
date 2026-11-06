export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// --- Hand-maintained enum aliases -------------------------------------------
// `supabase gen types` only emits a literal union for a native Postgres
// enum type. Every "enum-ish" column in this schema is deliberately a
// `text` column with a CHECK constraint instead — see 0012_render_settings.sql
// for why a CHECK on OUR OWN product vocabulary is fine even though a CHECK
// mirroring a vendor's enum (the one case this schema used to have,
// scenes.duration_s) was removed for being the wrong layer. A CHECK
// constraint carries no type information into the generator, so it emits
// `string` for these columns; the aliases below restore the literal types
// by hand and are spliced into the Row/Insert/Update shapes just below.
// Regenerating this file (`supabase gen types ...`) overwrites all of it —
// whoever edits a CHECK constraint (0001_init.sql, 0013_project_direction.sql,
// ...) must update the matching alias here and re-apply this patch in the
// same commit.
//
// The patch is NOT only the aliases: projects.render_settings is typed
// `unknown`, not the generated `Json`. That is deliberate. `Json`'s index
// signature cannot be satisfied by a named interface like RenderSettings —
// TS never infers one from properties alone — so a generated `Json` forces
// every write through a double cast, which is a real type hole dressed up as
// a formality. `unknown` accepts the validated value directly and keeps the
// only real gate where it belongs: the Zod parse in lib/models.ts. A regen
// that restores `Json` here has dropped half this patch; the double cast
// reappearing in actions/render-settings.ts is the symptom.
// 'trusted_editor' added by 0031_account_allowances.sql — a SPEND tier
// only (a higher lib/spend.ts allowance), not a visibility tier: is_admin()
// (0002_rls.sql), the only role branch anywhere in RLS, treats it exactly
// like 'editor'. See that migration's header for the full audit of every
// role branch in this codebase.
export type ProfileRole = "admin" | "editor" | "trusted_editor";
// Admin approval state, added by 0052_account_approval.sql. Orthogonal to
// ProfileRole above: role answers "what may this account do", status answers
// "may it do anything at all yet". Every new account is 'pending' (the
// column default) until an admin approves it from /users; 'rejected' is
// terminal. requireUser() (actions/guard.ts) is the one place this is
// enforced app-side.
export type ProfileStatus = "pending" | "active" | "rejected" | "deactivated";
export type ProjectStatus = "draft" | "briefed" | "framed" | "rendering" | "complete" | "delivered";
// Which console owns this project — 0064_project_kind.sql. 'scripted' is
// the default and every project before this column existed; 'clip' is
// createClipProject's (actions/ugc.ts) /ugc console. The project list's
// title link branches on this instead of hard-coding one route for every
// row — see that migration's header for the defect this fixes.
// 'image' added by 0084_image_project_kind.sql: the Image Generator's own
// console at /images/<id>. It lives OUTSIDE the /projects/<id> route tree on
// purpose — an image project has no script, scenes or cut, so inheriting that
// segment's rail would show locked steps it can never satisfy. projects-table
// branches the title link on this; a kind with no branch opens the wrong screen.
export type ProjectKind = "scripted" | "clip" | "image";
export type SceneStatus = "draft" | "frame_ready" | "queued" | "rendering" | "done" | "failed";
export type AssetKind =
  | "character_ref"
  | "product_ref"
  | "composite_ref"
  | "ref_frame"
  | "clip"
  | "final"
  | "poster"
  // 0079_audio_asset_kind.sql. A WAV or MP3 voice reference, sent to kie as
  // reference_audio_urls. Kept in step with assets_kind_check by hand, like
  // every alias in this section — see the header above on why these are not
  // generated.
  | "audio"
  // 0083_image_generator.sql. A standalone image from the Image Generator,
  // previewed, listed and downloaded by a human. Deliberately NOT a
  // conditioning reference: loadConditioningRefs (lib/frames.ts) reads
  // "character_ref", and reusing that kind would silently change what the
  // /ugc wizard renders against.
  | "generated_image"
  // 0093_video_reference_elements.sql. An uploaded .mp4 reference element.
  // Kept in step with assets_kind_check by hand, like every alias in this
  // section. Deliberately NOT a conditioning reference either: it can never
  // appear on a scene_references row, because that table's own kind CHECK
  // stays at image/audio only -- see 0093's header for why.
  | "video_ref";
export type ShootingMode = "selfie" | "static" | "mirror";
export type UgcStyle =
  "auto" | "talking_head" | "voiceover" | "b_roll" | "testimonial" | "unboxing";
// Which @tag picker/autocomplete surface an elements row belongs to — see
// 0065_elements.sql.
/**
 * What KIND of reference an element is, as of 0093: "image", "audio" or
 * "video". The four older subject-based values are still legal and still
 * held by rows that predate the change -- nothing branches on any of them,
 * the value is a filter label -- so they stay in the union rather than being
 * rewritten. See 0081_element_kind_categories.sql for why 'voice' was
 * renamed and the rest were left alone, and 0093_video_reference_elements.sql
 * for why "video" cannot reach a scene despite being a legal category here.
 */
export type ElementCategory =
  "image" | "audio" | "video" | "character" | "product" | "voice" | "location";

// 'pending'/'approved'/'denied'/'cancelled' — allowance_requests.status
// (0032_allowance_requests.sql). CHECK-constrained, not a Postgres enum —
// same reasoning as ProfileRole above.
export type AllowanceRequestStatus = "pending" | "approved" | "denied" | "cancelled";
// Persistent inbox event vocabulary — 0102_notifications.sql. These record
// workflow changes, not a credit balance or a mutable money ledger.
export type NotificationKind =
  | "scene_completed"
  | "credit_requested"
  | "credit_approved"
  | "credit_received"
  | "credit_sent"
  | "credit_renewed"
  | "credit_denied"
  | "credit_limits_changed"
  | "image_queued"
  | "image_generating"
  | "image_completed"
  | "image_failed"
  | "image_billing_unknown"
  | "task_assigned"
  | "task_submitted"
  | "task_changes_requested"
  | "task_completed"
  | "task_cancelled";
export type TaskAudience = "all" | "selected";
export type TaskPriority = "urgent" | "high" | "normal" | "low";
export type TaskAssignmentStatus =
  "assigned" | "in_progress" | "submitted" | "changes_requested" | "completed" | "cancelled";
export type TaskSubmissionDecision = "accepted" | "changes_requested";

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15";
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
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
  public: {
    Tables: {
      // 0032_allowance_requests.sql — a ledger entry raising one account's
      // effective weekly allowance (web/lib/spend.ts's getEffectiveWeeklyCapUsd).
      // Never updated or deleted once written — see that migration's RLS
      // section for why there is no update/delete policy at all.
      app_settings: {
        // 0077_daily_cap_toggle.sql — installation-wide settings an admin
        // changes from the app. One row, enforced by the boolean primary key.
        Row: {
          id: boolean;
          user_daily_cap_enabled: boolean;
          global_spend_cap_enabled: boolean;
          global_spend_cap_usd: number;
          global_spend_cap_period: "daily" | "weekly";
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: boolean;
          user_daily_cap_enabled?: boolean;
          global_spend_cap_enabled?: boolean;
          global_spend_cap_usd?: number;
          global_spend_cap_period?: "daily" | "weekly";
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          id?: boolean;
          user_daily_cap_enabled?: boolean;
          global_spend_cap_enabled?: boolean;
          global_spend_cap_usd?: number;
          global_spend_cap_period?: "daily" | "weekly";
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "app_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      issue_reports: {
        // 0082_issue_reports.sql — one row per report sent from the in-app
        // "Report a problem" dialog. The issue itself lives on GitHub; this
        // is the ledger the rate limit and the duplicate window read from,
        // and the record of attempts that never reached GitHub at all.
        Row: {
          id: string;
          user_id: string;
          title: string;
          body_hash: string;
          issue_number: number | null;
          issue_url: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          body_hash: string;
          issue_number?: number | null;
          issue_url?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          body_hash?: string;
          issue_number?: number | null;
          issue_url?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      allowance_grants: {
        Row: {
          amount_usd: number;
          created_at: string;
          expires_at: string;
          granted_by: string;
          id: string;
          note: string | null;
          request_id: string | null;
          // 0075_revoke_allowance_grants.sql — a grant counts only while
          // revoked_at is null AND expires_at > now(). Appended facts, not
          // an edit of the grant: see that migration's header.
          revoked_at: string | null;
          revoked_by: string | null;
          // 0087_pass_allowance.sql — the counterparty on both halves of a
          // pass, null on every ordinary grant. `transfer_peer_id is null`
          // is what splits grantedInUsd from receivedUsd/passedOutUsd in
          // lib/spend.ts's getActiveGrantsSummary.
          transfer_peer_id: string | null;
          user_id: string;
        };
        Insert: {
          amount_usd: number;
          created_at?: string;
          expires_at: string;
          granted_by: string;
          id?: string;
          note?: string | null;
          request_id?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          transfer_peer_id?: string | null;
          user_id: string;
        };
        Update: {
          amount_usd?: number;
          created_at?: string;
          expires_at?: string;
          granted_by?: string;
          id?: string;
          note?: string | null;
          request_id?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          transfer_peer_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "allowance_grants_granted_by_fkey";
            columns: ["granted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "allowance_grants_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "allowance_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "allowance_grants_transfer_peer_id_fkey";
            columns: ["transfer_peer_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "allowance_grants_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          id: string;
          created_by: string;
          title: string;
          brief: string;
          deliverable_description: string;
          due_at: string | null;
          priority: TaskPriority;
          audience: TaskAudience;
          request_key: string;
          created_at: string;
          updated_at: string;
          cancelled_at: string | null;
        };
        Insert: {
          id?: string;
          created_by: string;
          title: string;
          brief: string;
          deliverable_description: string;
          due_at?: string | null;
          priority?: TaskPriority;
          audience: TaskAudience;
          request_key: string;
          created_at?: string;
          updated_at?: string;
          cancelled_at?: string | null;
        };
        Update: {
          id?: string;
          created_by?: string;
          title?: string;
          brief?: string;
          deliverable_description?: string;
          due_at?: string | null;
          priority?: TaskPriority;
          audience?: TaskAudience;
          request_key?: string;
          created_at?: string;
          updated_at?: string;
          cancelled_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      task_assignments: {
        Row: {
          id: string;
          task_id: string;
          assignee_id: string;
          status: TaskAssignmentStatus;
          current_revision: number;
          started_at: string | null;
          submitted_at: string | null;
          completed_at: string | null;
          cancelled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          task_id: string;
          assignee_id: string;
          status?: TaskAssignmentStatus;
          current_revision?: number;
          started_at?: string | null;
          submitted_at?: string | null;
          completed_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          task_id?: string;
          assignee_id?: string;
          status?: TaskAssignmentStatus;
          current_revision?: number;
          started_at?: string | null;
          submitted_at?: string | null;
          completed_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "task_assignments_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_assignments_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      task_submissions: {
        Row: {
          id: string;
          assignment_id: string;
          revision: number;
          deliverable_url: string;
          note: string | null;
          submitted_at: string;
          reviewed_at: string | null;
          reviewer_id: string | null;
          decision: TaskSubmissionDecision | null;
          feedback: string | null;
        };
        Insert: {
          id?: string;
          assignment_id: string;
          revision: number;
          deliverable_url: string;
          note?: string | null;
          submitted_at?: string;
          reviewed_at?: string | null;
          reviewer_id?: string | null;
          decision?: TaskSubmissionDecision | null;
          feedback?: string | null;
        };
        Update: {
          id?: string;
          assignment_id?: string;
          revision?: number;
          deliverable_url?: string;
          note?: string | null;
          submitted_at?: string;
          reviewed_at?: string | null;
          reviewer_id?: string | null;
          decision?: TaskSubmissionDecision | null;
          feedback?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_submissions_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "task_assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_submissions_reviewer_id_fkey";
            columns: ["reviewer_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          kind: NotificationKind;
          title: string;
          body: string;
          metadata: Json;
          read_at: string | null;
          created_at: string;
          scene_id: string | null;
          allowance_request_id: string | null;
          allowance_grant_id: string | null;
          task_id: string | null;
          task_assignment_id: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: NotificationKind;
          title: string;
          body: string;
          metadata?: Json;
          read_at?: string | null;
          created_at?: string;
          scene_id?: string | null;
          allowance_request_id?: string | null;
          allowance_grant_id?: string | null;
          task_id?: string | null;
          task_assignment_id?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          kind?: NotificationKind;
          title?: string;
          body?: string;
          metadata?: Json;
          read_at?: string | null;
          created_at?: string;
          scene_id?: string | null;
          allowance_request_id?: string | null;
          allowance_grant_id?: string | null;
          task_id?: string | null;
          task_assignment_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_allowance_grant_id_fkey";
            columns: ["allowance_grant_id"];
            isOneToOne: false;
            referencedRelation: "allowance_grants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_allowance_request_id_fkey";
            columns: ["allowance_request_id"];
            isOneToOne: false;
            referencedRelation: "allowance_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_scene_id_fkey";
            columns: ["scene_id"];
            isOneToOne: false;
            referencedRelation: "scenes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_task_assignment_id_fkey";
            columns: ["task_assignment_id"];
            isOneToOne: false;
            referencedRelation: "task_assignments";
            referencedColumns: ["id"];
          },
        ];
      };
      chat_conversations: {
        Row: {
          id: string;
          user_low_id: string;
          user_high_id: string;
          created_at: string;
          last_message_at: string | null;
        };
        Insert: {
          id?: string;
          user_low_id: string;
          user_high_id: string;
          created_at?: string;
          last_message_at?: string | null;
        };
        Update: {
          id?: string;
          user_low_id?: string;
          user_high_id?: string;
          created_at?: string;
          last_message_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "chat_conversations_user_low_id_fkey";
            columns: ["user_low_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "chat_conversations_user_high_id_fkey";
            columns: ["user_high_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      chat_messages: {
        Row: {
          id: string;
          conversation_id: string;
          sender_id: string;
          sender_name: string;
          body: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          sender_id: string;
          sender_name: string;
          body: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          sender_id?: string;
          sender_name?: string;
          body?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "chat_conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "chat_messages_sender_id_fkey";
            columns: ["sender_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      chat_read_states: {
        Row: {
          conversation_id: string;
          user_id: string;
          last_read_at: string;
          last_read_message_id: string;
          updated_at: string;
        };
        Insert: {
          conversation_id: string;
          user_id: string;
          last_read_at?: string;
          last_read_message_id?: string;
          updated_at?: string;
        };
        Update: {
          conversation_id?: string;
          user_id?: string;
          last_read_at?: string;
          last_read_message_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "chat_read_states_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "chat_conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "chat_read_states_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      // 0036_fal_topups.sql — a manual ledger entry: an admin funded the fal
      // account (in fal's own dashboard) and logged it here afterward.
      // Admin-only read/write via RLS; never updated or deleted once
      // written. Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      kie_topups: {
        Row: {
          amount_usd: number;
          created_at: string;
          id: string;
          note: string | null;
          recorded_by: string;
          topped_up_at: string;
        };
        Insert: {
          amount_usd: number;
          created_at?: string;
          id?: string;
          note?: string | null;
          recorded_by: string;
          topped_up_at?: string;
        };
        Update: {
          amount_usd?: number;
          created_at?: string;
          id?: string;
          note?: string | null;
          recorded_by?: string;
          topped_up_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "kie_topups_recorded_by_fkey";
            columns: ["recorded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      // 0032_allowance_requests.sql — an editor's ask for a higher weekly
      // allowance (web/actions/allowance.ts's requestAllowance) and its
      // eventual decision (decideAllowanceRequest). At most one 'pending'
      // row per user_id, enforced by a partial unique index, not
      // application code — see that migration's header.
      allowance_requests: {
        Row: {
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_note: string | null;
          id: string;
          reason: string | null;
          requested_usd: number;
          status: AllowanceRequestStatus;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          id?: string;
          reason?: string | null;
          requested_usd: number;
          status?: AllowanceRequestStatus;
          user_id: string;
        };
        Update: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          id?: string;
          reason?: string | null;
          requested_usd?: number;
          status?: AllowanceRequestStatus;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "allowance_requests_decided_by_fkey";
            columns: ["decided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "allowance_requests_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      assets: {
        Row: {
          bytes: number | null;
          // For kind='final' only: the projects.cut_order_updated_at value
          // read alongside the clips this asset was built from (worker's
          // SceneClipsForProject), not a live value. Null for every kind
          // other than 'final' and for any final predating
          // 0042_final_built_from_cut_order.sql. See that migration for why
          // getCutStatus (actions/deliver.ts) compares against this instead
          // of created_at.
          built_from_cut_order_at: string | null;
          created_at: string;
          deleted_at: string | null;
          duration_s: number | null;
          id: string;
          kind: AssetKind;
          // Ordinal within (project_id, kind); position 0 is primary.
          // Enforced (unique per project) for kind='product_ref' only — see
          // 0023_asset_position.sql — and an inert, unenforced default 0 for
          // every other kind.
          position: number;
          // NULLABLE since 0085_personal_image_generator.sql: an asset owned
          // directly by an account (user_id below) has no project. Every
          // project-backed asset still carries it, and assets_owner_present_
          // check makes "neither" impossible at the database.
          project_id: string | null;
          scene_id: string | null;
          storage_key: string;
          // Added by 0085_personal_image_generator.sql. The account an asset
          // belongs to when it has no project — the project-less Image
          // Generator is the first writer. NULL for every project-backed
          // asset, which is still scoped through projects.user_id.
          user_id: string | null;
        };
        Insert: {
          bytes?: number | null;
          built_from_cut_order_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          duration_s?: number | null;
          id?: string;
          kind: AssetKind;
          position?: number;
          project_id?: string | null;
          scene_id?: string | null;
          storage_key: string;
          user_id?: string | null;
        };
        Update: {
          bytes?: number | null;
          built_from_cut_order_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          duration_s?: number | null;
          id?: string;
          kind?: AssetKind;
          position?: number;
          project_id?: string | null;
          scene_id?: string | null;
          storage_key?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "assets_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assets_scene_id_fkey";
            columns: ["scene_id"];
            isOneToOne: false;
            referencedRelation: "scenes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assets_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      characters: {
        Row: {
          created_at: string;
          created_by: string;
          description: string | null;
          id: string;
          name: string;
          storage_key: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by: string;
          description?: string | null;
          id?: string;
          name: string;
          storage_key: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          name?: string;
          storage_key?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "characters_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      // An operator's own reusable @tag library (character/product/voice) —
      // 0065_elements.sql. Owner-only, unlike `characters` above (everyone
      // reads, admin writes) — see that migration's header for the
      // contrast. asset_id is a POINTER into an already-existing `assets`
      // row (on delete cascade), not a copy the way characters.storage_key
      // is.
      elements: {
        Row: {
          deleted_at: string | null;
          deleted_by: string | null;
          is_shared: boolean;
          asset_id: string;
          category: ElementCategory;
          created_at: string;
          description: string | null;
          ai_description: string | null;
          ai_description_asset_id: string | null;
          id: string;
          name: string;
          user_id: string;
        };
        Insert: {
          deleted_at?: string | null;
          deleted_by?: string | null;
          is_shared?: boolean;
          asset_id: string;
          category: ElementCategory;
          created_at?: string;
          description?: string | null;
          ai_description?: string | null;
          ai_description_asset_id?: string | null;
          id?: string;
          name: string;
          user_id: string;
        };
        Update: {
          deleted_at?: string | null;
          deleted_by?: string | null;
          is_shared?: boolean;
          asset_id?: string;
          category?: ElementCategory;
          created_at?: string;
          description?: string | null;
          ai_description?: string | null;
          ai_description_asset_id?: string | null;
          id?: string;
          name?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "elements_asset_id_fkey";
            columns: ["asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "elements_deleted_by_fkey";
            columns: ["deleted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "elements_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          // Storage key (media bucket, avatars/{user_id}/{uuid}.{ext}) of
          // this account's avatar, or null if none has been uploaded — see
          // 0034_profile_avatar.sql. A bare key, resolved through
          // lib/storage.ts's signedUrl() at display time like every other
          // asset in this schema, never a URL stored directly.
          avatar_storage_key: string | null;
          created_at: string;
          // Per-account overrides for lib/spend.ts's two caps — NULL (the
          // default for every account) means "use this account's role
          // default"; resolveAccountCaps() is the one place that fallback
          // is resolved. Added by 0031_account_allowances.sql.
          daily_cap_override_usd: number | null;
          hourly_cap_override_usd: number | null;
          email: string;
          id: string;
          role: ProfileRole;
          // Admin approval state — 0052_account_approval.sql. Required on
          // Row (the column is NOT NULL) but optional on Insert: the
          // default is 'pending', and nothing in this app inserts a
          // profiles row anyway — handle_new_user() does, from a trigger
          // Postgres fires on auth.users.
          status: ProfileStatus;
          username: string;
          weekly_cap_override_usd: number | null;
        };
        Insert: {
          avatar_storage_key?: string | null;
          created_at?: string;
          daily_cap_override_usd?: number | null;
          hourly_cap_override_usd?: number | null;
          email: string;
          id: string;
          role?: ProfileRole;
          status?: ProfileStatus;
          username: string;
          weekly_cap_override_usd?: number | null;
        };
        Update: {
          avatar_storage_key?: string | null;
          created_at?: string;
          daily_cap_override_usd?: number | null;
          hourly_cap_override_usd?: number | null;
          email?: string;
          id?: string;
          role?: ProfileRole;
          status?: ProfileStatus;
          username?: string;
          weekly_cap_override_usd?: number | null;
        };
        Relationships: [];
      };
      /**
       * One assembled cut of the whole project — a RECIPE first and a file
       * second (0060_final_versions.sql). The recipe (scene order plus the
       * scene_version each scene contributed) is what explains the difference
       * between two cuts and is cheap enough to keep forever; the 10-30MB mp4
       * is not, so a version whose file has been pruned is still a complete,
       * rebuildable record.
       *
       * built_at is also the work queue: null means "not built yet, this row
       * IS the request", which is what replaced the old "delete the final
       * asset so the worker notices it is missing" trigger.
       *
       * Hand-patched rather than generated, like scene_versions below:
       * `make types` runs `supabase gen types typescript --local`, which needs
       * the local stack running.
       */
      final_versions: {
        Row: {
          // Ordered [{ scene_id, scene_version_id }] in cut order.
          // scene_version_id is null for a scene whose active version predates
          // 0058's backfill — "version unknown" is truer than a guess. Typed
          // `unknown`, not `Json`, for the same reason projects.render_settings
          // is (see the file header).
          recipe: unknown;
          created_at: string;
          // Null in two DIFFERENT situations that built_at tells apart: not
          // built yet (built_at null), or built and then pruned (built_at set).
          final_asset_id: string | null;
          poster_asset_id: string | null;
          // Set when the worker gives up, so a failed assemble does not read as
          // a pending one that spins forever.
          failed_at: string | null;
          failure_reason: string | null;
          built_at: string | null;
          id: string;
          // Per-project 1, 2, 3 — the "v2" an operator reads, not a global
          // counter. Assigned by the final_versions_assign_n trigger, NOT by
          // the caller: `select max(n) + 1` from two requests a millisecond
          // apart is a race with `unique (project_id, n)` at the end of it.
          // Nullable in the schema so the trigger can fill it; never null on a
          // row that has actually been inserted.
          n: number | null;
          // The worker's lease on this row. Set while an assemble is running,
          // so a build in progress is not claimed twice — a row lock only
          // lives as long as the claiming transaction, and an assemble runs
          // for minutes outside one.
          claimed_at: string | null;
          // Which MODE asked for this build (0069). A worker claims only rows
          // matching its own, so a dev worker cannot assemble a production
          // project's final video — the assemble-side half of scenes.dev.
          dev: boolean;
          project_id: string;
        };
        Insert: {
          recipe?: unknown;
          dev?: boolean;
          created_at?: string;
          final_asset_id?: string | null;
          poster_asset_id?: string | null;
          failed_at?: string | null;
          failure_reason?: string | null;
          built_at?: string | null;
          claimed_at?: string | null;
          id?: string;
          // Omit it — the trigger assigns it. Passing one is how two
          // concurrent assembles collide on the unique constraint.
          n?: number | null;
          project_id: string;
        };
        Update: {
          recipe?: unknown;
          dev?: boolean;
          created_at?: string;
          final_asset_id?: string | null;
          poster_asset_id?: string | null;
          failed_at?: string | null;
          failure_reason?: string | null;
          built_at?: string | null;
          claimed_at?: string | null;
          id?: string;
          n?: number | null;
          project_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "final_versions_final_asset_id_fkey";
            columns: ["final_asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "final_versions_poster_asset_id_fkey";
            columns: ["poster_asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "final_versions_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      projects: {
        Row: {
          camera_movement: boolean;
          // Per-project caption settings (0049_project_caption_style.sql). All three are NOT NULL
          // with defaults reproducing what internal/captions hardcoded before they existed, so an
          // untouched project renders exactly as it did. captions_enabled is ANDed with the
          // worker's CAPTIONS_ENABLED env var — it can only opt a project OUT from under a
          // workspace that has captions on, never turn them on for one that has them off.
          // Both colours are '#RRGGBB'; the reversed ASS byte order lives only in
          // worker/internal/captions/color.go, never in this column.
          caption_box_color: string;
          caption_text_color: string;
          captions_enabled: boolean;
          character_desc: string | null;
          // When character_desc last actually CHANGED value (not merely saved) — see
          // 0057_description_edit_tracking.sql. Null means never edited.
          character_desc_edited_at: string | null;
          created_at: string;
          // 0060_final_versions.sql — the final_versions row the Deliver page shows and the
          // archive route downloads. Distinct from "the newest": an operator may assemble a v3
          // and decide v2 was better. Null before the first assemble.
          active_final_version_id: string | null;
          // When scenes.idx was last rewritten by reorderScenes (web/actions/brief.ts). Null
          // means never reordered. See 0039_cut_order.sql / actions/deliver.ts's staleness read.
          cut_order_updated_at: string | null;
          id: string;
          // Spec §3.3's "Include Visual Idea" checkbox — the operator's
          // master switch for whether the compiler expands scenes.visual_idea
          // into video_prompt. Default true — see 0024_include_visual_idea_and_scene_visual_idea.sql.
          include_visual_idea: boolean;
          kind: ProjectKind;
          // 0117: the one hidden clip project /create queues into. See the migration.
          is_personal: boolean;
          // Free-text description of what the product looks like — form/material, colour, label
          // treatment. The compiler never sees a reference image; see 0041_product_appearance.sql.
          product_appearance: string | null;
          // product_appearance's twin of character_desc_edited_at above. See
          // 0057_description_edit_tracking.sql.
          product_appearance_edited_at: string | null;
          product_name: string | null;
          pronunciation_guide: string | null;
          render_settings: unknown;
          script_raw: string | null;
          shooting_mode: ShootingMode;
          source_character_id: string | null;
          status: ProjectStatus;
          title: string;
          ugc_style: UgcStyle;
          updated_at: string;
          user_id: string;
          visual_idea: string | null;
          voice_profile: string | null;
        };
        Insert: {
          camera_movement?: boolean;
          caption_box_color?: string;
          caption_text_color?: string;
          captions_enabled?: boolean;
          character_desc?: string | null;
          character_desc_edited_at?: string | null;
          created_at?: string;
          active_final_version_id?: string | null;
          cut_order_updated_at?: string | null;
          id?: string;
          include_visual_idea?: boolean;
          kind?: ProjectKind;
          is_personal?: boolean;
          product_appearance?: string | null;
          product_appearance_edited_at?: string | null;
          product_name?: string | null;
          pronunciation_guide?: string | null;
          render_settings?: unknown;
          script_raw?: string | null;
          shooting_mode?: ShootingMode;
          source_character_id?: string | null;
          status?: ProjectStatus;
          title: string;
          ugc_style?: UgcStyle;
          updated_at?: string;
          user_id: string;
          visual_idea?: string | null;
          voice_profile?: string | null;
        };
        Update: {
          camera_movement?: boolean;
          caption_box_color?: string;
          caption_text_color?: string;
          captions_enabled?: boolean;
          character_desc?: string | null;
          character_desc_edited_at?: string | null;
          created_at?: string;
          active_final_version_id?: string | null;
          cut_order_updated_at?: string | null;
          id?: string;
          include_visual_idea?: boolean;
          kind?: ProjectKind;
          is_personal?: boolean;
          product_appearance?: string | null;
          product_appearance_edited_at?: string | null;
          product_name?: string | null;
          pronunciation_guide?: string | null;
          render_settings?: unknown;
          script_raw?: string | null;
          shooting_mode?: ShootingMode;
          source_character_id?: string | null;
          status?: ProjectStatus;
          title?: string;
          ugc_style?: UgcStyle;
          updated_at?: string;
          user_id?: string;
          visual_idea?: string | null;
          voice_profile?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "projects_active_final_version_id_fkey";
            columns: ["active_final_version_id"];
            isOneToOne: false;
            referencedRelation: "final_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_source_character_id_fkey";
            columns: ["source_character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      prompt_templates: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          name: string;
          version: number;
        };
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          name: string;
          version: number;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          name?: string;
          version?: number;
        };
        Relationships: [];
      };
      runs: {
        Row: {
          // Added by 0095_image_attempt_recovery.sql. The image this attempt
          // produced, so a generation the operator navigated away from can be
          // found again and shown. NULL until the attempt succeeds. ON DELETE
          // SET NULL — deleting the picture must not delete what it cost.
          asset_id: string | null;
          cost_usd: number | null;
          created_at: string;
          error: string | null;
          kie_task_id: string | null;
          // Added by 0116_image_prompt.sql. The prompt as typed, @tags intact;
          // NULL for video runs and every image made before 0116.
          prompt: string | null;
          id: string;
          // Added by 0083_image_generator.sql. Client-generated, one per
          // Generate press, unique per project — a retried POST or a second
          // tab resolves to the existing attempt instead of charging twice.
          // NULL for every writer that predates 0083 and every path that is
          // not the Image Generator.
          idempotency_key: string | null;
          inference_ms: number | null;
          latency_ms: number | null;
          model: string;
          // Added by 0030_runs_project_id.sql (applied). Nullable at the DB level for one real
          // case — a Character Library entry has no project
          // (web/actions/character-library.ts's
          // createCharacterFromDescription) — but every other writer
          // (worker/internal/store/store.go's MarkDone/MarkFailed, and
          // every other web-side paid call site added alongside this
          // column) always sets it, and it's what lets a scene-less run
          // (character/composite image generation, a compile) still be
          // attributed to a project and its owner for spend caps and
          // /spend — see 0030_runs_project_id.sql's header for the full
          // "why," including what stays uncounted for the one nullable
          // case.
          project_id: string | null;
          scene_id: string | null;
          // Added by 0083_image_generator.sql. NULL means the attempt is still
          // in flight and its cost_usd is an ESTIMATE that already counts
          // against every cap — conservative by construction, so a crash
          // over-reports rather than losing a charge. 0083 backfilled every
          // pre-existing row to created_at, so history is never swept.
          settled_at: string | null;
          // Added by 0085_personal_image_generator.sql. Who this attempt is
          // billed to when there is no project to attribute through. Every
          // per-user spend read resolves the owner as coalesce(runs.user_id,
          // projects.user_id), so NULL falls back to the project owner
          // exactly as before 0085 — which is why nothing was backfilled.
          user_id: string | null;
          vendor: string;
        };
        Insert: {
          asset_id?: string | null;
          cost_usd?: number | null;
          created_at?: string;
          error?: string | null;
          kie_task_id?: string | null;
          prompt?: string | null;
          id?: string;
          idempotency_key?: string | null;
          inference_ms?: number | null;
          latency_ms?: number | null;
          model: string;
          project_id?: string | null;
          scene_id?: string | null;
          settled_at?: string | null;
          user_id?: string | null;
          vendor: string;
        };
        Update: {
          asset_id?: string | null;
          cost_usd?: number | null;
          created_at?: string;
          error?: string | null;
          kie_task_id?: string | null;
          prompt?: string | null;
          id?: string;
          idempotency_key?: string | null;
          inference_ms?: number | null;
          latency_ms?: number | null;
          model?: string;
          project_id?: string | null;
          scene_id?: string | null;
          settled_at?: string | null;
          user_id?: string | null;
          vendor?: string;
        };
        Relationships: [
          {
            foreignKeyName: "runs_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "runs_scene_id_fkey";
            columns: ["scene_id"];
            isOneToOne: false;
            referencedRelation: "scenes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "runs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      /**
       * One attempt at a scene — the prompt, the frame generated from it, and
       * the clip rendered from that frame, kept together. A new row per
       * RENDER (0058_scene_versions.sql): the three are only meaningful as a
       * set, so switching versions switches all three at once.
       */
      scene_references: {
        Row: {
          asset_id: string;
          category: string | null;
          created_at: string;
          description: string | null;
          id: string;
          kind: string;
          ordinal: number;
          scene_id: string;
          tag: string | null;
        };
        Insert: {
          asset_id: string;
          category?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          kind: string;
          ordinal: number;
          scene_id: string;
          tag?: string | null;
        };
        Update: {
          asset_id?: string;
          category?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          kind?: string;
          ordinal?: number;
          scene_id?: string;
          tag?: string | null;
        };
        Relationships: [];
      };
      scene_versions: {
        Row: {
          clip_asset_id: string | null;
          created_at: string;
          // 0059_scene_version_render_settings.sql — a SNAPSHOT of the
          // EFFECTIVE settings (projects.render_settings merged with
          // scenes.render_settings_override) at the moment this version was
          // opened, and the scene's length at that moment. Never a live read:
          // both scene columns are overwritten in place, so this is the only
          // record of what the clip was actually rendered with. Null on
          // versions backfilled by 0058, which predate these columns — the UI
          // must say "not recorded" rather than substitute today's answer.
          // render_settings is typed `unknown`, not `Json`, for the same
          // reason as projects.render_settings (see the file header).
          // Hand-patched rather than generated: `make types` runs
          // `supabase gen types typescript --local`, which needs the local
          // stack running.
          duration_s: number | null;
          id: string;
          n: number;
          ref_frame_asset_id: string | null;
          render_settings: unknown;
          scene_id: string;
          video_prompt: string | null;
        };
        Insert: {
          clip_asset_id?: string | null;
          created_at?: string;
          duration_s?: number | null;
          id?: string;
          n: number;
          ref_frame_asset_id?: string | null;
          render_settings?: unknown;
          scene_id: string;
          video_prompt?: string | null;
        };
        Update: {
          clip_asset_id?: string | null;
          created_at?: string;
          duration_s?: number | null;
          id?: string;
          n?: number;
          ref_frame_asset_id?: string | null;
          render_settings?: unknown;
          scene_id?: string;
          video_prompt?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "scene_versions_clip_asset_id_fkey";
            columns: ["clip_asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "scene_versions_ref_frame_asset_id_fkey";
            columns: ["ref_frame_asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "scene_versions_scene_id_fkey";
            columns: ["scene_id"];
            isOneToOne: false;
            referencedRelation: "scenes";
            referencedColumns: ["id"];
          },
        ];
      };
      scenes: {
        Row: {
          // 0058_scene_versions.sql — which scene_versions row this scene
          // currently shows and delivers. Null for a scene created before 0058
          // that has never rendered since.
          active_version_id: string | null;
          created_at: string;
          // Which MODE queued this scene — 0063_scenes_dev_flag.sql. false
          // (the default, and every pre-existing row) for MODE=production,
          // true for MODE=development. ClaimQueuedScenes/CountRendering
          // (worker/internal/store/store.go) filter on this so a dev
          // worker and a production worker polling the same table never
          // claim or bill for each other's rows — see that migration's
          // header for the incident this closes.
          dev: boolean;
          duration_s: number;
          edited_by_human: boolean;
          kie_task_id: string | null;
          id: string;
          idx: number;
          is_talking_head: boolean;
          project_id: string;
          ref_frame_asset_id: string | null;
          // PARTIAL per-scene render settings — typically just {"model": ...} — written by a
          // retry re-rendering this scene on a different model than the project's. The effective
          // settings are projects.render_settings || coalesce(this, '{}'), merged by
          // mergeRenderSettings (lib/models.ts) on the web side and in SQL on the worker's.
          // Null (and `unknown` covers null, same as projects.render_settings) means "no
          // override". Typed `unknown`, not `Json`, for the reason the file header gives.
          // Sticky — nothing clears it, not even a successful render. See
          // 0045_scene_render_settings_override.sql. Hand-patched rather than generated (same as the entries this file
          // already notes). The migration IS applied as of 2026-08-22 — remote
          // is at 0048 — so this entry now matches the live schema; it simply
          // has not been regenerated via `make types`.
          render_settings_override: unknown;
          script_line: string | null;
          status: SceneStatus;
          submitted_at: string | null;
          template_id: string | null;
          video_prompt: string | null;
          ai_generated_prompt: string | null;
          // Claude's own record of which operator-authored visual idea (if
          // any) shaped this scene's video_prompt, written once at compile
          // time and carried forward unchanged by Apply/Split thereafter —
          // NOT re-derived from the model's echo on a re-generate. See
          // 0024_include_visual_idea_and_scene_visual_idea.sql.
          visual_idea: string | null;
        };
        Insert: {
          active_version_id?: string | null;
          created_at?: string;
          dev?: boolean;
          duration_s?: number;
          edited_by_human?: boolean;
          kie_task_id?: string | null;
          id?: string;
          idx: number;
          is_talking_head?: boolean;
          project_id: string;
          ref_frame_asset_id?: string | null;
          // See the Row comment above / 0045_scene_render_settings_override.sql.
          render_settings_override?: unknown;
          script_line?: string | null;
          status?: SceneStatus;
          submitted_at?: string | null;
          template_id?: string | null;
          video_prompt?: string | null;
          ai_generated_prompt?: string | null;
          visual_idea?: string | null;
        };
        Update: {
          active_version_id?: string | null;
          created_at?: string;
          dev?: boolean;
          duration_s?: number;
          edited_by_human?: boolean;
          kie_task_id?: string | null;
          id?: string;
          idx?: number;
          is_talking_head?: boolean;
          project_id?: string;
          ref_frame_asset_id?: string | null;
          // See the Row comment above / 0045_scene_render_settings_override.sql.
          render_settings_override?: unknown;
          script_line?: string | null;
          status?: SceneStatus;
          submitted_at?: string | null;
          template_id?: string | null;
          video_prompt?: string | null;
          ai_generated_prompt?: string | null;
          visual_idea?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "scenes_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "scenes_ref_frame_asset_id_fkey";
            columns: ["ref_frame_asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "scenes_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "prompt_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      // 0088_deleted_scenes.sql — a scene and its assets/scene_versions/
      // scene_references, rescued one step ahead of ON DELETE CASCADE by a
      // BEFORE DELETE trigger on scenes, so a later restore has something to
      // restore from. Deliberately has NO foreign keys (Relationships: []) —
      // see that migration's own comment on deleted_scenes for why an FK here
      // would either reject the insert or cascade-wipe the archive the
      // instant it was written. Hand-patched, like every entry this file
      // already notes above `make types` needing the local stack running.
      deleted_scenes: {
        Row: {
          // PRIMARY KEY. What makes archiving idempotent — see the
          // migration's header on ON CONFLICT (scene_id) DO NOTHING.
          scene_id: string;
          // Expected to dangle once the delete this row survived commits —
          // there is no FK, by design (see above).
          project_id: string | null;
          // Owner snapshot from projects.user_id at archive time, NOT a live
          // join — read by deleted_scenes_select's RLS policy below. NULL
          // when this scene was archived by its own PROJECT's cascade delete
          // rather than a standalone scene delete (the projects row is
          // already gone by the time the trigger can read it) — see the
          // migration's own comment on archive_deleted_scene() for the one
          // path this happens on.
          user_id: string | null;
          // scenes.idx at the moment of deletion. Display only — a restore
          // does NOT reuse it, since scenes still enforces
          // unique (project_id, idx) and a live scene may already occupy it.
          scene_idx: number | null;
          deleted_at: string;
          // to_jsonb(OLD) of the deleted scenes row, whole. `unknown`, not
          // `Json`, for the same reason projects.render_settings is (see the
          // file header): this is read back as a named row shape
          // (Database["public"]["Tables"]["scenes"]["Row"]) by the one
          // reader that exists (actions/ugc.ts's restoreScene), and `Json`'s
          // index signature would force a cast there anyway.
          scene: unknown;
          // jsonb_agg(to_jsonb(...)) of this scene's assets/scene_versions/
          // scene_references rows, coalesced to '[]' when a scene had none.
          // Same `unknown` reasoning as `scene` above.
          assets: unknown;
          versions: unknown;
          refs: unknown;
          // 0092_deleted_scene_versions.sql. Set by purgeDeletedScene
          // (actions/ugc.ts) to mark this bin entry forgotten — never a
          // delete of the row itself, and never touches the live scenes
          // table or Storage. Null means still sitting in the bin.
          hard_deleted_at: string | null;
          hard_deleted_by: string | null;
        };
        Insert: {
          scene_id: string;
          project_id?: string | null;
          user_id?: string | null;
          scene_idx?: number | null;
          deleted_at?: string;
          scene: unknown;
          assets?: unknown;
          versions?: unknown;
          refs?: unknown;
          hard_deleted_at?: string | null;
          hard_deleted_by?: string | null;
        };
        Update: {
          scene_id?: string;
          project_id?: string | null;
          user_id?: string | null;
          scene_idx?: number | null;
          deleted_at?: string;
          scene?: unknown;
          assets?: unknown;
          versions?: unknown;
          refs?: unknown;
          hard_deleted_at?: string | null;
          hard_deleted_by?: string | null;
        };
        Relationships: [];
      };
      // 0092_deleted_scene_versions.sql — one scene_versions row, rescued
      // from a STANDALONE delete (never a scene's own cascade — that case
      // is already covered by deleted_scenes.versions above, and archiving
      // it a second time here would double-store it) by a BEFORE DELETE
      // trigger on scene_versions, so restoreClipVersion has something to
      // restore from. No foreign keys, same reasoning as deleted_scenes.
      deleted_scene_versions: {
        Row: {
          // PRIMARY KEY — what makes archiving idempotent (ON CONFLICT
          // (version_id) DO NOTHING).
          version_id: string;
          // Expected to dangle once the delete this row survived commits —
          // there is no FK, by design.
          scene_id: string | null;
          project_id: string | null;
          // Owner snapshot from projects.user_id by way of scenes, at
          // archive time — read by deleted_scene_versions_select's RLS
          // policy below, not a live join.
          user_id: string | null;
          // scene_versions.n at the moment of deletion — the "v3" an
          // operator would recognize. Display only; a restore does not
          // reuse it.
          n: number | null;
          deleted_at: string;
          // Set by purgeDeletedVersion (actions/ugc.ts) to mark this bin
          // entry forgotten — never a delete of the row itself, and never
          // touches the live scene_versions table or Storage. Null means
          // still sitting in the bin.
          hard_deleted_at: string | null;
          hard_deleted_by: string | null;
          // to_jsonb(OLD) of the deleted scene_versions row, whole.
          // `unknown`, not `Json`, for the same reason deleted_scenes.scene
          // is above.
          version: unknown;
          // The version's clip asset row (assets, by clip_asset_id),
          // snapshotted at delete time. Null when the version never had a
          // clip.
          clip_asset: unknown;
        };
        Insert: {
          version_id: string;
          scene_id?: string | null;
          project_id?: string | null;
          user_id?: string | null;
          n?: number | null;
          deleted_at?: string;
          hard_deleted_at?: string | null;
          hard_deleted_by?: string | null;
          version: unknown;
          clip_asset?: unknown;
        };
        Update: {
          version_id?: string;
          scene_id?: string | null;
          project_id?: string | null;
          user_id?: string | null;
          n?: number | null;
          deleted_at?: string;
          hard_deleted_at?: string | null;
          hard_deleted_by?: string | null;
          version?: unknown;
          clip_asset?: unknown;
        };
        Relationships: [];
      };
      deleted_project_cost_history: {
        Row: {
          run_id: string;
          scene_id: string | null;
          project_id: string | null;
          user_id: string | null;
          vendor: string | null;
          model: string | null;
          kie_task_id: string | null;
          cost_usd: number | null;
          latency_ms: number | null;
          error: string | null;
          run_created_at: string | null;
          project_title: string | null;
          owner_email: string | null;
          deleted_at: string;
        };
        Insert: {
          run_id: string;
          scene_id?: string | null;
          project_id?: string | null;
          user_id?: string | null;
          vendor?: string | null;
          model?: string | null;
          kie_task_id?: string | null;
          cost_usd?: number | null;
          latency_ms?: number | null;
          error?: string | null;
          run_created_at?: string | null;
          project_title?: string | null;
          owner_email?: string | null;
          deleted_at?: string;
        };
        Update: {
          run_id?: string;
          scene_id?: string | null;
          project_id?: string | null;
          user_id?: string | null;
          vendor?: string | null;
          model?: string | null;
          kie_task_id?: string | null;
          cost_usd?: number | null;
          latency_ms?: number | null;
          error?: string | null;
          run_created_at?: string | null;
          project_title?: string | null;
          owner_email?: string | null;
          deleted_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      // Per-project sum of runs.cost_usd, computed in SQL (SUM/GROUP BY)
      // instead of embedding every run app-side — see
      // 0026_cost_aggregates.sql. security_invoker view: a project with no
      // runs has no row here at all (inner join), not a $0 row.
      project_cost_totals: {
        Row: {
          project_id: string;
          total_cost_usd: number;
        };
        Relationships: [];
      };
      // Per-user count of projects, computed in SQL instead of one count()
      // round trip per row on the /users admin list — see
      // 0027_user_project_counts.sql. security_invoker view: a user with no
      // projects has no row here at all (plain GROUP BY, not a LEFT JOIN),
      // not a 0 row.
      user_project_counts: {
        Row: {
          user_id: string;
          project_count: number;
        };
        Relationships: [];
      };
      // profiles LEFT JOINed to per-user project counts and all-time spend —
      // see 0028_user_directory.sql. Backs /users' sortable table: ordering
      // by project_count or spend_usd needs both aggregates in the SAME
      // relation as the ORDER BY + LIMIT/OFFSET, not fetched after the page
      // of profiles is already decided (that would only reorder the 20 rows
      // already on screen — see the migration's header). security_invoker
      // view, same as project_cost_totals/user_project_counts above.
      //
      // LEFT JOIN + COALESCE(...,0), NOT the sibling views' "absence means
      // zero, no row" contract: a user with zero projects and zero spend
      // MUST still be a row here (with 0s), or sorting by either aggregate
      // would silently drop exactly the users an admin most wants to find.
      // Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      user_directory: {
        Row: {
          id: string;
          email: string;
          username: string;
          role: ProfileRole;
          created_at: string;
          project_count: number;
          spend_usd: number;
          // Last, not next to `role`, because that is where
          // 0052_account_approval.sql had to append it: CREATE OR REPLACE
          // VIEW may only add columns at the end of the select list.
          status: ProfileStatus;
        };
        Relationships: [];
      };
      // projects LEFT JOINed to owner email, per-project scene count and
      // all-time cost — see 0029_project_directory.sql. Backs /projects'
      // sortable table the same way user_directory backs /users': ordering
      // by scene_count or total_cost_usd needs both aggregates in the SAME
      // relation as the ORDER BY + LIMIT/OFFSET, not fetched after the page
      // of projects is already decided. security_invoker view, same as
      // project_cost_totals/user_project_counts/user_directory above.
      //
      // LEFT JOIN + COALESCE(...,0) for scene_count/total_cost_usd, NOT the
      // sibling project_cost_totals view's "absence means zero, no row"
      // contract: a project with zero scenes and zero spend MUST still be a
      // row here (with 0s), or sorting by either aggregate would silently
      // drop exactly the rows an admin most wants to find. `status` is the
      // RAW projects.status fossil column, passed through unchanged — NOT
      // a SQL re-derivation of lib/project-status.ts's deriveProjectStatus
      // — see the migration's header for why /projects does not offer a
      // Status sort control. `owner_email` is a plain (non-COALESCEd) LEFT
      // JOIN, same as user_directory's own profiles join. `kind` is
      // 0067_project_directory_kind.sql's addition — appended last because
      // `create or replace view` cannot reorder existing columns — and is
      // what /projects' title link branches on (0064_project_kind.sql).
      // Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      project_directory: {
        Row: {
          id: string;
          title: string;
          product_name: string | null;
          status: ProjectStatus;
          created_at: string;
          user_id: string;
          owner_email: string | null;
          scene_count: number;
          total_cost_usd: number;
          kind: ProjectKind;
          // 0103_project_directory_updated_at.sql appends this after the
          // pre-existing view columns. It is the project's own update time,
          // not a scene-render completion time.
          updated_at: string;
          // 0117: hidden personal clip project; /projects filters these out.
          is_personal: boolean;
        };
        Relationships: [];
      };
      // Per-account spend for the current Asia/Manila day and calendar week,
      // computed live in SQL — see 0031_account_allowances.sql. Backs
      // /users' allowance-vs-usage columns. Deliberately carries NO cap
      // figures — /users resolves those via lib/spend.ts's
      // resolveAccountCaps(profile), not this view. security_invoker view,
      // same as every other view above.
      account_spend_windows: {
        Row: {
          user_id: string;
          spent_today_usd: number;
          spent_this_week_usd: number;
        };
        Relationships: [];
      };
      // allowance_requests LEFT JOINed to the requester's and (if decided)
      // deciding admin's profile columns — /allowances' sortable, searchable
      // admin queue. See 0032_allowance_requests.sql for the security_invoker
      // caveat: decided_by_email is only populated for an admin caller.
      allowance_request_directory: {
        Row: {
          id: string;
          user_id: string;
          user_email: string;
          user_username: string;
          requested_usd: number;
          reason: string | null;
          status: AllowanceRequestStatus;
          decided_by: string | null;
          decided_by_email: string | null;
          decided_at: string | null;
          decision_note: string | null;
          created_at: string;
        };
        Relationships: [];
      };
    };
    Functions: {
      is_admin: { Args: never; Returns: boolean };
      can_access_chat_conversation: {
        Args: { target_conversation_id: string };
        Returns: boolean;
      };
      chat_people: {
        Args: never;
        Returns: {
          user_id: string;
          username: string;
          avatar_storage_key: string | null;
          conversation_id: string | null;
          last_message_body: string | null;
          last_message_at: string | null;
          last_message_sender_id: string | null;
          unread_count: number;
          is_admin: boolean;
        }[];
      };
      send_direct_chat_message: {
        Args: { p_recipient_id: string; p_body: string };
        Returns: {
          id: string;
          conversation_id: string;
          sender_id: string;
          sender_name: string;
          body: string;
          created_at: string;
        }[];
      };
      mark_direct_chat_read: {
        Args: { p_conversation_id: string };
        Returns: undefined;
      };
      direct_chat_unread_count: {
        Args: never;
        Returns: number;
      };
      // Atomically marks the caller's unread inbox rows read. Null means all
      // of their unread rows; a supplied list is still scoped to auth.uid().
      mark_notifications_read: {
        Args: { notification_ids?: string[] | null };
        Returns: number;
      };
      manage_personal_image: {
        Args: { p_asset_id: string; p_operation: string };
        Returns: string | null;
      };
      task_eligible_assignees: {
        Args: never;
        Returns: { id: string; username: string; email: string }[];
      };
      my_task_assignments: {
        Args: never;
        Returns: {
          assignment_id: string;
          task_id: string;
          title: string;
          brief: string;
          due_at: string | null;
          priority: TaskPriority;
          created_by: string;
          created_at: string;
          status: TaskAssignmentStatus;
          started_at: string | null;
          cancelled_at: string | null;
        }[];
      };
      managed_tasks: {
        Args: never;
        Returns: {
          task_id: string;
          title: string;
          brief: string;
          due_at: string | null;
          priority: TaskPriority;
          audience: TaskAudience;
          created_at: string;
          cancelled_at: string | null;
          total_count: number;
          assigned_count: number;
          in_progress_count: number;
          cancelled_count: number;
        }[];
      };
      task_assignment_directory: {
        Args: { p_task_id: string };
        Returns: {
          assignment_id: string;
          task_id: string;
          assignee_id: string;
          assignee_username: string;
          assignee_email: string;
          status: TaskAssignmentStatus;
          started_at: string | null;
          cancelled_at: string | null;
        }[];
      };
      create_task: {
        Args: {
          p_title: string;
          p_brief: string;
          p_deliverable_description: string;
          p_due_at: string | null;
          p_priority: TaskPriority;
          p_audience: TaskAudience;
          p_assignee_ids: string[];
          p_request_key: string;
        };
        Returns: { task_id: string }[];
      };
      start_task_assignment: {
        Args: { p_assignment_id: string };
        Returns: undefined;
      };
      complete_task_assignment: {
        Args: { p_assignment_id: string };
        Returns: undefined;
      };
      reopen_task_assignment: {
        Args: { p_assignment_id: string };
        Returns: undefined;
      };
      submit_task_assignment: {
        Args: { p_assignment_id: string; p_deliverable_url: string; p_note: string | null };
        Returns: undefined;
      };
      review_task_submission: {
        Args: {
          p_assignment_id: string;
          p_revision: number;
          p_decision: TaskSubmissionDecision;
          p_feedback: string | null;
        };
        Returns: undefined;
      };
      cancel_task: {
        Args: { p_task_id: string };
        Returns: undefined;
      };
      // Sum of amount_usd for one user's unexpired allowance_grants as of
      // at_ts — see 0032_allowance_requests.sql. Backs lib/spend.ts's
      // getActiveGrantsUsd / getEffectiveWeeklyCapUsd.
      user_active_grants_usd: {
        Args: { target_user_id: string; at_ts: string };
        Returns: number;
      };
      // Batched twin of user_active_grants_usd — sum(amount_usd)/count(*) of
      // unexpired allowance_grants, grouped by user_id, for a whole page of
      // ids at once. Added by 0033_allowance_requests_rls_fix.sql to replace
      // /users' unbounded fetch-and-reduce (silently truncated past
      // PostgREST's max_rows = 1000). Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      user_active_grants_usd_by_user: {
        Args: { target_user_ids: string[]; at_ts: string };
        Returns: {
          user_id: string;
          total_usd: number;
          grant_count: number;
          approver_grant_count: number;
          latest_transfer_amount_usd: number | null;
        }[];
      };
      // Approves or denies an allowance_requests row, inserting the matching
      // allowance_grants row atomically on approval — see
      // 0032_allowance_requests.sql. Backs web/actions/allowance.ts's
      // decideAllowanceRequest.
      decide_allowance_request: {
        Args: {
          request_id: string;
          approve: boolean;
          grant_amount_usd: number;
          grant_expires_at: string;
          note: string | null;
        };
        Returns: {
          id: string;
          user_id: string;
          requested_usd: number;
          reason: string | null;
          status: AllowanceRequestStatus;
          decided_by: string | null;
          decided_at: string | null;
          decision_note: string | null;
          created_at: string;
        };
      };
      // Moves part of one editor's own weekly headroom to another as two
      // allowance_grants rows (+X to them, -X to the sender) in one
      // transaction — see 0087_pass_allowance.sql.
      //
      // SERVICE-ROLE ONLY (revoked from authenticated), which is what makes it
      // safe for the sender to be a parameter: the service-role session has no
      // auth.uid(), so web/actions/transfer.ts establishes the sender with
      // requireUser() and passes the id. Calling this through the session
      // client returns a permission error, not a pass.
      //
      // There is NO headroom argument and NO expiry argument, and both
      // absences are deliberate — the function computes the sender's spendable
      // allowance itself under a per-sender lock, and derives the expiry as the
      // next Asia/Manila Monday, which it returns. The only parameters left are
      // the two figures SQL cannot produce: the weekly base cap (a render.yaml
      // env var) and the in-flight render estimate (priced in lib/models.ts).
      pass_allowance: {
        Args: {
          p_from_user_id: string;
          p_to_user_id: string;
          p_amount_usd: number;
          p_weekly_base_cap_usd: number;
          p_held_usd: number;
          p_note: string | null;
        };
        /** The expiry it wrote: the next Asia/Manila Monday, as an ISO string. */
        Returns: string;
      };
      // Every account the caller may pass credits to: active editors and
      // trusted editors other than themselves — see 0087_pass_allowance.sql.
      // Empty for anyone who may not pass at all. Backs the recipient picker
      // in components/pass-credits-dialog.tsx, server-fetched.
      transfer_recipients: {
        Args: never;
        Returns: {
          id: string;
          username: string;
          email: string;
          role: ProfileRole;
        }[];
      };
      // Total cost_usd for runs created in [from_ts, to_ts) — see
      // 0026_cost_aggregates.sql. Backs /spend's Today/This month tiles.
      spend_total_usd: {
        Args: { from_ts: string; to_ts: string };
        Returns: number;
      };
      // Per-user cost_usd totals for runs created in [from_ts, to_ts),
      // grouped in SQL — see 0026_cost_aggregates.sql. Replaces /spend's old
      // in-memory reduce() over an unbounded (max_rows-capped) select.
      spend_totals_by_user: {
        Args: { from_ts: string; to_ts: string };
        Returns: {
          user_id: string;
          email: string | null;
          total_usd: number;
        }[];
      };
      // Total cost_usd for ONE user's runs created in [from_ts, to_ts) —
      // see 0031_account_allowances.sql for why spend_total_usd/
      // spend_totals_by_user don't fit this. Backs both of lib/spend.ts's
      // per-account windows (daily burst guard and weekly allowance).
      user_spend_usd: {
        Args: { target_user_id: string; from_ts: string; to_ts: string };
        Returns: number;
      };
      // Sum over non-admin accounts, for the current Manila calendar week,
      // of max(0, effective weekly allowance - spent this week) — see
      // 0035_outstanding_allowance.sql. Role-default weekly figures are
      // passed in as arguments since a SQL function has no access to
      // render.yaml env vars. Backs /allowances' summary tiles and the
      // approve dialog via web/lib/db-aggregates.ts's
      // getOutstandingAllowanceUsd. Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      outstanding_allowance_usd: {
        Args: { editor_weekly_default: number; trusted_weekly_default: number };
        Returns: number;
      };
      // Team-wide iterate-vs-render split for runs created in [from_ts,
      // to_ts) — see 0037_spend_category_totals.sql for the category rule.
      // Backs /spend's breakdown tile. Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      spend_category_totals: {
        Args: { from_ts: string; to_ts: string };
        Returns: { iterate_usd: number; render_usd: number; total_usd: number }[];
      };
      // Per-user iterate-vs-render split for runs created in [from_ts,
      // to_ts), grouped in SQL — see 0037_spend_category_totals.sql for why
      // this joins runs -> projects directly instead of reusing spend_
      // totals_by_user's scene join. Backs /spend's Per-user totals table.
      // Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      spend_category_totals_by_user: {
        Args: { from_ts: string; to_ts: string };
        Returns: {
          user_id: string;
          email: string | null;
          iterate_usd: number;
          render_usd: number;
          total_usd: number;
        }[];
      };
      // Checks the global, weekly and optional daily ceilings AND creates the
      // reservation in one transaction, under a global-then-owner advisory
      // lock -- see 0083_image_generator.sql for why this cannot be two app
      // round trips (it double-counts the reservation and refuses at half the
      // real headroom). Returns exactly one of reserved / duplicate / blocked;
      // only reserved writes a runs row. spent_usd is the spend measured
      // against the ceiling blocked_by names, and null otherwise.
      //
      // There is deliberately no owner argument: the owner is derived from the
      // locked project row, so a caller cannot name whose budget is spent.
      // service_role only -- an authenticated browser client cannot execute it.
      //
      // Callers must NOT also call assertWithinSpendCaps on this path. Hand-patched rather than
      // generated, like every entry in this section.
      reserve_image_attempt: {
        Args: {
          // Exactly one of these identifies the attempt
          // (0085_personal_image_generator.sql). With a project the owner is
          // derived from the LOCKED project row and p_user_id is ignored;
          // without one the owner IS p_user_id and idempotency is looked up
          // in that account's project-less namespace.
          p_project_id: string | null;
          p_user_id: string | null;
          p_idempotency_key: string;
          p_estimate_usd: number;
          p_model: string;
          p_day_start_ts: string;
          p_week_start_ts: string;
          p_now_ts: string;
          p_global_cap_usd: number;
          p_global_cap_enabled: boolean;
          p_global_cap_period: "daily" | "weekly";
          p_weekly_cap_usd: number;
          p_daily_cap_usd: number | null;
          p_daily_cap_enabled: boolean;
          p_hourly_cap_usd: number | null;
        };
        Returns: {
          outcome: "reserved" | "duplicate" | "blocked";
          run_id: string | null;
          blocked_by: "global" | "weekly" | "daily" | "hourly" | null;
          spent_usd: number | null;
        }[];
      };
      // One-round-trip replacement for the sidebar footer's six concurrent
      // reads -- see 0044_sidebar_budget_snapshot.sql for the measured
      // Supabase concurrency ceiling this exists to dodge. Calls
      // user_spend_usd/spend_total_usd/user_active_grants_usd rather than
      // reimplementing them, so this can never drift from what
      // assertWithinSpendCaps enforces. Backs web/lib/db-aggregates.ts's
      // getSidebarBudgetSnapshot. Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      sidebar_budget_snapshot: {
        Args: {
          target_user_id: string;
          day_start_ts: string;
          week_start_ts: string;
          now_ts: string;
        };
        Returns: {
          daily_spent_usd: number;
          weekly_spent_usd: number;
          global_spent_today_usd: number;
          active_grants_usd: number;
          grant_count: number;
          grant_earliest_expires_at: string | null;
          pending_request_id: string | null;
          pending_request_usd: number | null;
        }[];
      };
      // Returns the highest applied migration's version string (e.g.
      // "0045"), or null if the tracking row itself isn't there yet — see
      // web/lib/version.ts's EXPECTED_DB_VERSION and the sidebar footer /
      // health endpoint that compare against it to surface a code-ahead-of-
      // migration deploy instead of it being silent. Hand-patched rather than generated (same as the entries this file
      // already notes). The migration IS applied as of 2026-08-22 — remote
      // is at 0048 — so this entry now matches the live schema; it simply
      // has not been regenerated via `make types`.
      applied_schema_version: {
        Args: never;
        Returns: string | null;
      };
      // Display name per account that has saved at least one element, for the
      // "saved by" line on a card the viewer does not own -- see
      // 0091_shared_elements_library.sql. security definer, because an editor
      // cannot read another account's profiles row; a fixed projection of a
      // fixed set rather than a widening of profiles_select_admin. EMPTY for an
      // unapproved or suspended caller, which the Elements Library page has to
      // degrade around rather than treat as an error. Hand-patched rather than
      // generated (same as the entries this file already notes).
      element_creators: {
        Args: never;
        Returns: { id: string; display_name: string | null }[];
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

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
