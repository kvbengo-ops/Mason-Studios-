import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAdmin = vi.fn();
const rpc = vi.fn();

vi.mock("@/actions/guard", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("@/lib/accounts-control", () => ({
  runModelLabel: (model: string) => (model === "bytedance/seedance-2-5" ? "Seedance 2.5" : model),
}));

import { getAccountBurn } from "./burn";

const USER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({});
});

describe("getAccountBurn", () => {
  it("refuses before any read when the caller is not an admin", async () => {
    requireAdmin.mockRejectedValue(new Error("not an admin"));
    await expect(getAccountBurn(USER, 14)).rejects.toThrow("not an admin");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a uuid without reading", async () => {
    expect(await getAccountBurn("x'; drop table runs", 14)).toEqual({
      error: "That account id is not valid.",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads one account over 14 days by default and merges kie and BytePlus by label", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "spend_daily_by_user"
        ? { data: [{ user_id: USER, day: "2026-11-10", total_usd: 4 }], error: null }
        : {
            data: [
              { model: "bytedance/seedance-2-5", vendor: "kie", run_count: 2, cost_usd: 3 },
              { model: "bytedance/seedance-2-5", vendor: "byteplus", run_count: 1, cost_usd: 1 },
            ],
            error: null,
          },
    );
    const result = await getAccountBurn(USER, 7);
    if (!("detail" in result)) throw new Error("expected detail");
    expect(result.detail.days).toHaveLength(14);
    expect(result.detail.days.reduce((a, b) => a + b, 0)).toBe(4);
    expect(result.detail.models).toEqual([
      { label: "Seedance 2.5", runs: 2, costUsd: 3 },
      { label: "Seedance 2.5 · BytePlus", runs: 1, costUsd: 1 },
    ]);
    // Bounded to the one account both times.
    expect(rpc).toHaveBeenCalledWith(
      "spend_daily_by_user",
      expect.objectContaining({ user_ids: [USER] }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "spend_models_by_user",
      expect.objectContaining({ target_user_id: USER }),
    );
  });

  it("returns an error as data when a read fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const result = await getAccountBurn(USER, 30);
    expect(result).toEqual({ error: "Could not load this account's spend. Try again." });
  });
});
