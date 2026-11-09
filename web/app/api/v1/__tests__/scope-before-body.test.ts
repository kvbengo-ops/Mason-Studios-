import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({ requireApiToken: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn() }));

import { requireApiToken } from "@/lib/api-auth";
import { POST as generateClip } from "../generate/route";
import { POST as generateImage } from "../images/route";

describe("generate scope", () => {
  it.each([
    ["/generate", generateClip],
    ["/images", generateImage],
  ])("rejects read+upload at %s before parsing the body", async (path, handler) => {
    vi.mocked(requireApiToken).mockResolvedValueOnce({
      ok: false,
      response: Response.json(
        { error: "Generate scope required", code: "insufficient_scope" },
        { status: 403 },
      ),
    } as never);
    const request = new Request(`https://example.test/api/v1${path}`, {
      method: "POST",
      headers: { "Idempotency-Key": "test" },
      body: "{invalid-json",
    });
    const response = await handler(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "insufficient_scope" });
    expect(requireApiToken).toHaveBeenCalledWith(request, "generate");
  });
});
