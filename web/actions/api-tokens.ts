"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/actions/guard";
import type { ActionResult } from "@/lib/action-result";
import { canUseApiTokens, generateApiTokenMaterial } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/server";
import type { ApiTokenScope } from "@/lib/api-auth";

const VALID_SCOPES: ReadonlySet<ApiTokenScope> = new Set(["read", "upload", "generate"]);

export interface ApiTokenMetadata {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  scopes: ApiTokenScope[];
  monthly_cap_usd: number | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type CreateApiTokenResult =
  | {
      rawToken: string;
      token: ApiTokenMetadata;
      error?: undefined;
    }
  | {
      error: string;
      rawToken?: undefined;
      token?: undefined;
    };

/**
 * Lists the signed-in user's personal API tokens (never selecting `token_hash`).
 */
export async function listApiTokens(): Promise<ApiTokenMetadata[]> {
  const { user } = await requireUser({ rateLimit: false });
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("api_tokens")
    .select(
      "id, user_id, name, token_prefix, scopes, monthly_cap_usd, expires_at, last_used_at, revoked_at, created_at",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list API tokens: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    ...row,
    scopes: (row.scopes ?? []) as ApiTokenScope[],
    monthly_cap_usd: row.monthly_cap_usd !== null ? Number(row.monthly_cap_usd) : null,
  }));
}

/**
 * Mints a new personal API token (`ms_live_<64-hex>`), storing only its SHA-256
 * digest in `api_tokens.token_hash` and returning the plaintext token once.
 */
export async function createApiToken(formData: FormData): Promise<CreateApiTokenResult> {
  const { user, profile } = await requireUser();
  if (!canUseApiTokens(profile)) {
    return { error: "Personal API tokens are available to trusted editors and admins only." };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 80) {
    return { error: "Token name must be between 1 and 80 characters." };
  }

  const submittedScopes = formData.getAll("scopes").map((s) => String(s).trim());
  if (
    submittedScopes.length === 0 ||
    submittedScopes.some((scope) => !VALID_SCOPES.has(scope as ApiTokenScope))
  ) {
    return { error: "Choose at least one valid token scope." };
  }
  const scopes: ApiTokenScope[] = [...new Set(submittedScopes as ApiTokenScope[])];

  const rawCap = String(formData.get("monthlyCapUsd") ?? "").trim();
  let monthlyCapUsd: number | null = null;
  if (rawCap !== "") {
    const parsed = Number(rawCap);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: "Monthly spend cap must be a valid non-negative dollar amount." };
    }
    monthlyCapUsd = Math.round(parsed * 100) / 100;
  }

  const rawExpiresDays = String(formData.get("expiresInDays") ?? "").trim();
  let expiresAt: string | null = null;
  if (rawExpiresDays !== "" && rawExpiresDays !== "never") {
    const days = Number(rawExpiresDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return { error: "Expiration must be between 1 and 3650 days, or never." };
    }
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const { rawToken, tokenPrefix, tokenHash } = generateApiTokenMaterial();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("api_tokens")
    .insert({
      user_id: user.id,
      name,
      token_prefix: tokenPrefix,
      token_hash: tokenHash,
      scopes,
      monthly_cap_usd: monthlyCapUsd,
      expires_at: expiresAt,
    })
    .select(
      "id, user_id, name, token_prefix, scopes, monthly_cap_usd, expires_at, last_used_at, revoked_at, created_at",
    )
    .single();

  if (error || !data) {
    return { error: `Could not create API token: ${error?.message ?? "unknown error"}` };
  }

  revalidatePath("/settings/api-tokens");
  revalidatePath("/profile");

  return {
    rawToken,
    token: {
      ...data,
      scopes: (data.scopes ?? []) as ApiTokenScope[],
      monthly_cap_usd: data.monthly_cap_usd !== null ? Number(data.monthly_cap_usd) : null,
    },
  };
}

/**
 * Revokes one of the caller's personal API tokens immediately.
 */
export async function revokeApiToken(tokenId: string): Promise<ActionResult> {
  const { user } = await requireUser();
  const trimmed = tokenId.trim();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(trimmed)) {
    return { error: "Invalid token ID." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", trimmed)
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to revoke API token: ${error.message}`);
  }
  if (!data) {
    return { error: "Token not found or already revoked." };
  }

  revalidatePath("/settings/api-tokens");
  revalidatePath("/profile");
  return undefined;
}
