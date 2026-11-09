import type { ProfileRole } from "@/types/db";

/**
 * The roles an admin may set from Accounts Control (setAccountRole). Admin is not one:
 * promoteToAdmin/demoteAdmin own it. hybrid_editor and ai_animator come from 0131.
 */
export const ASSIGNABLE_ROLES = [
  "editor",
  "trusted_editor",
  "hybrid_editor",
  "ai_animator",
] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly unknown[]).includes(value);
}

export const ROLE_LABELS: Readonly<Record<ProfileRole, string>> = {
  admin: "Admin",
  trusted_editor: "Trusted editor",
  editor: "Editor",
  hybrid_editor: "Hybrid Editor",
  ai_animator: "AI Animator",
};

/**
 * Which video models a role may use (owner's table, 2026-11-09): a Hybrid Editor
 * every model except Wan 3.0; an AI Animator every model, Wan 3.0 included. Every
 * other role is unrestricted by model; spend and permissions are separate rules.
 */
export function canUseVideoModel(role: ProfileRole | null | undefined, modelId: string): boolean {
  return role === "hybrid_editor" ? modelId !== "wan-3.0" : true;
}
