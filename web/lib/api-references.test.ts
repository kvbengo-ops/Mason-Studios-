import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import type * as StorageModule from "@/lib/storage";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return {
    ...actual,
    copyStorageObject: vi.fn().mockResolvedValue(undefined),
  };
});

import { attachApiSceneReferences, resolveApiReferences } from "./api-references";

interface FakeElement {
  id: string;
  user_id: string;
  name: string;
  category: "character" | "product" | "location" | "other" | "audio" | "video";
  description: string | null;
  ai_description: string | null;
  asset_id: string;
}

interface FakeAsset {
  id: string;
  kind: "character_ref" | "product_ref" | "ref_frame" | "audio" | "video_ref";
  storage_key: string;
  duration_s: number | null;
}

function makeFakeAdmin(params: {
  ownedElements: FakeElement[];
  foreignElements?: FakeElement[];
  assets: FakeAsset[];
  fencedRpcReturn?: boolean;
}): SupabaseClient<Database> {
  const allElements = [...params.ownedElements, ...(params.foreignElements ?? [])];

  return {
    from: vi.fn((table: string) => {
      if (table === "elements") {
        let filterUserId: string | null = null;
        let filterId: string | null = null;
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn((col: string, val: string) => {
            if (col === "user_id") filterUserId = val;
            if (col === "id") filterId = val;
            return builder;
          }),
          is: vi.fn(() => {
            if (filterUserId !== null) {
              return Promise.resolve({
                data: allElements.filter((e) => e.user_id === filterUserId),
                error: null,
              });
            }
            return builder;
          }),
          maybeSingle: vi.fn(() => {
            const match = allElements.find((e) => e.id === filterId) ?? null;
            return Promise.resolve({ data: match, error: null });
          }),
        };
        return builder;
      }
      if (table === "assets") {
        const builder = {
          select: vi.fn(() => builder),
          in: vi.fn((_col: string, ids: string[]) =>
            Promise.resolve({
              data: params.assets.filter((a) => ids.includes(a.id)),
              error: null,
            }),
          ),
        };
        return builder;
      }
      throw new Error(`Unexpected table ${table}`);
    }),
    rpc: vi.fn(async (fnName: string) => {
      if (fnName === "attach_scene_references_fenced") {
        return { data: params.fencedRpcReturn ?? true, error: null };
      }
      throw new Error(`Unexpected rpc ${fnName}`);
    }),
  } as unknown as SupabaseClient<Database>;
}

describe("resolveApiReferences", () => {
  const baseElements: FakeElement[] = [
    {
      id: "el-img-a",
      user_id: "user-1",
      name: "hero_anna",
      category: "character",
      description: "Anna in a red jacket",
      ai_description: null,
      asset_id: "asset-img-a",
    },
    {
      id: "el-img-b",
      user_id: "user-1",
      name: "bottle_serum",
      category: "product",
      description: "Glass serum bottle",
      ai_description: null,
      asset_id: "asset-img-b",
    },
    {
      id: "el-vid-1",
      user_id: "user-1",
      name: "dance_move",
      category: "video",
      description: "Smooth spin motion",
      ai_description: null,
      asset_id: "asset-vid-1",
    },
    {
      id: "el-aud-1",
      user_id: "user-1",
      name: "narrator_voice",
      category: "audio",
      description: "Warm female narrator",
      ai_description: null,
      asset_id: "asset-aud-1",
    },
  ];

  const baseAssets: FakeAsset[] = [
    {
      id: "asset-img-a",
      kind: "character_ref",
      storage_key: "projects/lib/character_ref/a.png",
      duration_s: null,
    },
    {
      id: "asset-img-b",
      kind: "product_ref",
      storage_key: "projects/lib/product_ref/b.jpg",
      duration_s: null,
    },
    {
      id: "asset-vid-1",
      kind: "video_ref",
      storage_key: "projects/lib/video_ref/v.mp4",
      duration_s: 6.5,
    },
    {
      id: "asset-aud-1",
      kind: "audio",
      storage_key: "projects/lib/audio/a.mp3",
      duration_s: 5.0,
    },
  ];

  it.each(["seedance-2.5-byteplus", "seedance-2.5"])(
    "accepts 8+1+3 %s references and names per-type and time overflows",
    async (modelId) => {
    const kinds = [...Array(8).fill("image"), "video", ...Array(3).fill("audio")] as (
      "image" | "video" | "audio"
    )[];
    const elements: FakeElement[] = kinds.map((kind, i) => ({
      id: `el-${i}`,
      user_id: "user-1",
      name: `ref_${i}`,
      // Images are filed as characters; the asset kind below decides what the ref is.
      category: kind === "image" ? "character" : kind,
      description: null,
      ai_description: null,
      asset_id: `asset-${i}`,
    }));
    const assets: FakeAsset[] = kinds.map((kind, i) => ({
      id: `asset-${i}`,
      kind: kind === "image" ? "ref_frame" : kind === "video" ? "video_ref" : "audio",
      storage_key: `users/user-1/${kind}/ref-${i}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3"}`,
      duration_s: kind === "video" ? 4 : kind === "audio" ? 8 : null,
    }));
    const admin = makeFakeAdmin({ ownedElements: elements, assets });
    const args = {
      admin,
      userId: "user-1",
      modelId,
      resolution: "480p",
      prompt: "A wide cinematic shot",
      imageRefs: elements.slice(0, 8).map((e) => e.id),
      videoRefs: [elements[8]!.id],
      audioRefs: elements.slice(9).map((e) => e.id),
    };
    expect((await resolveApiReferences(args)).ok).toBe(true);
    expect(
      await resolveApiReferences({ ...args, imageRefs: [...args.imageRefs, args.imageRefs[0]!] }),
    ).toMatchObject({ ok: false, code: "invalid_parameters" });
    const ninthImage = { ...elements[0]!, id: "el-12", name: "ref_12", asset_id: "asset-12" };
    const adminWithNinth = makeFakeAdmin({
      ownedElements: [...elements, ninthImage],
      assets: [...assets, { ...assets[0]!, id: "asset-12" }],
    });
    expect(
      await resolveApiReferences({
        ...args,
        admin: adminWithNinth,
        imageRefs: [...args.imageRefs, ninthImage.id],
      }),
    ).toMatchObject({
      ok: false,
      code: "too_many_references",
      error: expect.stringMatching(/8 image/),
    });
    assets[8]!.duration_s = 31;
    expect(
      await resolveApiReferences({
        ...args,
        admin: makeFakeAdmin({ ownedElements: elements, assets }),
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_media_file",
      error: expect.stringMatching(/30 seconds per video/),
    });
    // App-uploaded voices carry no duration_s; they pass through rather than being refused.
    assets[8]!.duration_s = 4;
    assets[9]!.duration_s = null;
    expect(
      (
        await resolveApiReferences({
          ...args,
          admin: makeFakeAdmin({ ownedElements: elements, assets }),
        })
      ).ok,
    ).toBe(true);
    },
  );

  it("applies the 20,000 character cap AFTER @tags expand into descriptions", async () => {
    // A short raw prompt passes parseApiClipInput; the description it expands to does not.
    const hero: FakeElement = {
      id: "el-hero",
      user_id: "user-1",
      name: "hero",
      category: "character",
      description: "x".repeat(20_000),
      ai_description: null,
      asset_id: "asset-hero",
    };
    const asset: FakeAsset = {
      id: "asset-hero",
      kind: "ref_frame",
      storage_key: "users/user-1/image/hero.png",
      duration_s: null,
    };
    const result = await resolveApiReferences({
      admin: makeFakeAdmin({ ownedElements: [hero], assets: [asset] }),
      userId: "user-1",
      modelId: "seedance-2.5-byteplus",
      resolution: "480p",
      prompt: "A slow push-in on @hero in a studio",
      imageRefs: ["el-hero"],
    });
    expect(result).toMatchObject({ ok: false, code: "prompt_too_long" });
    expect((result as { error: string }).error).toMatch(/20,000 limit/);
  });

  it("preserves array ordinal identity when @Image 2 is mentioned before @Image 1", async () => {
    const admin = makeFakeAdmin({ ownedElements: baseElements, assets: baseAssets });
    const result = await resolveApiReferences({
      admin,
      userId: "user-1",
      modelId: "seedance-2.5",
      resolution: "480p",
      prompt: "@Image 2 sits on the table before @Image 1 picks it up",
      imageRefs: ["el-img-a", "el-img-b"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Array order is preserved: el-img-a is ordinal 1, el-img-b is ordinal 2.
    expect(
      result.orderedReferences.images.map((r) => ({ id: r.elementId, ordinal: r.ordinal })),
    ).toEqual([
      { id: "el-img-a", ordinal: 1 },
      { id: "el-img-b", ordinal: 2 },
    ]);
    expect(result.explicitOrderedTags).toEqual(["hero_anna", "bottle_serum"]);
    expect(result.rewrittenPrompt).toBe(
      "@bottle_serum sits on the table before @hero_anna picks it up",
    );
    expect(result.providerReferencePrompt).toBe(
      "@image2 sits on the table before @image1 picks it up",
    );
  });

  it("supports mixed media (image + video + audio) and keeps unmentioned array references attached", async () => {
    const admin = makeFakeAdmin({ ownedElements: baseElements, assets: baseAssets });
    const result = await resolveApiReferences({
      admin,
      userId: "user-1",
      modelId: "seedance-2.5",
      resolution: "480p",
      // Only @Image 1 and @Video 1 are mentioned in the prompt; el-img-b and el-aud-1 are unmentioned
      prompt: "@Image 1 performs the motion from @Video 1",
      imageRefs: ["el-img-a", "el-img-b"],
      videoRefs: ["el-vid-1"],
      audioRefs: ["el-aud-1"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.orderedReferences.images).toHaveLength(2);
    expect(result.orderedReferences.videos).toHaveLength(1);
    expect(result.orderedReferences.audios).toHaveLength(1);
    expect(result.videoReferenceDurationsS).toEqual([6.5]);
    expect(result.explicitOrderedTags).toEqual([
      "hero_anna",
      "bottle_serum",
      "dance_move",
      "narrator_voice",
    ]);
    expect(result.providerReferencePrompt).toBe("@image1 performs the motion from @video1");
  });

  it("rejects out-of-bounds positional indexes with 422 invalid_reference_index", async () => {
    const admin = makeFakeAdmin({ ownedElements: baseElements, assets: baseAssets });
    const result = await resolveApiReferences({
      admin,
      userId: "user-1",
      modelId: "seedance-2.5",
      resolution: "480p",
      prompt: "@Image 3 walks into the frame",
      imageRefs: ["el-img-a", "el-img-b"],
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      code: "invalid_reference_index",
      error: expect.stringMatching(/@Image 3.*out of bounds/i),
    });
  });

  it("rejects elements belonging to another user with 403 forbidden_reference", async () => {
    const admin = makeFakeAdmin({
      ownedElements: baseElements,
      foreignElements: [
        {
          id: "el-other-user",
          user_id: "user-2",
          name: "secret_char",
          category: "character",
          description: "Other user character",
          ai_description: null,
          asset_id: "asset-img-a",
        },
      ],
      assets: baseAssets,
    });

    const result = await resolveApiReferences({
      admin,
      userId: "user-1",
      modelId: "seedance-2.5",
      resolution: "480p",
      prompt: "@Image 1 smiles",
      imageRefs: ["el-other-user"],
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      code: "forbidden_reference",
      error: expect.stringMatching(/another account/i),
    });
  });

  it("rejects Kling prompts containing @tags and rejects WebP frames on Kling", async () => {
    const webpAssets: FakeAsset[] = [
      ...baseAssets,
      {
        id: "asset-webp",
        kind: "ref_frame",
        storage_key: "projects/lib/ref_frame/w.webp",
        duration_s: null,
      },
    ];
    const webpElements: FakeElement[] = [
      ...baseElements,
      {
        id: "el-webp",
        user_id: "user-1",
        name: "webp_frame",
        category: "character",
        description: null,
        ai_description: null,
        asset_id: "asset-webp",
      },
    ];
    const admin = makeFakeAdmin({ ownedElements: webpElements, assets: webpAssets });

    const withTag = await resolveApiReferences({
      admin,
      userId: "user-1",
      modelId: "kling-3.0-pro",
      resolution: "720p",
      prompt: "@hero_anna walks forward",
      imageRefs: ["el-img-a"],
    });
    expect(withTag.ok).toBe(false);
    if (!withTag.ok) {
      expect(withTag.status).toBe(422);
      expect(withTag.error).toMatch(/Kling can't use @tags/i);
    }

    const withWebp = await resolveApiReferences({
      admin,
      userId: "user-1",
      modelId: "kling-3.0-pro",
      resolution: "720p",
      prompt: "She walks forward",
      imageRefs: ["el-webp"],
    });
    expect(withWebp.ok).toBe(false);
    if (!withWebp.ok) {
      expect(withWebp.status).toBe(422);
      expect(withWebp.error).toMatch(/PNG or JPG/i);
    }
  });

  it("allows Gemini Omni 1.2 prompts without references and refuses video references", async () => {
    const admin = makeFakeAdmin({ ownedElements: baseElements, assets: baseAssets });
    const args = {
      admin,
      userId: "user-1",
      modelId: "gemini-omni-1.2",
      resolution: "720p",
      prompt: "A camera tracks a cyclist",
    };
    expect((await resolveApiReferences(args)).ok).toBe(true);
    expect(await resolveApiReferences({ ...args, videoRefs: ["el-vid-1"] })).toMatchObject({
      ok: false,
      status: 422,
      code: "too_many_references",
    });
  });

  it("attachApiSceneReferences detects fencing when attach_scene_references_fenced returns false", async () => {
    const admin = makeFakeAdmin({
      ownedElements: baseElements,
      assets: baseAssets,
      fencedRpcReturn: false,
    });
    const resolved = await resolveApiReferences({
      admin,
      userId: "user-1",
      modelId: "seedance-2.5",
      resolution: "480p",
      prompt: "@Image 1 holds @Image 2",
      imageRefs: ["el-img-a", "el-img-b"],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const attachResult = await attachApiSceneReferences({
      admin,
      projectId: "proj-1",
      sceneId: "scene-1",
      prepareToken: "stale-prepare-token",
      orderedReferences: resolved.orderedReferences,
    });

    expect(attachResult.fenced).toBe(true);
    expect(attachResult.attachedStorageKeys).toHaveLength(2);
    for (const key of attachResult.attachedStorageKeys) {
      expect(key.startsWith("projects/proj-1/")).toBe(true);
    }
  });
});
