import { BYTEPLUS_SEEDANCE_FLASH_ID, isBytePlusSeedance } from "@/lib/ugc-model-rules";
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
  editor: "Newly onboarded",
  hybrid_editor: "Hybrid Editor",
  ai_animator: "AI Animator",
};

/**
 * BytePlus opens Seedance 2.5 Flash's API at 14:00 Manila on 2026-11-15; before
 * that every submit 404s (InvalidEndpointOrModel.NotFound), so it stays hidden.
 * ponytail: delete this gate once the date has passed.
 */
export const FLASH_LIVE_AT = Date.parse("2026-11-15T14:00:00+08:00");

/**
 * Which video models a role may use (owner's table, 2026-11-09): a Hybrid Editor
 * every model except Wan 3.0; an AI Animator every model, Wan 3.0 included. Every
 * other role is unrestricted by model; spend and permissions are separate rules.
 * Seedance 2.5 on BytePlus is trusted editors (and admins) only (owner, 2026-11-10),
 * and so is Seedance 2.5 Flash on BytePlus (owner, 2026-11-15).
 */
export function canUseVideoModel(
  role: ProfileRole | null | undefined,
  modelId: string,
  now: number = Date.now(),
): boolean {
  if (modelId === BYTEPLUS_SEEDANCE_FLASH_ID && now < FLASH_LIVE_AT) return false;
  if (isBytePlusSeedance(modelId)) return role === "trusted_editor" || role === "admin";
  return role === "hybrid_editor" ? modelId !== "wan-3.0" : true;
}
