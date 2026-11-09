import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({ requireApiToken: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn() }));

import { requireApiToken } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/server";
import { DELETE, GET, PATCH } from "../elements/[id]/route";

const elementId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = { params: Promise.resolve({ id: elementId }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireApiToken).mockResolvedValue({ ok: true, userId: "owner", profile: {} } as never);
});

describe("element detail ownership", () => {
  it.each([
    ["GET", GET],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ])("hides foreign elements from %s", async (method, handler) => {
    const update = vi.fn();
    const builder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({
        data: { id: elementId, user_id: "someone-else" },
        error: null,
      })),
      update,
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);
    const request = new Request(`https://example.test/api/v1/elements/${elementId}`, {
      method,
      ...(method === "PATCH"
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "new_name" }),
          }
        : {}),
    });
    const response = await handler(request, context);
    expect(response.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });
});
