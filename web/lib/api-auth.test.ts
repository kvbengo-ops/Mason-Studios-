import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/server";
import { generateApiTokenMaterial, requireApiToken } from "./api-auth";

function setupMockAdmin(params: {
  tokenRow: {
    id: string;
    user_id: string;
    name: string;
    token_prefix: string;
    token_hash: string;
    scopes: string[];
    monthly_cap_usd: number | null;
    expires_at: string | null;
    last_used_at: string | null;
    revoked_at: string | null;
  } | null;
  profileRow?: {
    id: string;
    email: string;
    role: "editor" | "trusted_editor" | "admin";
    status: "pending" | "active" | "suspended";
    daily_cap_override_usd: number | null;
    weekly_cap_override_usd: number | null;
    hourly_cap_override_usd: number | null;
  } | null;
}) {
  const updateSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });

  vi.mocked(createAdminClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === "api_tokens") {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn((_col: string, val: string) => ({
            maybeSingle: vi.fn(async () => ({
              data: params.tokenRow && params.tokenRow.token_hash === val ? params.tokenRow : null,
              error: null,
            })),
          })),
          update: updateSpy,
        };
        return builder;
      }
      if (table === "profiles") {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data:
                params.profileRow !== undefined
                  ? params.profileRow
                  : {
                      id: "user-1",
                      email: "ced@example.com",
                      role: "trusted_editor",
                      status: "active",
                      daily_cap_override_usd: null,
                      weekly_cap_override_usd: null,
                      hourly_cap_override_usd: null,
                    },
              error: null,
            })),
          })),
        };
        return builder;
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  } as unknown as SupabaseClient<Database>);

  return { updateSpy };
}

describe("requireApiToken", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("authenticates a valid non-expiring token (expires_at = null) and updates last_used_at", async () => {
    const { rawToken, tokenPrefix, tokenHash } = generateApiTokenMaterial();
    const { updateSpy } = setupMockAdmin({
      tokenRow: {
        id: "tok-1",
        user_id: "user-1",
        name: "Ced CLI",
        token_prefix: tokenPrefix,
        token_hash: tokenHash,
        scopes: ["read", "upload", "generate"],
        monthly_cap_usd: 25,
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      },
    });

    const req = new Request("https://example.com/api/v1/quote", {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    const res = await requireApiToken(req, "generate", {
      now: new Date("2026-11-09T00:00:00Z"),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.userId).toBe("user-1");
    expect(res.tokenId).toBe("tok-1");
    expect(res.monthlyCapUsd).toBe(25);
    expect(updateSpy).toHaveBeenCalled();
  });

  it("rejects missing or malformed Authorization headers with 401", async () => {
    const missing = await requireApiToken(new Request("https://example.com/api/v1/quote"), "read");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.status).toBe(401);
      expect(missing.code).toBe("missing_token");
    }

    const malformed = await requireApiToken(
      new Request("https://example.com/api/v1/quote", {
        headers: { Authorization: "Bearer not_ms_live_token" },
      }),
      "read",
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.status).toBe(401);
      expect(malformed.code).toBe("invalid_token");
    }
  });

  it("rejects revoked tokens with 401 token_revoked", async () => {
    const { rawToken, tokenPrefix, tokenHash } = generateApiTokenMaterial();
    setupMockAdmin({
      tokenRow: {
        id: "tok-revoked",
        user_id: "user-1",
        name: "Revoked",
        token_prefix: tokenPrefix,
        token_hash: tokenHash,
        scopes: ["read", "upload", "generate"],
        monthly_cap_usd: null,
        expires_at: null,
        last_used_at: null,
        revoked_at: "2026-11-01T00:00:00Z",
      },
    });

    const res = await requireApiToken(
      new Request("https://example.com/api/v1/quote", {
        headers: { Authorization: `Bearer ${rawToken}` },
      }),
      "read",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.code).toBe("token_revoked");
    }
  });

  it("rejects expired tokens with 401 token_expired", async () => {
    const { rawToken, tokenPrefix, tokenHash } = generateApiTokenMaterial();
    setupMockAdmin({
      tokenRow: {
        id: "tok-expired",
        user_id: "user-1",
        name: "Expired",
        token_prefix: tokenPrefix,
        token_hash: tokenHash,
        scopes: ["read", "upload", "generate"],
        monthly_cap_usd: null,
        expires_at: "2026-11-01T00:00:00Z",
        last_used_at: null,
        revoked_at: null,
      },
    });

    const res = await requireApiToken(
      new Request("https://example.com/api/v1/quote", {
        headers: { Authorization: `Bearer ${rawToken}` },
      }),
      "read",
      { now: new Date("2026-11-09T00:00:00Z") },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.code).toBe("token_expired");
    }
  });

  it("rejects suspended accounts with 403 account_inactive", async () => {
    const { rawToken, tokenPrefix, tokenHash } = generateApiTokenMaterial();
    setupMockAdmin({
      tokenRow: {
        id: "tok-suspended",
        user_id: "user-suspended",
        name: "Suspended User Token",
        token_prefix: tokenPrefix,
        token_hash: tokenHash,
        scopes: ["read", "upload", "generate"],
        monthly_cap_usd: null,
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      },
      profileRow: {
        id: "user-suspended",
        email: "suspended@example.com",
        role: "trusted_editor",
        status: "suspended",
        daily_cap_override_usd: null,
        weekly_cap_override_usd: null,
        hourly_cap_override_usd: null,
      },
    });

    const res = await requireApiToken(
      new Request("https://example.com/api/v1/quote", {
        headers: { Authorization: `Bearer ${rawToken}` },
      }),
      "read",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.code).toBe("account_inactive");
    }
  });

  it("rejects tokens missing the required scope with 403 insufficient_scope", async () => {
    const { rawToken, tokenPrefix, tokenHash } = generateApiTokenMaterial();
    setupMockAdmin({
      tokenRow: {
        id: "tok-readonly",
        user_id: "user-1",
        name: "Read Only",
        token_prefix: tokenPrefix,
        token_hash: tokenHash,
        scopes: ["read"],
        monthly_cap_usd: null,
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      },
    });

    const res = await requireApiToken(
      new Request("https://example.com/api/v1/generate", {
        headers: { Authorization: `Bearer ${rawToken}` },
      }),
      "generate",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.code).toBe("insufficient_scope");
    }
  });
});
