// The thumbnail transform, and the two hand-kept copies of it.
//
// WHAT THIS FILE EXISTS FOR. On 2026-09-09 the first real video ever uploaded
// to production went through the whole pipeline correctly — stored, described
// by kie for $0.0002, named @new_video1 — and the operator saw an error page
// instead of a card, because the reference panel asked Supabase to resize an
// MP4:
//
//   signedUrl: a transform was requested for
//   "projects/.../video_ref/....mp4", which this file does not recognize as
//   an image (expected one of: png, webp, gif, jpg, jpeg)
//
// The line responsible read `asset.kind === "audio" ? undefined : TRANSFORM`.
// That is a DENYLIST, and it was correct for exactly as long as audio was the
// only thing a picture could be instead of. 0093 added a third kind and the
// else branch swallowed it.
//
// The same mistake had already been made and fixed twice in actions/ugc.ts
// (firstTaggedImageElementId, attachSceneReferences), both times by replacing
// "not audio" with the IMAGE_ASSET_KINDS allowlist. This was the third site,
// and the only one no test reached.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The four positional arguments signedUrl takes, spelled out so the
 * assertions below can index them: key, ttl, transform, download filename.
 * Typing this as (key: string) alone made every `calls[0][2]` a type error
 * while still passing at runtime — the mock has to know the shape it is
 * standing in for.
 */
const signedUrl = vi.fn(
  async (
    key: string,
    _ttl?: number,
    _transform?: { width: number; resize: string; quality: number },
    _download?: string | boolean,
  ) => `https://signed.example/${key}`,
);

vi.mock("@/lib/storage", () => ({
  signedUrl: (...args: Parameters<typeof signedUrl>) => signedUrl(...args),
  extFromFilename: (key: string, fallback: string) => {
    const m = /\.([a-z0-9]+)$/i.exec(key);
    return m ? m[1] : fallback;
  },
}));

const { loadElementTags } = await import("./element-library");

type Row = {
  id: string;
  name: string;
  description: string | null;
  ai_description: string | null;
  category: string;
  asset_id: string;
  user_id: string;
};

type Asset = {
  id: string;
  storage_key: string;
  kind: string;
  duration_s?: number | null;
  deleted_at?: string | null;
};

/**
 * The two-query shape loadElementTags actually makes: elements, then the
 * assets those elements point at. Deliberately not a generic stub — a mock
 * that answered any query would let the function drift into asking for
 * something else and still pass.
 */
function fakeSupabase(rows: Row[], assets: Asset[]) {
  return {
    from(table: string) {
      if (table === "elements") {
        // THENABLE, not a promise-returning .order(). The real code chains
        // .select().order() and only then decides whether to add .eq(),
        // awaiting whichever it ends up with — so the builder has to survive
        // being awaited at two different points in the chain.
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          is: () => builder,
          order: () => builder,
          then: (resolve: (v: { data: Row[] }) => unknown) => resolve({ data: rows }),
        };
        return builder;
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        then: (resolve: (v: { data: Asset[] }) => unknown) => resolve({ data: assets }),
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function element(id: string, name: string, category: string, assetId: string): Row {
  return {
    id,
    name,
    description: "a description",
    ai_description: null,
    category,
    asset_id: assetId,
    user_id: "user-1",
  };
}

beforeEach(() => {
  signedUrl.mockClear();
});

describe("only a picture is sent through the image transform", () => {
  it("asks for no transform on a video", async () => {
    await loadElementTags(
      fakeSupabase(
        [element("el-1", "new_video1", "video", "a-1")],
        [{ id: "a-1", storage_key: "projects/p/video_ref/clip.mp4", kind: "video_ref" }],
      ),
      "user-1",
    );

    const transform = signedUrl.mock.calls[0]?.[2];
    expect(
      transform,
      "asked Supabase's image renderer to resize an MP4 — this is the production error verbatim",
    ).toBeUndefined();
  });

  it("asks for no transform on a voice clip", async () => {
    await loadElementTags(
      fakeSupabase(
        [element("el-1", "narrator", "audio", "a-1")],
        [{ id: "a-1", storage_key: "projects/p/audio/voice.mp3", kind: "audio" }],
      ),
      "user-1",
    );

    expect(signedUrl.mock.calls[0]?.[2]).toBeUndefined();
  });

  // THE OTHER HALF. Without this, deleting the transform entirely would pass
  // both tests above — and the grid would silently start serving full-size
  // originals as thumbnails.
  it("still transforms an actual picture", async () => {
    await loadElementTags(
      fakeSupabase(
        [element("el-1", "jen", "character", "a-1")],
        [{ id: "a-1", storage_key: "projects/p/character_ref/jen.jpg", kind: "character_ref" }],
      ),
      "user-1",
    );

    expect(
      signedUrl.mock.calls[0]?.[2],
      "stopped transforming pictures — every thumbnail is now a full-size download",
    ).toMatchObject({ width: 320, resize: "contain" });
  });

  it("transforms a generated image, which is a picture under a different kind", async () => {
    // generated_image is in IMAGE_ASSET_KINDS and is exactly the member an
    // "is it character_ref?" shortcut would drop.
    await loadElementTags(
      fakeSupabase(
        [element("el-1", "shot", "product", "a-1")],
        [{ id: "a-1", storage_key: "projects/p/generated_image/x.png", kind: "generated_image" }],
      ),
      "user-1",
    );

    expect(signedUrl.mock.calls[0]?.[2]).toMatchObject({ width: 320 });
  });
});

describe("a video reference carries its measured length", () => {
  it("passes duration_s through as durationS, or /create cannot price the render", async () => {
    const [video] = await loadElementTags(
      fakeSupabase(
        [element("el-1", "sample02_block", "video", "a-1")],
        [
          {
            id: "a-1",
            storage_key: "projects/p/video_ref/clip.mp4",
            kind: "video_ref",
            duration_s: 6.2,
          },
        ],
      ),
      "user-1",
    );

    expect(video?.durationS).toBe(6.2);
  });
});

describe("auto-filed generated images", () => {
  const gen = (id: string, assetId: string) => element(id, `img_${id}`, "image", assetId);
  const ref = (id: string, assetId: string) => element(id, `ref_${id}`, "image", assetId);
  const assets: Asset[] = [
    { id: "g1", storage_key: "u/generated_image/1.png", kind: "generated_image" },
    { id: "r1", storage_key: "u/ref_frame/1.png", kind: "ref_frame" },
    {
      id: "g2",
      storage_key: "u/generated_image/2.png",
      kind: "generated_image",
      deleted_at: "2026-10-30T00:00:00Z",
    },
  ];

  it("lists the operator's own references before auto-filed images", async () => {
    const out = await loadElementTags(
      fakeSupabase([gen("a", "g1"), ref("b", "r1")], assets),
      "user-1",
    );
    expect(out.map((e) => e.name)).toEqual(["ref_b", "img_a"]);
  });

  it("leaves out an image that is in Bin", async () => {
    const out = await loadElementTags(
      fakeSupabase([gen("a", "g1"), gen("c", "g2")], assets),
      "user-1",
    );
    expect(out.map((e) => e.name)).toEqual(["img_a"]);
  });
});

describe("a download keeps the extension the file actually has", () => {
  it("names a video download .mp4 when the key cannot say so itself", async () => {
    // ownerId null is the library page, the only caller that mints a
    // downloadUrl. The key deliberately has no extension: that is the one
    // branch where the fallback decides, and where a video used to be
    // handed "png".
    await loadElementTags(
      fakeSupabase(
        [element("el-1", "new_video1", "video", "a-1")],
        [{ id: "a-1", storage_key: "projects/p/video_ref/clip", kind: "video_ref" }],
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
    );

    const downloadCall = signedUrl.mock.calls.find((call) => typeof call[3] === "string");
    expect(downloadCall?.[3], "a video downloaded as new_video1.png opens in nothing").toBe(
      "new_video1.mp4",
    );
  });
});

/**
 * THE OTHER COPY, WHICH IS THE ONE THAT ACTUALLY BROKE.
 *
 * ugc/[id]/page.tsx carries an inline duplicate of loadElementTags, kept in
 * step by hand — element-library.ts's own header says so. Everything above
 * this line tests the library copy. The production error came from the PAGE
 * copy, and would still have come from it with every test above green.
 *
 * A behavioural test cannot reach that copy cheaply: it is a server component
 * that awaits requireProjectReadable, a Supabase session client and a budget
 * snapshot before it ever reaches the loop. So this reads the source instead
 * and asserts the shape — a weaker check than the ones above, and the honest
 * one to have, because the alternative is no check at all on the file that
 * failed.
 *
 * Scanned, not pinned to a line number: a hardcoded pointer in version.test.ts
 * has gone stale twice in this codebase already.
 */
describe("the hand-kept copy in ugc/[id]/page.tsx agrees", () => {
  const source = readFileSync(join(process.cwd(), "app/(app)/ugc/[id]/page.tsx"), "utf8");

  it("decides the thumbnail transform from the allowlist", () => {
    expect(
      source.includes("IMAGE_ASSET_KINDS.has(asset.kind)"),
      "the /ugc copy no longer reads IMAGE_ASSET_KINDS — if it went back to " +
        'kind === "audio", the reference panel throws on any video and the ' +
        "whole page 500s, which is exactly what shipped on 2026-09-09",
    ).toBe(true);
  });

  it("never asks for a transform on the not-audio branch", () => {
    // The precise text of the bug, asserted as its own case so the failure
    // names the shape rather than merely the absence of a helper.
    expect(
      /isAudioAsset\s*\?\s*undefined\s*:\s*ELEMENT_THUMBNAIL_TRANSFORM/.test(source),
      "the denylist ternary is back in /ugc — a video takes the else branch " +
        "and Supabase is asked to resize an MP4",
    ).toBe(false);
  });
});
