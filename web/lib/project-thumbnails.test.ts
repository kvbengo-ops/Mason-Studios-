import { beforeEach, describe, expect, it, vi } from "vitest";

const signedUrl = vi.fn(
  async (
    storageKey: string,
    _ttl?: number,
    _transform?: { width: number; resize: string; quality: number },
  ) => `https://signed.example/${storageKey}`,
);

vi.mock("@/lib/storage", () => ({
  signedUrl: (...args: Parameters<typeof signedUrl>): ReturnType<typeof signedUrl> =>
    signedUrl(...args),
}));

const { selectProjectThumbnailSources, signProjectThumbnails } =
  await import("./project-thumbnails");

beforeEach(() => {
  signedUrl.mockReset();
  signedUrl.mockImplementation(
    async (storageKey: string) => `https://signed.example/${storageKey}`,
  );
});

describe("selectProjectThumbnailSources", () => {
  it("uses the newest poster before any approved reference frame", () => {
    expect(
      selectProjectThumbnailSources(
        [
          { id: "scene-1", projectId: "project-1", idx: 0, refFrameAssetId: "frame-1" },
          { id: "scene-2", projectId: "project-1", idx: 1, refFrameAssetId: "frame-2" },
          { id: "scene-3", projectId: "project-2", idx: 0, refFrameAssetId: "frame-3" },
        ],
        [
          { sceneId: "scene-1", storageKey: "old-poster.jpg", createdAt: "2026-09-01T00:00:00Z" },
          { sceneId: "scene-2", storageKey: "new-poster.jpg", createdAt: "2026-09-02T00:00:00Z" },
        ],
        [
          { id: "frame-1", storageKey: "frame-1.jpg" },
          { id: "frame-2", storageKey: "frame-2.jpg" },
          { id: "frame-3", storageKey: "frame-3.jpg" },
        ],
      ),
    ).toEqual([
      { projectId: "project-1", storageKey: "new-poster.jpg" },
      { projectId: "project-2", storageKey: "frame-3.jpg" },
    ]);
  });

  it("returns no source for a project with neither a poster nor a readable reference frame", () => {
    expect(
      selectProjectThumbnailSources(
        [{ id: "scene-1", projectId: "project-1", idx: 0, refFrameAssetId: "missing" }],
        [],
        [],
      ),
    ).toEqual([]);
  });
});

describe("signProjectThumbnails", () => {
  it("keeps good cards when one storage object cannot be signed", async () => {
    signedUrl.mockImplementation(async (storageKey: string) => {
      if (storageKey === "missing.jpg") throw new Error("not found");
      return `https://signed.example/${storageKey}`;
    });

    await expect(
      signProjectThumbnails([
        { projectId: "project-1", storageKey: "good.jpg" },
        { projectId: "project-2", storageKey: "missing.jpg" },
      ]),
    ).resolves.toEqual(
      new Map([
        ["project-1", "https://signed.example/good.jpg"],
        ["project-2", null],
      ]),
    );
  });
});
