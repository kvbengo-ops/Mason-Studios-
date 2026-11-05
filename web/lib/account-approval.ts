import type { ProfileRole, ProfileStatus } from "@/types/db";

export interface AccountApprovalProfile {
  role: ProfileRole;
  status: ProfileStatus;
}

/** Admins are trusted by role; editor tiers require an explicit approval. */
export function requiresAccountApproval(role: ProfileRole): boolean {
  return role !== "admin";
}

/** The application-level twin of Postgres' is_active() RLS helper. */
export function canUseApp(profile: AccountApprovalProfile): boolean {
  return !requiresAccountApproval(profile.role) || profile.status === "active";
}
