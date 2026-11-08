import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { canUseApp } from "@/lib/account-approval";
import { retryAfterSeconds, takeActionSlot, takeReadSlot } from "@/lib/action-rate-limit";
import { createAdminClient } from "@/lib/supabase/server";
import type { ApiTokenScope, Database } from "@/types/db";

type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];

export const API_TOKEN_PREFIX = "ms_live_";
const API_TOKEN_REGEX = /^ms_live_[0-9a-f]{64}$/;
const LAST_USED_UPDATE_INTERVAL_MS = 60_000;

export function hashApiToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generateApiTokenMaterial(): {
  rawToken: string;
  tokenPrefix: string;
  tokenHash: string;
} {
  const randomHex = randomBytes(32).toString("hex");
  const rawToken = `${API_TOKEN_PREFIX}${randomHex}`;
  const tokenPrefix = rawToken.slice(0, 16);
  const tokenHash = hashApiToken(rawToken);
  return { rawToken, tokenPrefix, tokenHash };
}

export interface ApiAuthContext {
  ok: true;
  userId: string;
  tokenId: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  monthlyCapUsd: number | null;
  profile: ProfileRow;
}

export interface ApiAuthFailure {
  ok: false;
  status: 401 | 403 | 429;
  code:
    | "missing_token"
    | "invalid_token"
    | "token_revoked"
    | "token_expired"
    | "account_inactive"
    | "insufficient_scope"
    | "rate_limited";
  error: string;
  retryAfterSeconds?: number;
  response: NextResponse;
}

export type ApiAuthResult = ApiAuthContext | ApiAuthFailure;

function makeAuthErrorResponse(
  status: 401 | 403 | 429,
  code: ApiAuthFailure["code"],
  error: string,
  retryAfterS?: number,
): ApiAuthFailure {
  const headers: Record<string, string> = {};
  if (status === 429 && retryAfterS !== undefined) {
    headers["Retry-After"] = String(retryAfterS);
  }
  return {
    ok: false,
    status,
    code,
    error,
    ...(retryAfterS !== undefined ? { retryAfterSeconds: retryAfterS } : {}),
    response: NextResponse.json({ error, code }, { status, headers }),
  };
}

/**
 * Authenticates a `Bearer ms_live_<64-hex>` Personal API Token on `/api/v1/*` routes,
 * enforcing revocation, expiration (`NULL` = non-expiring), account active status,
 * required scope (`read` | `upload` | `generate`), and per-user rate limits.
 */
export async function requireApiToken(
  request: Request,
  requiredScope: ApiTokenScope,
  options?: {
    rateLimitBucket?: "write" | "read";
    now?: Date;
  },
): Promise<ApiAuthResult> {
  const authHeader = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (!match?.[1]) {
    return makeAuthErrorResponse(
      401,
      "missing_token",
      "Missing or malformed Authorization: Bearer <token> header.",
    );
  }

  const rawToken = match[1];
  if (!API_TOKEN_REGEX.test(rawToken)) {
    return makeAuthErrorResponse(
      401,
      "invalid_token",
      "Invalid API token format. Expected ms_live_<64 hex characters>.",
    );
  }

  const tokenHash = hashApiToken(rawToken);
  const admin = createAdminClient();
  const now = options?.now ?? new Date();

  const { data: tokenRow, error: tokenError } = await admin
    .from("api_tokens")
    .select(
      "id, user_id, name, token_prefix, scopes, monthly_cap_usd, expires_at, last_used_at, revoked_at",
    )
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenError) {
    throw new Error(`Failed to verify API token: ${tokenError.message}`);
  }
  if (!tokenRow) {
    return makeAuthErrorResponse(401, "invalid_token", "Invalid API token.");
  }

  if (tokenRow.revoked_at !== null) {
    return makeAuthErrorResponse(401, "token_revoked", "This API token has been revoked.");
  }

  if (tokenRow.expires_at !== null && new Date(tokenRow.expires_at).getTime() <= now.getTime()) {
    return makeAuthErrorResponse(401, "token_expired", "This API token has expired.");
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", tokenRow.user_id)
    .maybeSingle();

  if (profileError) {
    throw new Error(`Failed to load token owner profile: ${profileError.message}`);
  }

  if (!profile || !canUseApp(profile)) {
    return makeAuthErrorResponse(
      403,
      "account_inactive",
      "Account is suspended or pending approval.",
    );
  }

  const scopes = (tokenRow.scopes ?? []) as ApiTokenScope[];
  if (!scopes.includes(requiredScope)) {
    return makeAuthErrorResponse(
      403,
      "insufficient_scope",
      `This API token does not have the required "${requiredScope}" scope.`,
    );
  }

  const bucket = options?.rateLimitBucket ?? (requiredScope === "read" ? "read" : "write");
  const nowMs = now.getTime();
  const allowed =
    bucket === "read"
      ? takeReadSlot(tokenRow.user_id, nowMs)
      : takeActionSlot(tokenRow.user_id, nowMs);

  if (!allowed) {
    const retryS = retryAfterSeconds(tokenRow.user_id, bucket, nowMs);
    return makeAuthErrorResponse(
      429,
      "rate_limited",
      `Rate limit exceeded (${bucket === "read" ? "120 read" : "60 write"} requests/minute). Retry after ${retryS}s.`,
      retryS,
    );
  }

  // Best-effort throttled last_used_at update (at most once per 60s per token).
  const lastUsedMs = tokenRow.last_used_at ? new Date(tokenRow.last_used_at).getTime() : 0;
  if (nowMs - lastUsedMs >= LAST_USED_UPDATE_INTERVAL_MS) {
    void admin.from("api_tokens").update({ last_used_at: now.toISOString() }).eq("id", tokenRow.id);
  }

  return {
    ok: true,
    userId: tokenRow.user_id,
    tokenId: tokenRow.id,
    tokenPrefix: tokenRow.token_prefix,
    scopes,
    monthlyCapUsd: tokenRow.monthly_cap_usd !== null ? Number(tokenRow.monthly_cap_usd) : null,
    profile,
  };
}
