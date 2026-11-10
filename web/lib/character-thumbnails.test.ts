import { afterEach, describe, expect, it, vi } from "vitest";
import { signCharacterThumbnails } from "./character-thumbnails";
import { getImageUrl } from "@/lib/storage";

vi.mock("@/lib/storage", () => ({
  getImageUrl: vi.fn(),
}));

describe("signCharacterThumbnails", () => {
  afterEach(() => {
    vi.mocked(getImageUrl).mockReset();
  });

  it("signs every row's pre-sized thumbnail", async () => {
    vi.mocked(getImageUrl).mockImplementation(async (key) => `https://fake.test/${key}`);

    const rows = [
      { id: "c1", storage_key: "library/c1.png" },
      { id: "c2", storage_key: "library/c2.png" },
    ];
    const urls = await signCharacterThumbnails(rows, "test");

    expect(urls).toEqual(["https://fake.test/library/c1.png", "https://fake.test/library/c2.png"]);
    expect(getImageUrl).toHaveBeenCalledWith("library/c1.png", "thumb");
  });

  // The exact bug this file exists to prevent: a single orphaned row's
  // getImageUrl() rejection used to take Promise.all's whole batch down with
  // it, 500ing the entire page — /library's grid and every project's
  // Character step alike — over one bad row. allSettled must keep every
  // OTHER row's URL intact instead.
  it("degrades one rejected row to null without losing the others", async () => {
    vi.mocked(getImageUrl).mockImplementation(async (key) => {
      if (key === "library/bad.png") {
        throw new Error("signedUrl: failed to sign library/bad.png: not found");
      }
      return `https://fake.test/${key}`;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rows = [
      { id: "good-1", storage_key: "library/good-1.png" },
      { id: "orphaned", storage_key: "library/bad.png" },
      { id: "good-2", storage_key: "library/good-2.png" },
    ];
    const urls = await signCharacterThumbnails(rows, "test-context");

    expect(urls).toEqual([
      "https://fake.test/library/good-1.png",
      null,
      "https://fake.test/library/good-2.png",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("test-context"),
      expect.objectContaining({ characterId: "orphaned", storageKey: "library/bad.png" }),
    );

    warn.mockRestore();
  });

  it("returns an empty array for an empty batch without calling getImageUrl", async () => {
    const urls = await signCharacterThumbnails([], "test");
    expect(urls).toEqual([]);
    expect(getImageUrl).not.toHaveBeenCalled();
  });
});
