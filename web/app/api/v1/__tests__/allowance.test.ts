import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({ requireApiToken: vi.fn() }));
vi.mock("@/lib/spend", () => ({ getAccountBudgetSnapshot: vi.fn() }));

import { requireApiToken } from "@/lib/api-auth";
import { getAccountBudgetSnapshot } from "@/lib/spend";
import { GET } from "../allowance/route";

describe("GET /allowance", () => {
  it("returns the token owner's current USD headroom", async () => {
    const profile = { role: "trusted_editor" };
    vi.mocked(requireApiToken).mockResolvedValue({ ok: true, userId: "owner", profile } as never);
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue({
      dailyRemainingUsd: 4.5,
      weeklyRemainingUsd: 12,
      dailyCapUsd: 10,
      weeklyCapUsd: 25,
      dailyCapEnabled: true,
    } as never);
    const request = new Request("https://example.test/api/v1/allowance");
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(requireApiToken).toHaveBeenCalledWith(request, "read");
    expect(getAccountBudgetSnapshot).toHaveBeenCalledWith("owner", profile);
    expect(await response.json()).toMatchObject({
      daily_remaining_usd: 4.5,
      weekly_remaining_usd: 12,
    });
  });
});
