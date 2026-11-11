import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/guard", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/actions/ugc", () => ({
  purgeDeletedScene: vi.fn(),
  purgeDeletedVersion: vi.fn(),
}));

import { requireAdmin } from "@/actions/guard";
import { purgeDeletedScene, purgeDeletedVersion } from "@/actions/ugc";
import { purgeBinEntries } from "./bin-bulk";

function form(scenes: string[], versions: string[]): FormData {
  const data = new FormData();
  for (const id of scenes) data.append("scene", id);
  for (const id of versions) data.append("version", id);
  return data;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("purgeBinEntries", () => {
  it("is admin only: a non-admin is refused before anything is deleted", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Admins only"));

    await expect(purgeBinEntries(form(["s1"], []))).rejects.toThrow("Admins only");
    expect(purgeDeletedScene).not.toHaveBeenCalled();
    expect(purgeDeletedVersion).not.toHaveBeenCalled();
  });

  it("deletes every selected scene and version once, versions first", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({} as never);
    const order: string[] = [];
    vi.mocked(purgeDeletedVersion).mockImplementation(async (data) => {
      order.push(`v:${String(data.get("versionId"))}`);
      return undefined;
    });
    vi.mocked(purgeDeletedScene).mockImplementation(async (data) => {
      order.push(`s:${String(data.get("sceneId"))}`);
      return undefined;
    });

    const result = await purgeBinEntries(form(["s1", "s1", "s2"], ["v1"]));

    expect(order).toEqual(["v:v1", "s:s1", "s:s2"]);
    expect(result).toEqual({ notice: "Permanently deleted 3." });
  });

  it("reports partial failures instead of hiding them", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({} as never);
    vi.mocked(purgeDeletedScene)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ error: "That's already been removed." });

    const result = await purgeBinEntries(form(["s1", "s2"], []));

    expect(result).toEqual({
      notice: "Permanently deleted 1. 1 could not be deleted (already gone, or an error).",
    });
  });

  it("refuses an empty selection and one over the per-press limit", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({} as never);

    expect(await purgeBinEntries(form([], []))).toEqual({
      error: "Select at least one entry to delete.",
    });
    const tooMany = Array.from({ length: 201 }, (_, i) => `s${i}`);
    expect(await purgeBinEntries(form(tooMany, []))).toMatchObject({
      error: expect.stringMatching(/at most 200/),
    });
    expect(purgeDeletedScene).not.toHaveBeenCalled();
  });
});
