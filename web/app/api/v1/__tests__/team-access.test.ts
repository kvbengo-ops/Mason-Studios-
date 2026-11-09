import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({ requireApiToken: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn() }));

import { requireApiToken } from "@/lib/api-auth";
import { POST as quote } from "../quote/route";
import { POST as generate } from "../generate/route";

const body = JSON.stringify({
  prompt: "A slow pan",
  model_id: "wan-3.0",
  resolution: "720p",
  duration_s: 5,
});

function asTeam(team: "hybrid_editor" | "ai_animator" | null) {
  vi.mocked(requireApiToken).mockResolvedValueOnce({
    ok: true,
    userId: "user-1",
    tokenId: "tok-1",
    tokenPrefix: "ms_live_test",
    scopes: ["read", "upload", "generate"],
    monthlyCapUsd: null,
    profile: { id: "user-1", team } as never,
  } as never);
}

describe("team model access on the API", () => {
  it.each([
    ["/quote", quote],
    ["/generate", generate],
  ])("refuses wan-3.0 to a Hybrid Editor at %s before any spend", async (path, handler) => {
    asTeam("hybrid_editor");
    const response = await handler(
      new Request(`https://example.test/api/v1${path}`, {
        method: "POST",
        headers: { "Idempotency-Key": "team-test", "Content-Type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "model_not_allowed" });
  });
});
