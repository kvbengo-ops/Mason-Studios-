// The two defects an audit found in this file, pinned so they cannot come
// back, plus the invariants around them.
//
// Both were silent. Neither broke a build, a type, or any existing test —
// which is the whole argument for this file existing at all:
//
//   1. RenderSettingsOverrideSchema is the RETRY path's shape and carries
//      `model` alone. generateClip passed it `{ model, resolution }`; zod
//      stripped the resolution and returned SUCCESS. The clip was written
//      with no resolution, the merge fell back to Seedance's default 480p —
//      the tier lib/kie/offerable.ts refuses because nobody has been billed
//      for it — and the spend cap checked that tier while the operator had
//      been quoted 720p.
//
//   2. createClipProject inserted without `kind`, so every clip project took
//      the column default 'scripted' and its title in the /projects table
//      opened the six-step wizard. That is precisely the defect
//      0064_project_kind.sql was written to close, reintroduced one insert
//      later.
//
// These are unit tests over the pure decisions, not an integration harness:
// the guards, the Supabase client and storage are mocked, because what failed
// was never the database — it was what this file decided to send it.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { RenderSettingsOverrideSchema, mergeRenderSettings, getModel } from "@/lib/models";
import { offerable } from "@/lib/kie/offerable";
import { rateFor, videoRateFor } from "@/lib/kie/rates";
import type * as StorageModule from "@/lib/storage";

describe("RenderSettingsOverrideSchema refuses what it does not understand", () => {
  it("rejects a resolution instead of silently dropping it", () => {
    // The exact call generateClip used to make. Before .strictObject this
    // returned { success: true, data: { model } } — a validator answering
    // "yes" to a shape it does not understand, which is worse than no
    // validator at all.
    const result = RenderSettingsOverrideSchema.safeParse({
      model: "seedance-2.5",
      resolution: "720p",
    });
    expect(result.success).toBe(false);
  });

  it("still accepts the retry path's own shape", () => {
    // The schema's actual job, unchanged: retryScene and retryAllFailed pass
    // a model and nothing else.
    expect(RenderSettingsOverrideSchema.safeParse({ model: "seedance-2.5" }).success).toBe(true);
  });
});

describe("the override /ugc writes survives the merge", () => {
  it("keeps the resolution the operator was quoted", () => {
    // The failure was not in the merge — it was that resolution never
    // reached it. This pins the whole path: the shape generateClip builds,
    // merged against a UGC project's untouched (empty) render_settings.
    const override = { model: "seedance-2.5", resolution: "720p" };
    const merged = mergeRenderSettings({}, override);
    expect(merged.model).toBe("seedance-2.5");
    expect(merged.resolution).toBe("720p");
  });

  it("would otherwise fall back to a tier this route refuses to sell", () => {
    // Why the bug mattered rather than merely being untidy. With the
    // resolution stripped, the merge falls through to the model's own
    // default — and for Seedance that default is the one tier offerable()
    // exists to keep unsellable.
    const fellBack = mergeRenderSettings({}, { model: "seedance-2.5" });
    const defaulted = getModel("seedance-2.5").defaultResolution;
    expect(fellBack.resolution).toBe(defaulted);

    const sellable = offerable(false).some(
      (offer) => offer.model.id === "seedance-2.5" && offer.resolution === defaulted,
    );
    const rate = rateFor("seedance-2.5", defaulted, false);
    // Either the default tier is unsellable (the state that made this a bug),
    // or someone has since measured it — in which case this test should be
    // read again rather than deleted, because the fallback is only safe while
    // the two agree.
    if (!sellable) {
      expect(rate?.provenance).toBe("published");
    }
  });
});

describe("every model/resolution pair /ugc offers has a rate", () => {
  it("has a real, positive rate behind it", () => {
    // offerable() is the real validator on this route — a stronger check than
    // any shape schema, because it asks whether the PRICE is real rather than
    // whether the field is present.
    //
    const offers = offerable(false);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      const rate = rateFor(offer.model.id, offer.resolution, false);
      expect(
        rate,
        `${offer.model.label} ${offer.resolution} is offered with no rate`,
      ).not.toBeNull();
      expect(rate!.creditsPerSecond).toBeGreaterThan(0);
    }
  });
});

describe("createClipProject", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("stamps kind: 'clip' so the title opens the clip console", async () => {
    // The insert is captured rather than asserted through a live database:
    // what failed was the object this file builds, and nothing about
    // Postgres was involved in getting it wrong.
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: async () => ({ data: { id: "proj-1" }, error: null }) }),
    });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({}),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({}),
      createAdminClient: () => ({ from: () => ({ insert }) }),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
    vi.doMock("next/navigation", () => ({
      redirect: (to: string) => {
        // redirect() throws in Next; the throw IS the success path here.
        throw new Error(`REDIRECT:${to}`);
      },
    }));

    const { createClipProject } = await import("./ugc");
    await expect(createClipProject()).rejects.toThrow(/REDIRECT:\/ugc\/proj-1/);

    expect(insert).toHaveBeenCalledTimes(1);
    const written = insert.mock.calls[0]![0] as { kind?: string; user_id: string };
    expect(
      written.kind,
      "a clip project created without kind takes the 'scripted' default and its title opens the wizard",
    ).toBe("clip");
    expect(written.user_id).toBe("user-1");
  });
});

// ---------------------------------------------------------------------------
// generateClip: gate first, write second.
//
// This function's own header calls that ordering load-bearing, and says why
// it is NOT enqueueScene's ordering: enqueueScene validates a scene that
// already exists, while this call creates the scene it is about to render. So
// a refusal here must leave nothing behind — no orphan scene row, no uploaded
// image, no copied asset. Nothing in the type system enforces an ordering,
// and nothing in an integration test would notice a refusal that also
// happened to write: the operator sees the error either way.
//
// Each test below therefore asserts two things about a refusal — the message
// the operator gets, AND that the write surfaces were never touched.
// ---------------------------------------------------------------------------

/** An offered model/resolution pair, read from the same table the route uses. */
// Seedance 2.5 on BytePlus at 480p: the one pair /ugc sells that is not Kling. The first
// offerable pair is Kie's retired seedance-2.5, which generateClip now moves to this one.
function firstOffer() {
  const first = offerable(false).find(
    (o) => o.model.id === "seedance-2.5-byteplus" && o.resolution === "480p",
  );
  if (!first) throw new Error("seedance-2.5-byteplus/480p is not offerable — nothing to render");
  return first;
}

function anOfferedPair() {
  const first = firstOffer();
  return { modelId: first.model.id, resolution: first.resolution };
}

function aClipForm(overrides: Record<string, string | File> = {}): FormData {
  const { modelId, resolution } = anOfferedPair();
  const form = new FormData();
  form.set("projectId", "proj-1");
  form.set("prompt", "A cat knocks a glass off a table.");
  form.set("durationS", "8");
  form.set("modelId", modelId);
  form.set("resolution", resolution);
  form.set("image", new File([new Uint8Array([1, 2, 3])], "ref.png", { type: "image/png" }));
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  return form;
}

/**
 * Mocks every module generateClip could write through, and hands back the
 * spies so a test can assert none of them ran.
 *
 * `capRefusal` is the knob: null lets the cap pass, an ActionResult refuses.
 */
function mockWriteSurfaces(opts: {
  /** The caller's profiles.team; default none. */
  team?: string | null;
  capRefusal?: { error: string } | null;
  element?: { asset_id: string; user_id: string } | null;
  /**
   * The operator's saved references, for the two paths that read the WHOLE
   * elements table rather than one row — resolveElementTags and
   * unknownElementTags. Both await the builder directly, so without this the
   * stub hands them the builder object and they see `data === undefined`,
   * take their "a failed lookup must not block a render" branch, and quietly
   * do nothing. Opt-in, so every existing test keeps that behaviour.
   */
  elementNames?: {
    name: string;
    description?: string | null;
    /**
     * What the element's file IS, for the tag-as-conditioning-frame lookup.
     * Defaults to a picture; "audio" makes it one an MP3 tag would name,
     * which must never be adopted as a frame.
     */
    assetKind?: string;
    /**
     * The reference's own length, for "video_ref" fixtures. A video's
     * seconds are billed on top of the clip's, so this is what the cap
     * check has to see — null spells an upload the browser could not
     * measure, which must make the whole quote unpriceable rather than
     * free.
     */
    durationS?: number | null;
  }[];
  /**
   * What the PICKED element's source asset is. The primary-reference path
   * reads both, and reading only storage_key is how a picked MP3 reached kie
   * in reference_image_urls.
   */
  sourceAssetKind?: string;
  sourceStorageKey?: string;
  /**
   * Per-id overrides for the SINGLE-row `elements`/`assets` reads (`.eq("id",
   * ...).maybeSingle()`), keyed by the id actually queried. `element` and
   * `sourceAssetKind`/`sourceStorageKey` above answer every such read the
   * same way regardless of which id was asked for — fine for a test that
   * only ever resolves one id, but blind to WHICH of several tagged elements
   * a caller actually picked. These two fill that gap without disturbing any
   * test that does not set them: a queried id absent from the map falls
   * through to the id-blind defaults above.
   */
  elementsById?: Record<string, { asset_id: string; user_id: string }>;
  assetsById?: Record<string, { kind: string; storage_key: string }>;
}) {
  // The inserted scene comes back with the columns the two post-insert guards
  // read (assertAllFramed, assertNotAlreadySpent), because generateClip runs
  // them against the row it just wrote. Returning a bare { id } made every
  // test that inspects the RETURN VALUE see "1 of 1 scene(s) do not have a
  // reference frame yet" instead of whatever it was asserting — invisible
  // until now only because the older tests read the insert spy and ignored
  // what generateClip handed back.
  const insert = vi.fn().mockReturnValue({
    select: () => ({
      single: async () => ({
        data: {
          id: "scene-1",
          ref_frame_asset_id: "asset-1",
          clip_asset_id: null,
          status: "frame_ready",
        },
        error: null,
      }),
    }),
  });
  const uploadFile = vi.fn(async () => ({ storageKey: "projects/proj-1/ref_frame/x.png" }));
  // Typed with its real two-arg signature (rather than inferred as a bare
  // `() => Promise<void>`) so a test can override it with an implementation
  // that reads `from` to decide which call to delay — see the ordinal-race
  // test in the concurrency describe block below.
  const copyStorageObject = vi.fn(async (_from: string, _to: string) => {});
  const assertWithinSpendCaps = vi.fn(async () => opts.capRefusal ?? null);

  vi.doMock("@/actions/guard", () => ({
    requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
    requireProject: async () => ({
      project: { id: "proj-1", render_settings: {} },
      user: { id: "user-1" },
      profile: { team: opts.team ?? null },
    }),
    requireScene: async () => ({}),
  }));
  vi.doMock("@/lib/spend", () => ({ assertWithinSpendCaps }));
  vi.doMock("@/lib/storage", () => ({
    resolveStagedUploads: async () => {},
    uploadFile,
    copyStorageObject,
    buildStorageKey: () => "projects/proj-1/ref_frame/x.png",
    // THE REAL LOGIC, not a hardcoded "png" — this used to be a constant
    // stub, which made every refuseIfNotOwnedImageElement webp check in this
    // file see "png" regardless of the fixture's own storage_key and pass
    // when it should have refused. Same regex lib/storage.ts's own
    // extFromFilename uses.
    extFromFilename: (filename: string, fallback: string) =>
      (/\.([a-zA-Z0-9]+)$/.exec(filename)?.[1] ?? fallback).toLowerCase(),
  }));
  // A chainable stub shaped like postgrest-js: every filter/modifier returns
  // the builder, and only the terminal reads resolve. Built per-table so the
  // element lookup can hand back somebody else's row without that leaking
  // into the scene reads.
  //
  // Deliberately NOT a permissive catch-all: a stub that answered every
  // method would let a reordering slip past by resolving a call the real
  // client would have rejected. If generateClip grows a query this does not
  // model, that must surface here as a failure rather than a pass.
  // `idFilter` is whatever the LAST `.eq()` on this particular chain was
  // called with — `undefined` for a test that never sets elementsById/
  // assetsById, which is exactly the id-blind behaviour every existing test
  // already depends on.
  const rowFor = (table: string, idFilter: unknown) => {
    if (table === "elements") {
      if (opts.elementsById && typeof idFilter === "string" && idFilter in opts.elementsById) {
        return opts.elementsById[idFilter];
      }
      return opts.element === undefined ? null : opts.element;
    }
    if (table === "assets") {
      if (opts.assetsById && typeof idFilter === "string" && idFilter in opts.assetsById) {
        return opts.assetsById[idFilter];
      }
      return {
        storage_key: opts.sourceStorageKey ?? "projects/other/ref_frame/src.png",
        kind: opts.sourceAssetKind ?? "ref_frame",
      };
    }
    if (table === "scenes") return { idx: 0 };
    return null;
  };
  const builderFor = (table: string) => {
    const builder: Record<string, unknown> = { insert };
    // Captured per call to `.from(table)` — builderFor runs fresh for every
    // one, so this cannot leak the id from one query into a different one.
    let idFilter: unknown;
    for (const chain of ["select", "order", "limit", "update", "delete", "in", "is"]) {
      builder[chain] = () => builder;
    }
    // The one filter every single-row read in this file actually uses is
    // `.eq("id", ...)`. Recording the value (not just returning `builder`
    // like the other chain methods) is what lets elementsById/assetsById
    // answer differently per id instead of the same fixed row regardless of
    // which one was asked for.
    builder.eq = (_column: string, value: unknown) => {
      idFilter = value;
      return builder;
    };
    builder.maybeSingle = async () => ({ data: rowFor(table, idFilter), error: null });
    builder.single = async () => ({ data: rowFor(table, idFilter), error: null });
    // A LIST read, which postgrest-js serves by making the builder itself
    // awaitable. Only the elements table gets one, and only when a test asked
    // for it: leaving `then` undefined everywhere else is what keeps an
    // unmodelled query failing loudly instead of resolving to something
    // plausible.
    builder.then =
      table === "elements" && opts.elementNames !== undefined
        ? (resolve: (v: unknown) => void) =>
            resolve({
              data: opts.elementNames!.map((e) => ({
                // id and asset_id are what firstTaggedImageElementId reads;
                // the other consumers of this list ignore them.
                id: `el-${e.name}`,
                asset_id: `asset-${e.name}`,
                name: e.name,
                description: e.description ?? null,
                ai_description: null,
              })),
              error: null,
            })
        : table === "assets" && opts.elementNames !== undefined
          ? // The kinds behind those elements, read as a list by the same
            // lookup. Without this it sees no rows, and a helper that treated
            // "unknown" as "picture" would adopt an MP3 as the frame.
            (resolve: (v: unknown) => void) =>
              resolve({
                data: opts.elementNames!.map((e) => ({
                  id: `asset-${e.name}`,
                  kind: e.assetKind ?? "ref_frame",
                  duration_s: e.durationS ?? null,
                })),
                error: null,
              })
          : undefined;
    return builder;
  };
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: async () => ({}),
    createAdminClient: () => ({ from: (table: string) => builderFor(table) }),
  }));
  vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
  vi.doMock("next/navigation", () => ({ redirect: () => {} }));
  vi.doMock("@/actions/enqueue", () => ({
    openSceneVersion: async () => ({}),
    rerenderScene: async () => ({}),
  }));

  return { insert, uploadFile, copyStorageObject, assertWithinSpendCaps };
}

describe("generateClip takes the conditioning frame from a tag", () => {
  // REPORTED FROM PRODUCTION. An operator pasted a prompt whose every @tag
  // resolved against their library, pressed Generate, and was told to attach
  // an image or pick a saved reference. The way through was to upload a dummy
  // picture — which is not a workaround: the conditioning frame is the one
  // image the model actually looks at, so the dummy made the render worse in
  // exactly the way the tags were meant to prevent.
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("accepts a prompt that tags a saved picture, with nothing attached", async () => {
    const { insert } = mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "@jen holds the bottle to camera");

    const result = await generateClip(form);

    // The success path returns the new scene's id (so the caller can select
    // it) rather than nothing, so "no error, and a sceneId" is the
    // assertion, and the scene insert is the proof it got that far.
    expect(result ?? {}).not.toHaveProperty("error");
    expect((result as { sceneId?: string })?.sceneId).toBe("scene-1");
    expect(insert).toHaveBeenCalled();
  });

  it("still refuses when the only tag names a voice", async () => {
    // An MP3 cannot be a conditioning frame, and adopting one would be a
    // silent wrong render where refusing is a visible one.
    mockWriteSurfaces({
      element: { asset_id: "asset-anny", user_id: "user-1" },
      elementNames: [{ name: "anny", assetKind: "audio" }],
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "she says it in @anny's voice");

    const result = await generateClip(form);

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/@tag one in the prompt/);
  });

  it("queues a video-only prompt WITHOUT making the video the frame", async () => {
    // Seedance's multimodal reference mode takes a video with no picture
    // (kie's bytedance/seedance-2-5 schema, read 2026-11-06), so this now
    // succeeds. What still matters is the bug 0093 pinned:
    // firstTaggedImageElementId once adopted any kind that merely was not
    // audio, putting an .mp4 in the conditioning-frame slot. Reverting the
    // allowlist to that denylist would store the video as a ref_frame asset
    // and set ref_frame_asset_id — both asserted absent below. The video is
    // still copied in and attached (as video_ref) through scene_references,
    // so copyStorageObject is NOT a usable signal here.
    const spies = mockWriteSurfaces({
      element: { asset_id: "asset-clip1", user_id: "user-1" },
      elementNames: [
        { name: "clip1", description: "a product demo", assetKind: "video_ref", durationS: 4.064 },
      ],
      // The single-row assets read (the reference attach) must answer as the
      // video it is — the mock's id-blind default is a picture, which would
      // make the ref_frame assertion below fail for the mock's reason, not
      // the product's.
      sourceAssetKind: "video_ref",
      sourceStorageKey: "projects/other/video_ref/clip1.mp4",
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "styled like @clip1");

    const result = await generateClip(form);

    expect(result ?? {}).not.toHaveProperty("error");
    expect(spies.insert).toHaveBeenCalledWith(
      expect.objectContaining({ ref_frame_asset_id: null }),
    );
    expect(spies.insert, "the video was stored as a conditioning frame").not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ref_frame" }),
    );
  });

  it("skips a tagged video and falls through to a tagged picture later in the same prompt", async () => {
    // THE STRONGER VERSION of the refusal test above: a video tag must not
    // just fail to qualify on its own, it must not swallow the picture tag
    // that follows it either. The old code returned on the FIRST tag that
    // was merely "not audio", so with @clip1 written before @lena it would
    // have adopted the video and never looked at the picture at all.
    //
    // elementsById/assetsById (not element/sourceAssetKind) because this
    // needs the SINGLE-row elements/assets reads to answer differently
    // depending on WHICH element's id generateClip actually resolved to —
    // the id-blind opts those two shared config keys support forward to would
    // hand back the same row whichever tag won, which is exactly the
    // distinction this test exists to make.
    const spies = mockWriteSurfaces({
      elementNames: [
        { name: "clip1", description: "a product demo", assetKind: "video_ref" },
        { name: "lena", description: "a woman with blonde hair", assetKind: "ref_frame" },
      ],
      elementsById: {
        "el-clip1": { asset_id: "asset-clip1", user_id: "user-1" },
        "el-lena": { asset_id: "asset-lena", user_id: "user-1" },
      },
      assetsById: {
        "asset-clip1": { storage_key: "projects/other/video_ref/clip1.mp4", kind: "video_ref" },
        "asset-lena": { storage_key: "projects/other/ref_frame/lena.png", kind: "ref_frame" },
      },
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "@clip1 styling, @lena walks in");

    const result = await generateClip(form);
    expect(result ?? {}).not.toHaveProperty("error");
    expect((result as { sceneId?: string })?.sceneId).toBe("scene-1");

    // The PRIMARY reference actually copied has to be lena's picture, not
    // clip1's video. buildStorageKey and the assets insert are both fixed
    // stubs here (they don't vary with which id was resolved), so the
    // source argument copyStorageObject was called with is the one place
    // left that reveals which element actually won — kind itself can't be
    // read off the write, because the (separate, pre-existing) `sourceAsset.
    // kind === "audio" ? "audio" : "image"` line a few frames up from here
    // would happily mislabel either winner "image". The PRIMARY copy is
    // always the first call chronologically — generateClip copies the
    // resolved element before it ever inserts the scene, and
    // attachSceneReferences' own tag-loop copy (below) cannot run until
    // after that insert succeeds — so call order, not merely "was it called
    // at all", is what actually proves which element won the primary slot.
    expect(spies.copyStorageObject.mock.calls[0]).toEqual([
      "projects/other/ref_frame/lena.png",
      "projects/proj-1/ref_frame/x.png",
    ]);

    // clip1 IS copied too, now — this stopped being "never" on
    // 0094_video_scene_reference.sql. Before it, video had no path into
    // scene_references at all, so a tagged video that lost the primary slot
    // was copied nowhere and this assertion read `.not.toHaveBeenCalledWith`.
    // Since 0094, @clip1 is a SECOND, independent tag in this same prompt —
    // exactly like an @image or @audio tag that is not the primary — and
    // attachSceneReferences' tag loop now gives it its own 'video'
    // scene_references row. That is not a regression of the assertion
    // above: clip1 still never becomes the conditioning frame (proved by
    // the first-call check), it now also gets attached as an additional
    // reference the way it always should have once 0094 made that legal.
    expect(spies.copyStorageObject).toHaveBeenCalledWith(
      "projects/other/video_ref/clip1.mp4",
      expect.anything(),
    );
  });

  it("queues prompt-only when the prompt tags nothing at all", async () => {
    const spies = mockWriteSurfaces({ elementNames: [{ name: "jen" }] });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "a woman holds a bottle to camera");

    const result = await generateClip(form);

    expect(result ?? {}).not.toHaveProperty("error");
    expect(spies.copyStorageObject).not.toHaveBeenCalled();
  });
});

describe("generateClip refuses without writing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("does not create a scene or upload an image when the spend cap refuses", async () => {
    // THE test in this file. Every other refusal below happens before any
    // async work at all; this one happens after the estimate, one line above
    // the write phase, which is the only place the ordering could actually
    // have been got wrong.
    const spies = mockWriteSurfaces({ capRefusal: { error: "Daily cap reached." } });

    const { generateClip } = await import("./ugc");
    const result = await generateClip(aClipForm());

    expect(
      spies.insert,
      "a capped request wrote a scene row — the refusal leaves an orphan behind",
    ).not.toHaveBeenCalled();
    expect(
      spies.uploadFile,
      "a capped request uploaded the image — the refusal leaves a paid-for object behind",
    ).not.toHaveBeenCalled();
    expect(
      spies.assertWithinSpendCaps,
      "the cap must actually have been consulted, not skipped into a pass",
    ).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ error: "Daily cap reached." });
  });

  it("moves a submission for retired Kie seedance-2.5 to BytePlus 480p, quality high", async () => {
    const spies = mockWriteSurfaces({});

    const { generateClip } = await import("./ugc");
    await generateClip(aClipForm({ modelId: "seedance-2.5", resolution: "1080p" }));

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    expect(sceneCall, "no scene row was inserted at all").toBeTruthy();
    expect(
      (sceneCall![0] as { render_settings_override?: unknown }).render_settings_override,
    ).toEqual({ model: "seedance-2.5-byteplus", resolution: "480p", quality: "high" });
  });

  it("refuses BytePlus Seedance at any resolution but 480p, before consulting the cap", async () => {
    const spies = mockWriteSurfaces({});

    const { generateClip } = await import("./ugc");
    const result = await generateClip(
      aClipForm({ modelId: "seedance-2.5-byteplus", resolution: "720p" }),
    );

    expect(result?.error).toMatch(/480p only/i);
    expect(spies.assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses a model the caller's team may not use, before consulting the cap", async () => {
    const spies = mockWriteSurfaces({ team: "hybrid_editor" });

    const { generateClip } = await import("./ugc");
    const result = await generateClip(aClipForm({ modelId: "wan-3.0", resolution: "480P" }));

    expect(result?.error).toMatch(/not available to your team/i);
    expect(spies.assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses a prompt over the 20,000 character cap, Seedance included", async () => {
    const spies = mockWriteSurfaces({});

    const { generateClip } = await import("./ugc");
    const result = await generateClip(aClipForm({ prompt: "a".repeat(20_001) }));

    expect(result?.error).toMatch(/20,000/);
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses a model/resolution pair it may not sell, before consulting the cap", async () => {
    // offerable() is a stronger check than a shape schema: it asks whether
    // the price is REAL, not whether the field exists. A pair that slipped
    // past it would be priced against a rate nobody has been billed, which
    // is the exact failure that pulled Seedance 1080p from the product.
    const spies = mockWriteSurfaces({});

    const { generateClip } = await import("./ugc");
    const result = await generateClip(
      aClipForm({ modelId: "bytedance/seedance-2-5", resolution: "2160P" }),
    );

    expect(result?.error, "an unsellable pair must be named, not silently substituted").toMatch(
      /not offered/i,
    );
    expect(spies.assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("queues a prompt-only clip without uploading or inventing a reference asset", async () => {
    const spies = mockWriteSurfaces({});
    const form = aClipForm();
    form.delete("image");

    const { generateClip } = await import("./ugc");
    const result = await generateClip(form);

    expect(result?.error).toBeUndefined();
    expect(spies.uploadFile).not.toHaveBeenCalled();
    expect(spies.copyStorageObject).not.toHaveBeenCalled();
    expect(spies.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        video_prompt: "A cat knocks a glass off a table.",
        ref_frame_asset_id: null,
      }),
    );
    expect(spies.insert).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "ref_frame" }));
    expect(spies.assertWithinSpendCaps).toHaveBeenCalled();
  });

  it("still applies spend caps to prompt-only generation before writing", async () => {
    const spies = mockWriteSurfaces({ capRefusal: { error: "Cap reached." } });
    const form = aClipForm();
    form.delete("image");
    const { generateClip } = await import("./ugc");
    expect(await generateClip(form)).toEqual({ error: "Cap reached." });
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("still requires an image for an image-only endpoint", async () => {
    const spies = mockWriteSurfaces({});
    const form = aClipForm({ modelId: "gemini-omni-video" });
    form.delete("image");
    const { generateClip } = await import("./ugc");
    expect((await generateClip(form))?.error).toMatch(/attach a picture/i);
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses a file that is not a JPG, PNG or WebP", async () => {
    const spies = mockWriteSurfaces({});
    const form = aClipForm({
      image: new File([new Uint8Array([1])], "clip.mp4", { type: "video/mp4" }),
    });

    const { generateClip } = await import("./ugc");
    const result = await generateClip(form);

    expect(result?.error).toMatch(/not a JPG, PNG or WebP/i);
    expect(spies.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses another user's saved reference and writes nothing", async () => {
    // elements RLS would filter a stranger's row to nothing on the read, but
    // "filtered to nothing" and "not found" are the same shape, so the route
    // compares user_id explicitly to turn a forged elementId into a clear
    // refusal. This asserts the compare, not the policy.
    const spies = mockWriteSurfaces({
      element: { asset_id: "asset-9", user_id: "somebody-else" },
    });
    const form = aClipForm({ elementId: "element-1" });
    form.delete("image");

    const { generateClip } = await import("./ugc");
    const result = await generateClip(form);

    expect(result?.error).toMatch(/no longer available/i);
    expect(
      spies.copyStorageObject,
      "a forged elementId copied another user's image into this project",
    ).not.toHaveBeenCalled();
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses a clip length that is not a positive whole number", async () => {
    const spies = mockWriteSurfaces({});

    const { generateClip } = await import("./ugc");
    const result = await generateClip(aClipForm({ durationS: "0" }));

    expect(result?.error).toMatch(/clip length/i);
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses an empty prompt — it is the whole instruction the model gets", async () => {
    const spies = mockWriteSurfaces({});

    const { generateClip } = await import("./ugc");
    const result = await generateClip(aClipForm({ prompt: "   " }));

    expect(result?.error).toMatch(/write a prompt/i);
    expect(spies.insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// regenerateClip and setActiveVersion.
//
// Both are one-line decisions with a destructive wrong answer, and neither had
// a test. regenerateClip picks between keeping the standing clip and DELETING
// it; setActiveVersion decides whether a version id is allowed to repoint a
// scene it does not belong to. In both cases the wrong branch runs silently
// and looks like success.
// ---------------------------------------------------------------------------

/**
 * Mocks the two actions' shared dependencies and returns the write spies.
 *
 * The scene_versions stub HONOURS the .eq() filters rather than handing back
 * a row regardless. That is the difference between testing the `if (!version)`
 * line and testing the thing that actually protects the scene: the read is
 * scoped `.eq("scene_id", scene.id)`, and it is that scope, not the null
 * check, which stops a version id from another scene resolving at all. A stub
 * that ignored the filters would pass with the scoping deleted.
 */
function mockSceneSurfaces(opts: {
  scene?: {
    id: string;
    project_id: string;
    video_prompt: string | null;
    ai_generated_prompt?: string | null;
    /**
     * scenes.status. Defaults to "done" below — the state regenerateClip's
     * whole reason for existing (an already-rendered clip getting another
     * attempt) assumes — so only a test that means to exercise the in-flight
     * guard needs to pass this.
     */
    status?: string;
  };
  /** Rows that exist in scene_versions, each carrying the scene it belongs to. */
  versions?: { id: string; scene_id: string }[];
  /**
   * The operator's saved references, read by resolveElementTags the same way
   * mockWriteSurfaces feeds generateClip's copy of that call. Opt-in, same
   * reasoning as there: a test that does not pass this sees `data ===
   * undefined` off the elements table and resolveElementTags's own "a failed
   * lookup must not block a render" branch hands the prompt back unchanged.
   */
  elementNames?: {
    name: string;
    description?: string | null;
    assetKind?: string;
  }[];
  /**
   * Kling's own single-row reads — regenerateClip's copy of what
   * mockWriteSurfaces' elementsById/assetsById answer for generateClip.
   * Opt-in: every pre-existing test in this suite reads neither table by a
   * single id, so leaving this undefined keeps their `{ data: null }`
   * behaviour exactly as it was.
   */
  elementsById?: Record<string, { asset_id: string; user_id: string }>;
  assetsById?: Record<string, { kind: string; storage_key: string }>;
}) {
  const scene = {
    status: "done",
    ref_frame_asset_id: "asset-1",
    ...(opts.scene ?? {
      id: "scene-1",
      project_id: "proj-1",
      video_prompt: "the prompt already on the row",
    }),
  };
  const versions = opts.versions ?? [];
  const update = vi.fn().mockReturnValue({ eq: async () => ({ error: null }) });
  const rerenderScene = vi.fn(async () => undefined);
  // regenerateClip's own FAILED-scene branch (see its doc comment) calls
  // this instead of rerenderScene — mocked the same id-blind way, so a test
  // that never sets a status "failed" scene keeps seeing it uncalled, same
  // as every pre-existing test in this file.
  const retryScene = vi.fn(async () => undefined);
  // ONE SPY FOR EVERY TABLE'S insert(), same shape mockWriteSurfaces uses:
  // scene_references' own insert(rows) never calls .select() and is simply
  // awaited (destructuring `error` off the plain returned object resolves
  // to undefined, which is the "no error" case), while an asset copy's
  // insert(...).select("id").single() needs a real id back.
  const insert = vi.fn((..._args: unknown[]) => ({
    select: () => ({
      single: async () => ({ data: { id: `new-asset-${insert.mock.calls.length}` }, error: null }),
    }),
  }));

  const builderFor = (table: string) => {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = { update, insert };
    builder.select = () => builder;
    builder.eq = (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    };
    builder.in = () => builder;
    builder.is = () => builder;
    builder.delete = () => builder;
    builder.maybeSingle = async () => {
      if (table === "elements" && opts.elementsById) {
        const id = filters.id;
        if (typeof id === "string" && id in opts.elementsById) {
          return { data: opts.elementsById[id], error: null };
        }
      }
      if (table === "assets" && opts.assetsById) {
        const id = filters.id;
        if (typeof id === "string" && id in opts.assetsById) {
          return { data: opts.assetsById[id], error: null };
        }
      }
      if (table !== "scene_versions") return { data: null, error: null };
      const match = versions.find((v) =>
        Object.entries(filters).every(
          (entry) => (v as unknown as Record<string, unknown>)[entry[0]] === entry[1],
        ),
      );
      return { data: match ?? null, error: null };
    };
    // resolveElementTags awaits the builder directly (postgrest-js serves a
    // LIST read that way) rather than calling .maybeSingle() — see
    // mockWriteSurfaces's own copy of this stub for the full reasoning.
    builder.then =
      table === "elements" && opts.elementNames !== undefined
        ? (resolve: (v: unknown) => void) =>
            resolve({
              data: opts.elementNames!.map((e) => ({
                id: `el-${e.name}`,
                asset_id: `asset-${e.name}`,
                name: e.name,
                description: e.description ?? null,
                ai_description: null,
              })),
              error: null,
            })
        : table === "assets" && opts.elementNames !== undefined
          ? (resolve: (v: unknown) => void) =>
              resolve({
                data: opts.elementNames!.map((e) => ({
                  id: `asset-${e.name}`,
                  kind: e.assetKind ?? "ref_frame",
                })),
                error: null,
              })
          : undefined;
    return builder;
  };

  vi.doMock("@/actions/guard", () => ({
    requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
    requireProject: async () => ({}),
    requireScene: async () => ({
      user: { id: "user-1" },
      profile: {},
      project: { id: "proj-1", render_settings: {} },
      scene,
    }),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: async () => ({}),
    createAdminClient: () => ({ from: (table: string) => builderFor(table) }),
  }));
  vi.doMock("@/actions/enqueue", () => ({
    openSceneVersion: async () => ({}),
    rerenderScene,
    retryScene,
  }));
  // Kling's own regenerateClip branch copies its Start frame into a fresh
  // ref_frame asset, the same storage calls generateClip's elementId branch
  // already needed a mock for (mockWriteSurfaces' own copy of this).
  vi.doMock("@/lib/storage", () => ({
    resolveStagedUploads: async () => {},
    uploadFile: async () => ({ storageKey: "projects/proj-1/ref_frame/x.png" }),
    copyStorageObject: async () => {},
    buildStorageKey: () => "projects/proj-1/ref_frame/x.png",
    // THE REAL LOGIC, not a hardcoded "png" — this used to be a constant
    // stub, which made every refuseIfNotOwnedImageElement webp check in this
    // file see "png" regardless of the fixture's own storage_key and pass
    // when it should have refused. Same regex lib/storage.ts's own
    // extFromFilename uses.
    extFromFilename: (filename: string, fallback: string) =>
      (/\.([a-zA-Z0-9]+)$/.exec(filename)?.[1] ?? fallback).toLowerCase(),
  }));
  vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
  vi.doMock("next/navigation", () => ({ redirect: () => {} }));

  return { update, insert, rerenderScene, retryScene, scene };
}

describe("regenerateClip chooses the non-destructive branch by default", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("renders a NEW version when versionMode is absent", async () => {
    // "update" deletes the clip currently standing. Absent input taking the
    // destructive branch would destroy a paid-for take on a press the
    // operator did not think was destructive.
    const spies = mockSceneSurfaces({});

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "a new instruction");
    await regenerateClip(form);

    expect(spies.rerenderScene).toHaveBeenCalledWith("scene-1", "new");
  });

  it('renders a NEW version for anything that is not exactly "update"', async () => {
    // The comparison is against the literal, so a typo, a truthy string, or a
    // stale value all have to land on the safe side rather than on whatever
    // JavaScript considers close enough.
    for (const value of ["Update", "UPDATE", "replace", "true", "1", ""]) {
      vi.resetModules();
      vi.clearAllMocks();
      const spies = mockSceneSurfaces({});

      const { regenerateClip } = await import("./ugc");
      const form = new FormData();
      form.set("sceneId", "scene-1");
      form.set("prompt", "a new instruction");
      form.set("versionMode", value);
      await regenerateClip(form);

      expect(
        spies.rerenderScene,
        `versionMode=${JSON.stringify(value)} took the destructive branch`,
      ).toHaveBeenCalledWith("scene-1", "new");
    }
  });

  it("replaces the standing version only on the exact literal", async () => {
    const spies = mockSceneSurfaces({});

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "a new instruction");
    form.set("versionMode", "update");
    await regenerateClip(form);

    expect(spies.rerenderScene).toHaveBeenCalledWith("scene-1", "update");
  });

  it("saves an edited prompt before rendering it", async () => {
    // The prompt is the whole instruction the model gets, so rendering the
    // old one after the operator edited it spends money on the wrong clip.
    const spies = mockSceneSurfaces({});

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "an edited instruction");
    await regenerateClip(form);

    expect(spies.update).toHaveBeenCalledWith({ video_prompt: "an edited instruction" });
    expect(spies.rerenderScene).toHaveBeenCalled();
  });

  it("does not write when the prompt is unchanged", async () => {
    const spies = mockSceneSurfaces({});

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "  the prompt already on the row  ");
    await regenerateClip(form);

    expect(
      spies.update,
      "an unchanged prompt still wrote — surrounding whitespace is not an edit",
    ).not.toHaveBeenCalled();
    expect(spies.rerenderScene).toHaveBeenCalled();
  });

  it("refuses an empty prompt without rendering", async () => {
    const spies = mockSceneSurfaces({});

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "   ");
    const result = await regenerateClip(form);

    expect(result?.error).toMatch(/write a prompt/i);
    expect(spies.rerenderScene).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// regenerateClip must refresh ai_generated_prompt, not just video_prompt.
//
// CONFIRMED IN PRODUCTION, 2026-08-30/2026-09. generateClip is the ONLY place
// in the app that ever wrote scenes.ai_generated_prompt, and the worker
// (worker/internal/loop/dispatch.go's promptForScene) prefers it over
// video_prompt whenever it is non-empty. regenerateClip wrote an edited
// video_prompt and stopped there, so a tagged scene's Regenerate button
// rendered the OLD substituted text forever — an operator paid ~$0.56 for a
// clip that came back byte-identical (5483 characters) to the one they had
// just edited away from, with nothing anywhere saying so.
//
// The fix recomputes ai_generated_prompt on EVERY regenerate, not only when
// video_prompt's text changed: an element's description can be written or
// edited long after its scene exists (voice elements described hours after
// the scenes that tag them were created), and gating the recompute on the
// prompt text would leave that scene's substitution stale too. It follows
// generateClip's own rule for the value — resolveElementTags over the
// CURRENT prompt, null when that equals the authored text — so a scene whose
// tags were removed stops carrying a stale substitution instead of keeping
// one forever.
// ---------------------------------------------------------------------------

describe("regenerateClip refreshes ai_generated_prompt, not just video_prompt", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("THE BUG: an edited tagged prompt is what gets stored as ai_generated_prompt, not the stale substitution from creation", async () => {
    const spies = mockSceneSurfaces({
      scene: {
        id: "scene-1",
        project_id: "proj-1",
        video_prompt: "@jen at a counter",
        // What generateClip wrote at creation time, off the OLD description.
        ai_generated_prompt: "a woman with a red scarf at a counter",
      },
      elementNames: [{ name: "jen", description: "a woman with a red scarf" }],
    });

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "@jen at a diner");
    await regenerateClip(form);

    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({
        video_prompt: "@jen at a diner",
        ai_generated_prompt: "a woman with a red scarf at a diner",
      }),
    );
  });

  it("recomputes off a description written AFTER the scene, even though the prompt text itself did not change", async () => {
    const spies = mockSceneSurfaces({
      scene: {
        id: "scene-1",
        project_id: "proj-1",
        video_prompt: "@voice1 narrates over the product",
        // Written when @voice1 had no description yet — resolveElementTags's
        // cheap "no @, hand it back" exit does not apply (there IS a tag),
        // but there was nothing to substitute, so the box text won and this
        // column was null.
        ai_generated_prompt: null,
      },
      elementNames: [{ name: "voice1", description: "a calm female voiceover" }],
    });

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    // Unchanged from scene.video_prompt on purpose: the operator pressed
    // Regenerate without touching the box at all.
    form.set("prompt", "@voice1 narrates over the product");
    await regenerateClip(form);

    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_generated_prompt: expect.stringContaining("a calm female voiceover"),
      }),
    );
    // video_prompt did not change, so it must not appear in the same write.
    expect(spies.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ video_prompt: expect.anything() }),
    );
  });

  it("clears ai_generated_prompt back to null once the tag it depended on is edited out", async () => {
    const spies = mockSceneSurfaces({
      scene: {
        id: "scene-1",
        project_id: "proj-1",
        video_prompt: "@jen at a counter",
        ai_generated_prompt: "a woman with a red scarf at a counter",
      },
      elementNames: [{ name: "jen", description: "a woman with a red scarf" }],
    });

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "someone unnamed at a counter");
    await regenerateClip(form);

    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({ ai_generated_prompt: null }),
    );
  });

  it("leaves an untagged scene alone: no tags, no stale value, no needless write", async () => {
    const spies = mockSceneSurfaces({
      scene: {
        id: "scene-1",
        project_id: "proj-1",
        video_prompt: "a quiet kitchen at dawn",
        ai_generated_prompt: null,
      },
    });

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "a quiet kitchen at dawn");
    await regenerateClip(form);

    expect(
      spies.update,
      "nothing changed and there were no tags to resolve — this must stay a no-op write",
    ).not.toHaveBeenCalled();
    expect(spies.rerenderScene).toHaveBeenCalled();
  });

  it("refreshes the same way whether versionMode is the default 'new' or the destructive 'update'", async () => {
    for (const versionMode of [undefined, "update"]) {
      vi.resetModules();
      vi.clearAllMocks();
      const spies = mockSceneSurfaces({
        scene: {
          id: "scene-1",
          project_id: "proj-1",
          video_prompt: "@jen at a counter",
          ai_generated_prompt: "a woman with a red scarf at a counter",
        },
        elementNames: [{ name: "jen", description: "a woman with a red scarf" }],
      });

      const { regenerateClip } = await import("./ugc");
      const form = new FormData();
      form.set("sceneId", "scene-1");
      form.set("prompt", "@jen at a diner");
      if (versionMode) form.set("versionMode", versionMode);
      await regenerateClip(form);

      expect(
        spies.update,
        `versionMode=${JSON.stringify(versionMode)} did not refresh ai_generated_prompt`,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          ai_generated_prompt: "a woman with a red scarf at a diner",
        }),
      );
    }
  });
});

describe("setActiveVersion will not repoint a scene at another scene's clip", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("refuses a version id that does not belong to the scene", async () => {
    // The read is scoped to the scene as well as the version id, so a version
    // from elsewhere comes back empty. What matters is that empty means
    // REFUSE, not "write it anyway" — the update below it is unconditional
    // apart from this check.
    // The version EXISTS — it just belongs to a different scene. That is the
    // case the scoping exists for, and a stub that only ever returned null
    // could not tell it apart from a version id that is simply wrong.
    const spies = mockSceneSurfaces({
      versions: [{ id: "version-from-another-scene", scene_id: "scene-2" }],
    });

    const { setActiveVersion } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("versionId", "version-from-another-scene");
    const result = await setActiveVersion(form);

    expect(
      spies.update,
      "a foreign version id repointed the scene at a clip that is not its own",
    ).not.toHaveBeenCalled();
    expect(result?.error).toMatch(/does not belong to this scene/i);
  });

  it("sets the current version when the version is the scene's own", async () => {
    const spies = mockSceneSurfaces({
      versions: [{ id: "version-1", scene_id: "scene-1" }],
    });

    const { setActiveVersion } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("versionId", "version-1");
    const result = await setActiveVersion(form);

    expect(result).toBeUndefined();
    expect(spies.update).toHaveBeenCalledWith({ active_version_id: "version-1" });
  });

  it("refuses a missing scene or version id without writing", async () => {
    const spies = mockSceneSurfaces({
      versions: [{ id: "version-1", scene_id: "scene-1" }],
    });

    const { setActiveVersion } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    const result = await setActiveVersion(form);

    expect(result?.error).toMatch(/missing scene or version/i);
    expect(spies.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The pickers are an input on regenerate, not decoration.
//
// rerenderScene takes no settings — it prices and submits whatever the scene
// stores — so a model or length chosen in the column reaches the render only
// if regenerateClip writes it first. Before it did, changing LENGTH from 4s to
// 8s moved the button's quote to 504 credits and then rendered 4s for 252: a
// live control that changed the price and did nothing.
//
// Order matters and is asserted: validate, then write, then render. A refusal
// must not leave the scene claiming settings it was never rendered at.
// ---------------------------------------------------------------------------

describe("regenerateClip applies the settings it was given", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  function aRegenerateForm(over: Record<string, string> = {}): FormData {
    const first = firstOffer();
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "the prompt already on the row");
    form.set("modelId", first.model.id);
    form.set("resolution", first.resolution);
    form.set("durationS", String(first.model.durationsS[0]));
    for (const [k, v] of Object.entries(over)) form.set(k, v);
    return form;
  }

  it("writes the chosen model, resolution and length before rendering", async () => {
    const spies = mockSceneSurfaces({});

    const { regenerateClip } = await import("./ugc");
    await regenerateClip(aRegenerateForm());

    expect(spies.update).toHaveBeenCalledTimes(1);
    const written = spies.update.mock.calls[0]?.[0] as {
      render_settings_override?: { model: string; resolution: string };
      duration_s?: number;
    };
    const first = firstOffer();
    // BytePlus Seedance always stores quality "high".
    expect(written.render_settings_override).toEqual({
      model: first.model.id,
      resolution: first.resolution,
      quality: "high",
    });
    expect(written.duration_s).toBe(first!.model.durationsS[0]);
    expect(spies.rerenderScene).toHaveBeenCalled();
  });

  it("moves a scene on retired Kie seedance-2.5 to BytePlus 480p, quality high", async () => {
    const spies = mockSceneSurfaces({});
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(
      aRegenerateForm({ modelId: "seedance-2.5", resolution: "1080p", durationS: "4" }),
    );

    expect(result?.error).toBeUndefined();
    const written = spies.update.mock.calls[0]?.[0] as {
      render_settings_override?: { model: string; resolution: string; quality: string };
    };
    expect(written.render_settings_override).toEqual({
      model: "seedance-2.5-byteplus",
      resolution: "480p",
      quality: "high",
    });
  });

  it("refuses 720p on BytePlus Seedance and writes nothing", async () => {
    const spies = mockSceneSurfaces({});
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(
      aRegenerateForm({ modelId: "seedance-2.5-byteplus", resolution: "720p", durationS: "4" }),
    );

    expect(result?.error).toMatch(/480p only/i);
    expect(spies.update).not.toHaveBeenCalled();
  });

  it("forces quality high on BytePlus Seedance whatever was posted", async () => {
    const spies = mockSceneSurfaces({});
    const { regenerateClip } = await import("./ugc");

    await regenerateClip(aRegenerateForm({ quality: "standard" }));

    const written = spies.update.mock.calls[0]?.[0] as {
      render_settings_override?: { quality?: string };
    };
    expect(written.render_settings_override?.quality).toBe("high");
  });

  it("refuses a prompt over the 20,000 character cap before writing", async () => {
    const spies = mockSceneSurfaces({});
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(aRegenerateForm({ prompt: "a".repeat(20_001) }));

    expect(result?.error).toMatch(/20,000/);
    expect(spies.update).not.toHaveBeenCalled();
  });

  it("refuses a pair this route may not sell, and writes nothing", async () => {
    // offerable() is the same gate generateClip uses. An unpaid tier reaching
    // the render through the back door would be priced from a rate nobody has
    // been billed at.
    const spies = mockSceneSurfaces({});

    const { regenerateClip } = await import("./ugc");
    const result = await regenerateClip(
      aRegenerateForm({ modelId: "bytedance/seedance-2-5", resolution: "2160P" }),
    );

    expect(result?.error).toMatch(/not offered/i);
    expect(
      spies.update,
      "an unsellable pair was written to the scene before being refused",
    ).not.toHaveBeenCalled();
    expect(spies.rerenderScene).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // THE PICKER AND THE GATE MUST READ THE SAME FACT.
  //
  // Reported from production: the /ugc column offered "Seedance 2.0", quoted
  // it at 76 credits, and the Server Action answered "seedance-2 at 480p is
  // not offered. Available: Seedance 2.5 480p, ...". Nothing was broken about
  // Seedance 2.0 -- the two sides were asking offerable() different questions.
  //
  // offerable(withSound) reads the sound or the silent rate table. The page
  // passed true; the action passed a hardcoded false. Seedance 2.0 and 2.0
  // Fast have NO silent rate at all -- an empty map, deliberately, because
  // copying the sound number across would assert that audio is free -- so the
  // silent question could only ever answer "unsellable", whatever the price.
  //
  // Both sides now read isAudioEnabled(). These two tests pin each half: that
  // the sound table really is what makes 2.0 sellable, and that the gate
  // accepts what the picker shows.
  // -------------------------------------------------------------------------

  it("sells Seedance 2.0 at 480p when the render carries sound, and not otherwise", () => {
    const has = (withSound: boolean): boolean =>
      offerable(withSound).some((o) => o.model.id === "seedance-2" && o.resolution === "480p");

    expect(
      has(true),
      "seedance-2/480p is unsellable with sound on -- did its rate or its ACCEPTED_PUBLISHED_RATES entry go?",
    ).toBe(true);
    expect(
      has(false),
      "seedance-2 gained a silent rate; if that is deliberate this test is now the wrong shape",
    ).toBe(false);
  });

  it("accepts the model the picker offers, rather than refusing it by name", async () => {
    const previous = process.env.AUDIO_ENABLED;
    process.env.AUDIO_ENABLED = "1";
    try {
      const spies = mockSceneSurfaces({});
      const { regenerateClip } = await import("./ugc");

      const result = await regenerateClip(
        aRegenerateForm({ modelId: "seedance-2", resolution: "480p", durationS: "4" }),
      );

      expect(
        result?.error,
        "the gate refused a pair the picker offers -- the two are reading different tables again",
      ).toBeUndefined();
      expect(spies.update).toHaveBeenCalledTimes(1);
      const written = spies.update.mock.calls[0]?.[0] as {
        render_settings_override?: { model: string; resolution: string };
      };
      expect(written.render_settings_override).toEqual({
        model: "seedance-2",
        resolution: "480p",
      });
    } finally {
      if (previous === undefined) delete process.env.AUDIO_ENABLED;
      else process.env.AUDIO_ENABLED = previous;
    }
  });

  it("refuses a length the chosen model does not render", async () => {
    const spies = mockSceneSurfaces({});

    const { regenerateClip } = await import("./ugc");
    // Computed, not guessed: 7s looked like an obvious reject and is in fact a
    // length Seedance offers, so the first version of this test asserted a
    // refusal that never came.
    const first = firstOffer();
    const tooLong = Math.max(...first.model.durationsS) + 1;
    const result = await regenerateClip(aRegenerateForm({ durationS: String(tooLong) }));

    expect(result?.error).toMatch(new RegExp(`does not render ${tooLong}s`, "i"));
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.rerenderScene).not.toHaveBeenCalled();
  });

  it("still renders when no settings are sent, leaving the scene's own alone", async () => {
    // The scripted pipeline's own retry path posts no pickers. It must keep
    // working, and it must not have its stored settings cleared by their
    // absence.
    const spies = mockSceneSurfaces({});
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "a new instruction");

    const { regenerateClip } = await import("./ugc");
    await regenerateClip(form);

    const written = spies.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty("render_settings_override");
    expect(written).not.toHaveProperty("duration_s");
    expect(spies.rerenderScene).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // is_talking_head follows the CHOSEN MODEL here too — the same rule
  // generateClip's insert follows (see actions/ugc.test.ts's "generateClip
  // writes is_talking_head from the chosen model" below), applied to an
  // EXISTING scene's update. Switching Seedance -> Kling must turn sound on;
  // Kling -> Seedance must turn it back off. rerenderScene re-reads the row
  // after this update runs, so its own estimate follows whichever way this
  // just moved.
  // -------------------------------------------------------------------------

  it("switching a scene to kling-3.0-pro/720p turns is_talking_head on", async () => {
    // 720p, not 1080p: /ugc's own tier as of 2026-09-10 (kie's std mode,
    // 20 cr/s — see lib/kie/rates.ts). The write shape this test pins does
    // not care which Kling tier it is; 720p is the one /ugc actually offers.
    const previous = process.env.AUDIO_ENABLED;
    process.env.AUDIO_ENABLED = "1";
    try {
      const spies = mockSceneSurfaces({
        elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
        assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
      });
      const { regenerateClip } = await import("./ugc");

      // startElementId + sound=1, the shape the column submits once its own
      // model select lands on Kling — regenerateClip reads is_talking_head
      // off THIS, not off nativeAudio alone (see the "Kling mode:
      // generateClip" describe's own pin of the same rule on the other action).
      const result = await regenerateClip(
        aRegenerateForm({
          modelId: "kling-3.0-pro",
          resolution: "720p",
          durationS: "4",
          startElementId: "start-el",
          sound: "1",
        }),
      );

      expect(result?.error).toBeUndefined();
      expect(spies.update).toHaveBeenCalledTimes(1);
      const written = spies.update.mock.calls[0]?.[0] as {
        is_talking_head?: boolean;
        render_settings_override?: { model: string; resolution: string };
        ref_frame_asset_id?: string;
      };
      expect(written.is_talking_head).toBe(true);
      expect(written.render_settings_override).toEqual({
        model: "kling-3.0-pro",
        resolution: "720p",
      });
      // The Start frame was copied into a fresh asset, and the scene points
      // at it — see regenerateClip's own comment on why this always copies
      // fresh rather than reusing scene.ref_frame_asset_id.
      expect(written.ref_frame_asset_id).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.AUDIO_ENABLED;
      else process.env.AUDIO_ENABLED = previous;
    }
  });

  it("refuses a Kling regenerate whose prompt still @tags something, before any write", async () => {
    const spies = mockSceneSurfaces({
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
    });
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(
      aRegenerateForm({
        modelId: "kling-3.0-pro",
        resolution: "720p",
        durationS: "4",
        startElementId: "start-el",
        sound: "1",
        prompt: "a dog skateboarding, @greta_ref style",
      }),
    );

    expect(result).toEqual({ error: expect.stringMatching(/kling can.t use @tags/i) });
    expect(result?.error).toMatch(/@greta_ref/);
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.rerenderScene).not.toHaveBeenCalled();
  });

  it("refuses a Kling regenerate whose Start frame is a webp, before any write", async () => {
    const spies = mockSceneSurfaces({
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.webp" } },
    });
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(
      aRegenerateForm({
        modelId: "kling-3.0-pro",
        resolution: "720p",
        durationS: "4",
        startElementId: "start-el",
        sound: "1",
      }),
    );

    expect(result).toEqual({
      error: expect.stringMatching(/kling only takes png or jpg frames/i),
    });
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.rerenderScene).not.toHaveBeenCalled();
  });

  it("switching a scene to seedance-2.5-byteplus/480p turns is_talking_head off", async () => {
    const spies = mockSceneSurfaces({});
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(
      aRegenerateForm({ modelId: "seedance-2.5-byteplus", resolution: "480p", durationS: "4" }),
    );

    expect(result?.error).toBeUndefined();
    expect(spies.update).toHaveBeenCalledTimes(1);
    const written = spies.update.mock.calls[0]?.[0] as { is_talking_head?: boolean };
    expect(written.is_talking_head).toBe(false);
  });

  it("switches to prompt-only Kling and clears the previous frame", async () => {
    const spies = mockSceneSurfaces({});
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(
      aRegenerateForm({ modelId: "kling-3.0-pro", resolution: "720p", durationS: "4" }),
    );

    expect(result?.error).toBeUndefined();
    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({ ref_frame_asset_id: null }),
    );
    expect(spies.rerenderScene).toHaveBeenCalled();
  });

  it("refuses an end frame submitted for a non-Kling model, before writing anything", async () => {
    const spies = mockSceneSurfaces({});
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(aRegenerateForm({ endElementId: "some-el" }));

    expect(result?.error).toMatch(/end frame only applies to kling/i);
    expect(spies.update).not.toHaveBeenCalled();
  });

  it("replaces the scene's references with exactly start/end when switching TO Kling", async () => {
    // A scene last rendered on Seedance, with a whole box of tags, must end
    // up holding ONLY the start/end pair once it regenerates on Kling — the
    // same "replace, not append" rule attachSceneReferences' own doc comment
    // states.
    const spies = mockSceneSurfaces({
      elementsById: {
        "start-el": { asset_id: "asset-start", user_id: "user-1" },
        "el-end": { asset_id: "asset-end", user_id: "user-1" },
      },
      assetsById: {
        "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" },
        "asset-end": { kind: "ref_frame", storage_key: "elements/end.jpg" },
      },
      elementNames: [{ name: "end" }],
    });
    const { regenerateClip } = await import("./ugc");

    await regenerateClip(
      aRegenerateForm({
        modelId: "kling-3.0-pro",
        resolution: "720p",
        durationS: "4",
        startElementId: "start-el",
        endElementId: "el-end",
      }),
    );

    const refCall = spies.insert.mock.calls.find(
      (call) => Array.isArray(call[0]) && (call[0] as unknown[]).length > 0,
    );
    expect(refCall, "no scene_references rows were written").toBeTruthy();
    const rows = refCall![0] as { kind: string; ordinal: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ordinal === 1)).toMatchObject({ kind: "image" });
    expect(rows.find((r) => r.ordinal === 2)).toMatchObject({ kind: "image" });
  });

  // -------------------------------------------------------------------------
  // "Try again" is gone from /ugc's failure panel (page.tsx) — Regenerate is
  // now the only requeue control this route has, for a FAILED scene exactly
  // as for a done one. Production hit this the moment "Try again" was
  // removed: Regenerate on a failed Kling scene returned "Scene is 'failed',
  // not 'done'" (assertSceneRerenderable, via rerenderScene), because
  // regenerateClip's own early guard used to refuse anything but 'done'.
  // -------------------------------------------------------------------------

  it("regenerates a FAILED Kling scene with NEW frames: scene_references rewritten, and requeued via retryScene, not rerenderScene", async () => {
    const spies = mockSceneSurfaces({
      scene: {
        id: "scene-1",
        project_id: "proj-1",
        video_prompt: "the prompt already on the row",
        status: "failed",
      },
      elementsById: {
        "start-el": { asset_id: "asset-start", user_id: "user-1" },
        "el-end": { asset_id: "asset-end", user_id: "user-1" },
      },
      assetsById: {
        "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" },
        "asset-end": { kind: "ref_frame", storage_key: "elements/end.jpg" },
      },
      elementNames: [{ name: "end" }],
    });
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(
      aRegenerateForm({
        modelId: "kling-3.0-pro",
        resolution: "720p",
        durationS: "4",
        startElementId: "start-el",
        endElementId: "el-end",
        sound: "1",
        versionMode: "update",
      }),
    );

    expect(result?.error).toBeUndefined();

    // NEW FRAMES, WRITTEN. Same "replace, not append" assertion as the
    // switch-to-Kling test above — a failed scene's requeue must not skip
    // the reference rewrite just because it takes the retryScene branch.
    const refCall = spies.insert.mock.calls.find(
      (call) => Array.isArray(call[0]) && (call[0] as unknown[]).length > 0,
    );
    expect(refCall, "no scene_references rows were written").toBeTruthy();
    const rows = refCall![0] as { kind: string; ordinal: number }[];
    expect(rows).toHaveLength(2);

    // REQUEUED VIA THE FAILED-SCENE PATH, honoring this route's own
    // versionMode ("update" was submitted above) — and NOT via rerenderScene,
    // which would have refused a 'failed' scene outright.
    expect(spies.retryScene).toHaveBeenCalledWith("scene-1", undefined, "update");
    expect(
      spies.rerenderScene,
      "a failed scene went through the done-scene path, which refuses it",
    ).not.toHaveBeenCalled();
  });

  it("still refuses a queued/rendering scene even though 'failed' is now accepted", async () => {
    // NEGATIVE-CONTROL-ADJACENT: this is what stops "accept failed too" from
    // sliding into "accept anything" — queued/rendering must still be
    // refused before any write, exactly as before.
    const spies = mockSceneSurfaces({
      scene: {
        id: "scene-1",
        project_id: "proj-1",
        video_prompt: "the prompt already on the row",
        status: "queued",
      },
    });
    const { regenerateClip } = await import("./ugc");

    const result = await regenerateClip(aRegenerateForm());

    expect(result?.error).toMatch(/already rendering/i);
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.retryScene).not.toHaveBeenCalled();
    expect(spies.rerenderScene).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// regenerateClip must refuse an in-flight scene BEFORE writing anything.
//
// rerenderScene already refuses a scene that is 'queued' or 'rendering'
// (assertSceneRerenderable) — but only once regenerateClip has already
// written the new model/resolution/is_talking_head onto the row. Pressing
// Regenerate -> Kling on a Seedance clip that is still queued/rendering was
// refused, but left the scene claiming kling-3.0-pro + is_talking_head true
// while a Seedance job was still in flight for it — and ingest/reconcile/the
// webhook re-derive PickModel from exactly that row once the in-flight job
// lands.
// ---------------------------------------------------------------------------

describe("regenerateClip refuses an in-flight scene before writing anything", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each(["rendering", "queued"])("status %s: refuses and writes nothing", async (status) => {
    const spies = mockSceneSurfaces({
      scene: {
        id: "scene-1",
        project_id: "proj-1",
        video_prompt: "the prompt already on the row",
        status,
      },
    });

    const { regenerateClip } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "a new instruction");

    const result = await regenerateClip(form);

    // A PLAIN MESSAGE, not assertSceneRerenderable's own dev-speak one
    // (regenerateClip no longer calls that shared guard — see its own doc
    // comment on why) — this no longer names the raw status word, so the
    // regex pinning that changed with it.
    expect(result?.error).toMatch(/already rendering/i);
    expect(
      spies.update,
      "an in-flight scene had settings written before being refused",
    ).not.toHaveBeenCalled();
    expect(spies.rerenderScene).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// retryClip is GONE (see actions/ugc.ts's own note where it used to be
// defined) — its tests lived here, pinning that it called retryScene, not
// rerenderScene, for a failed scene. That question now belongs to
// regenerateClip's own status branch — see "regenerateClip applies the
// settings it was given"'s Kling describe block below for its replacement:
// "regenerates a FAILED scene via retryScene, not rerenderScene, honoring
// versionMode".
// ---------------------------------------------------------------------------
// generateClip's prompt pair (0072): scenes.video_prompt vs
// scenes.ai_generated_prompt.
//
// scenes.ai_generated_prompt is "the one the vendor is sent when it is set"
// (0072_element_ai_description.sql), and video_prompt must keep the
// operator's own words so a wrong clip can be traced to the writing or the
// refinement, and so "@name" tags survive for retargeting.
// ---------------------------------------------------------------------------

describe("generateClip writes the operator/refined prompt pair (0072)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("without operatorPrompt: video_prompt is the box text, unrefined — unchanged from before 0072", async () => {
    // This is the common path, and 0072 must not have touched it: a scene
    // generated without pressing Refine behaves exactly as it always did.
    const spies = mockWriteSurfaces({});

    const { generateClip } = await import("./ugc");
    await generateClip(aClipForm({ prompt: "a cat knocks a glass off a table" }));

    // insert is shared across tables in this stub (scenes AND scene_versions),
    // so the scene row is whichever call actually carries video_prompt.
    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    expect(sceneCall, "no scene row was inserted at all").toBeTruthy();
    const written = sceneCall![0] as {
      video_prompt?: string;
      ai_generated_prompt?: string | null;
    };
    expect(written.video_prompt).toBe("a cat knocks a glass off a table");
    expect(written.ai_generated_prompt ?? null).toBeNull();
  });

  it("with operatorPrompt set: video_prompt keeps the operator's words, ai_generated_prompt gets the box text sent to the vendor", async () => {
    // If this pair is not written, a wrong clip can no longer be traced to
    // "the writing" vs. "the refinement" — the whole reason 0072 added a
    // second column — and the operator's "@name" tags are gone the moment
    // Refine runs, exactly the regression 0072's header describes.
    const spies = mockWriteSurfaces({});

    const { generateClip } = await import("./ugc");
    await generateClip(
      aClipForm({
        prompt: "Lena walks into a sunlit kitchen and sets a mug on the counter.",
        operatorPrompt: "@lena walks into frame",
      }),
    );

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    expect(sceneCall, "no scene row was inserted at all").toBeTruthy();
    const written = sceneCall![0] as {
      video_prompt?: string;
      ai_generated_prompt?: string | null;
    };
    expect(written.video_prompt).toBe("@lena walks into frame");
    expect(written.ai_generated_prompt).toBe(
      "Lena walks into a sunlit kitchen and sets a mug on the counter.",
    );
  });
});

// ---------------------------------------------------------------------------
// is_talking_head follows the CHOSEN MODEL, not a hardcoded false.
//
// Kling is the only native-audio model kie serves — getModel(id).nativeAudio,
// the same flag lib/models.ts's pricingAudioOn reads. is_talking_head is what
// asks worker PickModel for the sound route (nativeAudioModel), so a clip
// rendered on Kling must be written with it true or it renders SILENT while
// quoted at the sound rate. Seedance never reads this flag for audio at all,
// so it stays false there — the regression this file's second test pins.
// ---------------------------------------------------------------------------
describe("generateClip writes is_talking_head from the chosen model", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("kling-3.0-pro/720p, sound submitted on -> is_talking_head true, and the cap sees the std SOUND price", async () => {
    // AUDIO_ENABLED=1 -- Kling has no sound rate for offerable() to offer
    // without it, same gate regenerateClip's own "sells Seedance 2.0 ..."
    // tests above exercise.
    //
    // 720p, not 1080p: kie's std mode, /ugc's own tier as of 2026-09-10 (20
    // cr/s with sound, a receipt — see lib/kie/rates.ts), cheaper than
    // pro/1080p's 27.
    //
    // aKlingClipForm, not aClipForm — Kling submits startElementId, never
    // image/elementId, and reads is_talking_head off the submitted `sound`
    // field rather than nativeAudio alone (see the "Kling mode: generateClip"
    // describe above for that pin on its own).
    const previous = process.env.AUDIO_ENABLED;
    process.env.AUDIO_ENABLED = "1";
    try {
      const spies = mockWriteSurfaces({
        elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
        assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
      });
      const { generateClip } = await import("./ugc");

      await generateClip(aKlingClipForm({ resolution: "720p", durationS: "4", sound: "1" }));

      const sceneCall = spies.insert.mock.calls.find(
        (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
      );
      expect(sceneCall, "no scene row was inserted at all").toBeTruthy();
      const written = sceneCall![0] as {
        is_talking_head?: boolean;
        render_settings_override?: { model: string; resolution: string };
      };
      expect(written.is_talking_head).toBe(true);
      expect(written.render_settings_override).toEqual({
        model: "kling-3.0-pro",
        resolution: "720p",
      });

      // 20 cr/s (std, sound) * 4s / 200 credits-per-$ = $0.40, not the pro
      // tier's 27 cr/s * 4s / 200 = $0.54 that this test pinned before std
      // existed, and not the silent 18 cr/s * 4s / 200 = $0.36 an unfixed
      // is_talking_head:false would have priced the cap check at.
      expect(spies.assertWithinSpendCaps).toHaveBeenCalledTimes(1);
      const amountUsd = (spies.assertWithinSpendCaps.mock.calls[0] as unknown[])?.[2] as number;
      expect(amountUsd).toBeCloseTo(0.4, 6);
    } finally {
      if (previous === undefined) delete process.env.AUDIO_ENABLED;
      else process.env.AUDIO_ENABLED = previous;
    }
  });

  it("seedance-2.5-byteplus/480p -> is_talking_head stays false (regression pin)", async () => {
    const spies = mockWriteSurfaces({});
    const { generateClip } = await import("./ugc");

    await generateClip(
      aClipForm({ modelId: "seedance-2.5-byteplus", resolution: "480p", durationS: "4" }),
    );

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    expect(sceneCall, "no scene row was inserted at all").toBeTruthy();
    const written = sceneCall![0] as { is_talking_head?: boolean };
    expect(written.is_talking_head).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kling mode: generateClip writes exactly a start/end pair, never the tag
// loop's rows, and reads is_talking_head off the submitted sound choice
// rather than nativeAudio alone. See ugc-column.tsx's own `isKling` and
// attachSceneReferences' `klingEndElementId` for the client and server
// halves of this.
// ---------------------------------------------------------------------------

/** Kling's own shape: startElementId (+ optional endElementId, sound), never elementId/image. */
function aKlingClipForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("projectId", "proj-1");
  form.set("prompt", "a dog skateboarding");
  form.set("durationS", "4");
  form.set("modelId", "kling-3.0-pro");
  form.set("resolution", "720p");
  form.set("startElementId", "start-el");
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  return form;
}

describe("Kling mode: generateClip", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("accepts prompt-only Kling when neither frame is submitted", async () => {
    const spies = mockWriteSurfaces({});
    const { generateClip } = await import("./ugc");

    const result = await generateClip(aKlingClipForm({ startElementId: "" }));

    expect(result?.error).toBeUndefined();
    expect(spies.insert).toHaveBeenCalledWith(
      expect.objectContaining({ ref_frame_asset_id: null }),
    );
    expect(spies.uploadFile).not.toHaveBeenCalled();
  });

  it("still refuses an end frame without a start frame", async () => {
    const spies = mockWriteSurfaces({});
    const { generateClip } = await import("./ugc");
    const result = await generateClip(
      aKlingClipForm({ startElementId: "", endElementId: "end-1" }),
    );
    expect(result?.error).toMatch(/start frame/i);
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses an end frame submitted for a non-Kling model, before any write", async () => {
    const spies = mockWriteSurfaces({});
    const { generateClip } = await import("./ugc");

    const result = await generateClip(aClipForm({ endElementId: "some-el" }));

    expect(result).toEqual({ error: expect.stringMatching(/end frame only applies to kling/i) });
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses when the start frame isn't a picture, before any write", async () => {
    const spies = mockWriteSurfaces({
      elementsById: { "start-el": { asset_id: "asset-voice", user_id: "user-1" } },
      assetsById: { "asset-voice": { kind: "audio", storage_key: "elements/voice.mp3" } },
    });
    const { generateClip } = await import("./ugc");

    const result = await generateClip(aKlingClipForm());

    expect(result).toEqual({ error: expect.stringMatching(/has to be a picture/i) });
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("refuses a webp Start frame — kie's Kling 3.0 returns a 422 on it", async () => {
    // Prod scene d532c7a0's end frame was a .webp element and kie refused
    // the submit outright: `code=422 msg="Only jpeg/jpg/png image formats
    // are supported"`. 15 of 60 image elements in prod are .webp; Seedance
    // takes them fine (this check lives only on refuseIfNotOwnedImageElement,
    // Kling's own path).
    const spies = mockWriteSurfaces({
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/greta.webp" } },
    });
    const { generateClip } = await import("./ugc");

    const result = await generateClip(aKlingClipForm());

    expect(result).toEqual({
      error: expect.stringMatching(/kling only takes png or jpg frames/i),
    });
    expect(result?.error).toMatch(/webp/i);
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("allows a jpg or png Start frame through unchanged (plain copy, no conversion)", async () => {
    const spies = mockWriteSurfaces({
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/greta.png" } },
    });
    const { generateClip } = await import("./ugc");

    const result = await generateClip(aKlingClipForm());

    expect(result?.error).toBeUndefined();
    expect(spies.insert).toHaveBeenCalled();
  });

  it("refuses when the end frame isn't a picture, before any write", async () => {
    const spies = mockWriteSurfaces({
      elementsById: {
        "start-el": { asset_id: "asset-start", user_id: "user-1" },
        "end-el": { asset_id: "asset-video", user_id: "user-1" },
      },
      assetsById: {
        "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" },
        "asset-video": { kind: "video_ref", storage_key: "elements/clip.mp4" },
      },
    });
    const { generateClip } = await import("./ugc");

    const result = await generateClip(aKlingClipForm({ endElementId: "end-el" }));

    expect(result).toEqual({ error: expect.stringMatching(/has to be a picture/i) });
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("writes exactly ordinal 1 (start) and ordinal 2 (end), never a third reference", async () => {
    const spies = mockWriteSurfaces({
      // "el-end"/"asset-end" are the ids the elementNames list below
      // auto-derives from the name "end" (id: `el-${name}`, asset_id:
      // `asset-${name}`) — generateClip's own early validation reads "el-
      // end" by single id (refuseIfNotOwnedImageElement) before
      // attachSceneReferences' klingEndElementId branch reads it again off
      // the LIST, so it has to answer both.
      elementsById: {
        "start-el": { asset_id: "asset-start", user_id: "user-1" },
        "el-end": { asset_id: "asset-end", user_id: "user-1" },
      },
      assetsById: {
        "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" },
        "asset-end": { kind: "ref_frame", storage_key: "elements/end.jpg" },
      },
      elementNames: [{ name: "end" }],
    });

    const { generateClip } = await import("./ugc");
    // Tag-free: a Kling submission with ANY @tag is refused outright now
    // (see "a Kling prompt with an @tag is refused" below), so this test's
    // OWN point — the write path lands exactly two ordinal rows, start and
    // end, and nothing more — needs a prompt that actually reaches the
    // write phase.
    await generateClip(
      aKlingClipForm({ endElementId: "el-end", prompt: "make the dog skateboard" }),
    );

    const refCall = spies.insert.mock.calls.find(
      (call) => Array.isArray(call[0]) && (call[0] as unknown[]).length > 0,
    );
    expect(refCall, "no scene_references rows were written").toBeTruthy();
    const rows = refCall![0] as { kind: string; ordinal: number; tag: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ordinal === 1)).toMatchObject({ kind: "image" });
    expect(rows.find((r) => r.ordinal === 2)).toMatchObject({ kind: "image", tag: "end" });
  });

  it("leaves the prompt exactly as typed — no substitution, unlike every other model", async () => {
    const spies = mockWriteSurfaces({
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
    });
    const { generateClip } = await import("./ugc");

    // Tag-free — see the test above's own note on why. Nothing to
    // substitute either way now that a tagged Kling prompt is refused
    // before it ever reaches this write, but the claim this test pins
    // (Kling's video_prompt is the typed text, verbatim, no
    // ai_generated_prompt pair) is still real and still worth a regression.
    await generateClip(aKlingClipForm({ prompt: "make the dog skateboard" }));

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    expect(sceneCall, "no scene row was inserted at all").toBeTruthy();
    const written = sceneCall![0] as { video_prompt: string; ai_generated_prompt: string | null };
    expect(written.video_prompt).toBe("make the dog skateboard");
    expect(written.ai_generated_prompt).toBeNull();
  });

  it("a Kling prompt with an @tag is refused before any write or spend check", async () => {
    const spies = mockWriteSurfaces({
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
    });
    const { generateClip } = await import("./ugc");

    const result = await generateClip(
      aKlingClipForm({ prompt: "a dog skateboarding, @greta_ref style" }),
    );

    expect(result).toEqual({
      error: expect.stringMatching(/kling can.t use @tags/i),
    });
    expect(result?.error).toMatch(/@greta_ref/);
    expect(spies.insert).not.toHaveBeenCalled();
    expect(spies.assertWithinSpendCaps).not.toHaveBeenCalled();
  });

  it("reads is_talking_head from the submitted sound choice, not nativeAudio alone", async () => {
    const previous = process.env.AUDIO_ENABLED;
    process.env.AUDIO_ENABLED = "1";
    try {
      const spies = mockWriteSurfaces({
        elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
        assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
      });
      const { generateClip } = await import("./ugc");

      await generateClip(aKlingClipForm({ sound: "0" }));

      const sceneCall = spies.insert.mock.calls.find(
        (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
      );
      const written = sceneCall![0] as { is_talking_head?: boolean };
      expect(
        written.is_talking_head,
        "Kling is nativeAudio, but the OPERATOR asked for sound off",
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.AUDIO_ENABLED;
      else process.env.AUDIO_ENABLED = previous;
    }
  });

  it("forces sound off when AUDIO_ENABLED is globally off, even if sound=1 was submitted", async () => {
    const previous = process.env.AUDIO_ENABLED;
    delete process.env.AUDIO_ENABLED;
    try {
      const spies = mockWriteSurfaces({
        elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
        assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
      });
      const { generateClip } = await import("./ugc");

      await generateClip(aKlingClipForm({ sound: "1" }));

      const sceneCall = spies.insert.mock.calls.find(
        (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
      );
      const written = sceneCall![0] as { is_talking_head?: boolean };
      expect(written.is_talking_head).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.AUDIO_ENABLED;
      else process.env.AUDIO_ENABLED = previous;
    }
  });
});

describe("generateClip reports a tag that names nothing", () => {
  // THE SILENCE THIS BREAKS. bindUITags strips the '@' from an unbound tag,
  // so "@new" reaches Seedance as the ordinary word "new". The render
  // succeeds, bills in full, and is missing the face or the voice that was
  // asked for — and until now nothing anywhere said so.
  //
  // The likeliest way to get there is a rename. updateElement follows one
  // through every SAVED scene prompt, but a draft open in another tab keeps
  // the old text AND a stale element list, so the browser still paints "@new"
  // as a resolved tag while the database no longer has one. Only the server
  // can see that disagreement.
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("names the unknown tag, and still queues the clip", async () => {
    const spies = mockWriteSurfaces({ elementNames: [{ name: "jen" }] });

    const { generateClip } = await import("./ugc");
    const result = await generateClip(aClipForm({ prompt: "@new at a counter" }));

    expect(result).toEqual({ sceneId: "scene-1", notice: expect.stringMatching(/@new/) });
    // A NOTICE, NOT AN ERROR. "a worse clip, not a lost one" is a rule this
    // codebase states in three places, and this warning does not reverse it:
    // the scene was still written — the returned sceneId above is the proof.
    expect(result?.error).toBeUndefined();
    expect(
      spies.insert.mock.calls.some(
        (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
      ),
      "the clip was not queued — the warning must not have become a refusal",
    ).toBe(true);
  });

  it("says nothing when every tag resolves", async () => {
    mockWriteSurfaces({ elementNames: [{ name: "jen", description: "the presenter" }] });

    const { generateClip } = await import("./ugc");
    expect(await generateClip(aClipForm({ prompt: "@jen at a counter" }))).toEqual({
      sceneId: "scene-1",
    });
  });

  it("does not warn about an element that merely has no description", async () => {
    // THE DISTINCTION A CARELESS VERSION GETS WRONG. A tag can resolve to a
    // real element with no description: nothing is substituted into the
    // prompt, but the element IS attached as a reference and the render
    // carries it. That is a thinner clip, not a wrong one — warning about it
    // would train an operator to ignore this notice, which costs more than
    // the notice ever earns.
    mockWriteSurfaces({ elementNames: [{ name: "jen", description: null }] });

    const { generateClip } = await import("./ugc");
    expect(await generateClip(aClipForm({ prompt: "@jen at a counter" }))).toEqual({
      sceneId: "scene-1",
    });
  });

  it("matches case-insensitively, like every other tag lookup", async () => {
    // findElementByTag and renameTagInPrompt both resolve this way; a warning
    // that did not would fire on "@Jen" for an element saved as "jen".
    mockWriteSurfaces({ elementNames: [{ name: "jen" }] });

    const { generateClip } = await import("./ugc");
    expect(await generateClip(aClipForm({ prompt: "@Jen at a counter" }))).toEqual({
      sceneId: "scene-1",
    });
  });

  it("names every unknown tag, not just the first", async () => {
    mockWriteSurfaces({ elementNames: [{ name: "jen" }] });

    const { generateClip } = await import("./ugc");
    const result = await generateClip(aClipForm({ prompt: "@new and @old with @jen" }));

    expect(result?.notice).toMatch(/@new/);
    expect(result?.notice).toMatch(/@old/);
    expect(result?.notice, "the resolved tag was reported as missing").not.toMatch(/@jen/);
  });
});

describe("generateClip does not send a picked voice as a picture", () => {
  // THE BUG THIS PINS, hit in production on 2026-09-04:
  //
  //   reference_image_urls: [ .../ref_frame/96f0bae1-....mp3, .../7f47d6fb-....png ]
  //   vendor reported code=500 msg="File type not supported"
  //
  // There are TWO routes into scene_references and only one of them had been
  // taught about audio. The tagged-reference loop reads the asset kind and
  // carries a comment explaining why the category must not be trusted; the
  // PRIMARY row above it was a hardcoded "image", and generateClip copied
  // every picked reference under 'ref_frame' with a jpg default. So a picked
  // MP3 became a ref_frame asset full of audio bytes, went into the image
  // array, and kie said exactly what it should have.
  //
  // One table, two writers, one of them written twice.
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("copies a picked voice as audio and files it under the audio kind", async () => {
    const spies = mockWriteSurfaces({
      element: { asset_id: "asset-voice", user_id: "user-1" },
      sourceAssetKind: "audio",
      sourceStorageKey: "projects/other/audio/lena.mp3",
    });

    const { generateClip } = await import("./ugc");
    await generateClip(aClipForm({ elementId: "el-voice" }));

    // The stored asset row says what the bytes are.
    const assetCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).storage_key !== undefined,
    );
    expect(assetCall, "no asset row was written").toBeTruthy();
    expect((assetCall![0] as { kind: string }).kind).toBe("audio");

    // And the scene_references row routes it to kie's audio array.
    // scene_references is inserted as an ARRAY of rows in one call.
    const refCall = spies.insert.mock.calls.find(
      (call) => Array.isArray(call[0]) && (call[0] as unknown[]).length > 0,
    );
    expect(refCall, "no scene_references rows were written").toBeTruthy();
    const primaryRow = (refCall![0] as { kind: string; ordinal: number }[]).find(
      (r) => r.ordinal === 1,
    );
    expect(primaryRow?.kind).toBe("audio");
  });

  it("still copies a picked picture as an image", async () => {
    // The other direction. A fix that called everything audio would pass the
    // test above and break every render this product makes.
    const spies = mockWriteSurfaces({
      element: { asset_id: "asset-img", user_id: "user-1" },
      sourceAssetKind: "ref_frame",
      sourceStorageKey: "projects/other/ref_frame/lena.png",
    });

    const { generateClip } = await import("./ugc");
    await generateClip(aClipForm({ elementId: "el-img" }));

    const assetCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).storage_key !== undefined,
    );
    expect((assetCall![0] as { kind: string }).kind).toBe("ref_frame");

    const refCall = spies.insert.mock.calls.find(
      (call) => Array.isArray(call[0]) && (call[0] as unknown[]).length > 0,
    );
    const primaryRow = (refCall![0] as { kind: string; ordinal: number }[]).find(
      (r) => r.ordinal === 1,
    );
    expect(primaryRow?.kind).toBe("image");
  });
});

describe("attachSceneReferences now lets a tagged video reach scene_references", () => {
  // THIS BEHAVIOUR WAS PINNED THE OPPOSITE WAY until
  // 0094_video_scene_reference.sql. Until then, scene_references.kind's own
  // CHECK was still `check (kind in ('image', 'audio'))` — 0093_video_
  // reference_elements.sql deliberately left it there because
  // reference_video_urls had never been confirmed against kie's own docs and
  // no render had ever sent one — so this suite asserted a tagged .mp4 wrote
  // NO row at all, and the tag loop's refKind allowlist skipped it rather
  // than risk writing kind='image' over a denylist reversion (a defect that
  // would have kie answering 200 and billing a render for the wrong file,
  // per worker/internal/kie/client.go's own comment on that failure mode).
  //
  // 0094 confirmed reference_video_urls in kie's Seedance 2.5 docs, widened
  // the CHECK to admit 'video', and wired the worker to send it — so the
  // allowlist gained 'video_ref' as a THIRD member instead of a reason to
  // skip. This suite now pins the opposite of what it pinned before: a
  // tagged video writes its own scene_references row, under its own kind,
  // with its own per-kind ordinal — the same three things every 'image' and
  // 'audio' row already gets.
  //
  // THE PRICE THIS BUYS is real and not enforced here: kie charges a
  // video-conditioned render as Price x (input + output), not Price x
  // output. That arithmetic lives in web/lib/kie/rates.ts and
  // worker/internal/kie/models.go, not in this function or this test.
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("writes a video row alongside a tagged image and a tagged voice in the same prompt, each under its own kind and ordinal", async () => {
    // The primary reference is the plain default upload (aClipForm's own
    // `image` field, a PNG — primaryKind resolves to "image"), so this
    // exercises the TAG loop in isolation from the primary-picking path the
    // describe block above already covers, and it also means the primary
    // has already spent ordinal 1 of kind "image" before the loop runs.
    const spies = mockWriteSurfaces({
      elementNames: [
        { name: "img1", description: "a red bottle on a counter", assetKind: "ref_frame" },
        { name: "aud1", description: "a warm, low voice", assetKind: "audio" },
        { name: "vid1", description: "a hand-typed description", assetKind: "video_ref" },
      ],
      assetsById: {
        "asset-img1": { storage_key: "projects/other/ref_frame/img1.png", kind: "ref_frame" },
        "asset-aud1": { storage_key: "projects/other/audio/aud1.mp3", kind: "audio" },
        "asset-vid1": { storage_key: "projects/other/video_ref/vid1.mp4", kind: "video_ref" },
      },
    });

    const { generateClip } = await import("./ugc");
    const result = await generateClip(
      aClipForm({ prompt: "@img1 next to the product, narrated by @aud1, styled like @vid1" }),
    );
    expect(result ?? {}, "a video tag must not fail the whole render").not.toHaveProperty("error");

    // scene_references is inserted as an ARRAY of rows in one call, the same
    // way the sibling describe block above reads it.
    const refCall = spies.insert.mock.calls.find(
      (call) => Array.isArray(call[0]) && (call[0] as unknown[]).length > 0,
    );
    expect(refCall, "no scene_references rows were written").toBeTruthy();
    const rows = refCall![0] as { kind: string; ordinal: number; tag: string | null }[];

    // THE ASSERTION THAT FAILS IF THIS IS REVERTED TO A SKIP: @vid1 must
    // have written a row at all, with kind 'video' — not be absent, and not
    // have been mislabelled 'image' by a denylist reversion either.
    const vid1 = rows.find((r) => r.tag === "vid1");
    expect(vid1, "the video tag wrote no scene_references row").toBeTruthy();
    expect(vid1?.kind).toBe("video");
    // First video row on this scene, so ordinal 1 within its own kind —
    // there is no primary video row ahead of it to share a counter with.
    expect(vid1?.ordinal).toBe(1);

    // The tags on either side of it in the SAME prompt still get exactly
    // the kind their own asset actually is, unaffected by video's arrival.
    const img1 = rows.find((r) => r.tag === "img1");
    expect(img1?.kind).toBe("image");
    // Second image row: the primary upload above already spent ordinal 1
    // of kind "image", so a shared counter (rather than one per kind) would
    // have wrongly given img1 ordinal 3, not 2.
    expect(img1?.ordinal).toBe(2);
    const aud1 = rows.find((r) => r.tag === "aud1");
    expect(aud1?.kind).toBe("audio");
    expect(aud1?.ordinal).toBe(1);

    // Storage WAS copied for the video now — the same treatment its image
    // and audio neighbours get, not the "polite skip" this suite used to
    // assert.
    expect(spies.copyStorageObject).toHaveBeenCalledWith(
      "projects/other/video_ref/vid1.mp4",
      expect.anything(),
    );

    // And the copied asset is filed under assets.kind = 'video_ref', the
    // same vocabulary 0093 gave an uploaded .mp4 — not 'ref_frame', which
    // is what a denylist reversion would have called it.
    const assetInsertCalls = spies.insert.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).storage_key !== undefined,
    );
    expect(
      assetInsertCalls.some((call) => (call[0] as { kind: string }).kind === "video_ref"),
      "no copied asset was filed under kind 'video_ref'",
    ).toBe(true);
  });

  // THE REGRESSION CONCURRENCY COULD HAVE INTRODUCED. attachSceneReferences
  // now copies every tagged reference at once instead of one at a time (the
  // 4-reference scene that measured 2.5s sequentially on prod), and ordinals
  // are assigned from the PROMPT's own order before any copy starts — see
  // that function's own comment on `takeOrdinal`. This pins that a slow
  // first reference does not lose its ordinal to a faster later one.
  it("assigns ordinals by the prompt's own order, not by which copy resolves first", async () => {
    const spies = mockWriteSurfaces({
      elementNames: [
        { name: "img1", description: "first in the prompt", assetKind: "ref_frame" },
        { name: "img2", description: "second in the prompt", assetKind: "ref_frame" },
      ],
      assetsById: {
        "asset-img1": { storage_key: "projects/other/ref_frame/img1.png", kind: "ref_frame" },
        "asset-img2": { storage_key: "projects/other/ref_frame/img2.png", kind: "ref_frame" },
      },
    });

    // img1 is tagged FIRST but its copy resolves LAST — if ordinals were
    // handed out as each copy completed instead of from the prompt's own
    // order (computed up front, before either copy starts), img2 would win
    // the lower ordinal and img1 would be pushed behind it.
    spies.copyStorageObject.mockImplementation(async (from) => {
      if (from === "projects/other/ref_frame/img1.png") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    const { generateClip } = await import("./ugc");
    const result = await generateClip(aClipForm({ prompt: "@img1 then @img2" }));
    expect(result ?? {}, "a slow copy must not fail the render").not.toHaveProperty("error");

    const refCall = spies.insert.mock.calls.find(
      (call) => Array.isArray(call[0]) && (call[0] as unknown[]).length > 0,
    );
    expect(refCall, "no scene_references rows were written").toBeTruthy();
    const rows = refCall![0] as { kind: string; ordinal: number; tag: string | null }[];

    const img1 = rows.find((r) => r.tag === "img1");
    const img2 = rows.find((r) => r.tag === "img2");
    // The primary upload already spent ordinal 1 of kind "image".
    expect(
      img1?.ordinal,
      "img1 is first in the prompt and must keep ordinal 2 even though its own copy finished last",
    ).toBe(2);
    expect(img2?.ordinal).toBe(3);
  });
});

describe("resolveElementTags declares a voice once instead of pasting it repeatedly", () => {
  // THE BUG, hit in production on 2026-08-30: an operator wrote "@Audio_5"
  // four times, and the old substitution pasted the same ~200-character
  // voice description into all four spots, growing a 2310-character prompt
  // to 5463. declareAudioTags (lib/element-tags.ts) is the unit-level fix;
  // these exercise it through resolveElementTags, the way generateClip
  // actually calls it, with the elements/assets lookup this function added.
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("declares an audio tag once and leaves bare names at all four occurrences", async () => {
    const spies = mockWriteSurfaces({
      elementNames: [{ name: "Audio_5", description: "a bright, warm voice", assetKind: "audio" }],
    });

    const { generateClip } = await import("./ugc");
    await generateClip(
      aClipForm({
        prompt: "driven by @Audio_5, the @Audio_5 waveform, and the @Audio_5 dialogue track",
        operatorPrompt:
          "driven by @Audio_5, the @Audio_5 waveform, and the @Audio_5 dialogue track",
      }),
    );

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    const written = sceneCall![0] as { ai_generated_prompt?: string | null };
    const submitted = written.ai_generated_prompt ?? "";

    expect(submitted.match(/a bright, warm voice/g)).toHaveLength(1);
    expect(submitted).toBe(
      "Audio_5 is a bright, warm voice.\n\n" +
        "driven by Audio_5, the Audio_5 waveform, and the Audio_5 dialogue track",
    );
    expect(submitted).not.toContain("@");
  });

  it("leaves an undescribed audio tag as '@name', still strippable by bindUITags", async () => {
    const spies = mockWriteSurfaces({
      elementNames: [{ name: "voice1", description: null, assetKind: "audio" }],
    });

    const { generateClip } = await import("./ugc");
    await generateClip(
      aClipForm({ prompt: "spoken by @voice1", operatorPrompt: "spoken by @voice1" }),
    );

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    const written = sceneCall![0] as { ai_generated_prompt?: string | null };
    // null means "unchanged from video_prompt" — resolveElementTags did
    // nothing at all, which is the point: no declaration was earned.
    expect(written.ai_generated_prompt ?? null).toBeNull();
  });

  it("still inline-substitutes an image tag at every occurrence, unchanged", async () => {
    const spies = mockWriteSurfaces({
      elementNames: [
        { name: "lena", description: "a woman with blonde hair", assetKind: "ref_frame" },
      ],
    });

    const { generateClip } = await import("./ugc");
    await generateClip(
      aClipForm({
        prompt: "@lena walks in. Subject Lock — @lena",
        operatorPrompt: "@lena walks in. Subject Lock — @lena",
      }),
    );

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    const written = sceneCall![0] as { ai_generated_prompt?: string | null };
    expect(written.ai_generated_prompt).toBe(
      "a woman with blonde hair walks in. Subject Lock — a woman with blonde hair",
    );
  });

  it("handles one prompt mixing a declared voice and an inline-substituted image", async () => {
    const spies = mockWriteSurfaces({
      elementNames: [
        { name: "lena", description: "a woman with blonde hair", assetKind: "ref_frame" },
        { name: "Audio_5", description: "a bright, warm voice", assetKind: "audio" },
      ],
    });

    const { generateClip } = await import("./ugc");
    await generateClip(
      aClipForm({
        prompt: "@lena speaks, driven by @Audio_5, then @lena nods to @Audio_5 again",
        operatorPrompt: "@lena speaks, driven by @Audio_5, then @lena nods to @Audio_5 again",
      }),
    );

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    const written = sceneCall![0] as { ai_generated_prompt?: string | null };
    expect(written.ai_generated_prompt).toBe(
      "Audio_5 is a bright, warm voice.\n\n" +
        "a woman with blonde hair speaks, driven by Audio_5, then a woman with blonde hair nods to Audio_5 again",
    );
  });

  it("returns the prompt unchanged when it has no tags", async () => {
    const spies = mockWriteSurfaces({ elementNames: [] });

    const { generateClip } = await import("./ugc");
    await generateClip(aClipForm({ prompt: "a quiet kitchen", operatorPrompt: "a quiet kitchen" }));

    const sceneCall = spies.insert.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).video_prompt !== undefined,
    );
    const written = sceneCall![0] as { ai_generated_prompt?: string | null };
    expect(written.ai_generated_prompt ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// restoreScene: undoes deleteClipScene from 0088_deleted_scenes.sql's
// archive.
//
// The admin/session clients below are hand-modelled per call, not a generic
// postgrest stub — restoreScene's own call sequence is fixed (read the
// archive via the SESSION client, requireProject, read the project's last
// idx, insert scenes, insert assets/scene_versions/scene_references, patch
// the two circular FKs back in, delete the archive row) and a stub that
// answered anything would let a reordering, or a guard skipped in front of
// an admin-client call, slip past silently. See restoreScene's own doc
// comment for why the first read has to go through createClient(), not
// createAdminClient().
// ---------------------------------------------------------------------------

/** A full scenes Row, shaped like to_jsonb(OLD) would actually produce it. */
function anArchivedSceneSnapshot(
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "scene-1",
    project_id: "proj-1",
    idx: 2,
    status: "done",
    video_prompt: "a prompt",
    ai_generated_prompt: null,
    duration_s: 8,
    created_at: "2026-08-01T00:00:00.000Z",
    dev: false,
    edited_by_human: false,
    kie_task_id: null,
    is_talking_head: false,
    ref_frame_asset_id: null,
    active_version_id: null,
    render_settings_override: null,
    script_line: null,
    submitted_at: null,
    template_id: null,
    visual_idea: null,
    ...over,
  };
}

/** A deleted_scenes row, as `select("*")` would return it. */
function anArchivedRow(
  over: Partial<{
    scene_id: string;
    project_id: string | null;
    user_id: string | null;
    scene_idx: number | null;
    deleted_at: string;
    scene: Record<string, unknown>;
    assets: unknown[];
    versions: unknown[];
    refs: unknown[];
  }> = {},
): Record<string, unknown> {
  return {
    scene_id: over.scene_id ?? "scene-1",
    project_id: over.project_id === undefined ? "proj-1" : over.project_id,
    user_id: over.user_id ?? "user-1",
    scene_idx: over.scene_idx ?? 2,
    deleted_at: over.deleted_at ?? new Date().toISOString(),
    scene: over.scene ?? anArchivedSceneSnapshot(),
    assets: over.assets ?? [],
    versions: over.versions ?? [],
    refs: over.refs ?? [],
  };
}

/**
 * Hand-modelled admin client covering exactly the calls restoreScene makes
 * against it (everything AFTER requireProject) — see this suite's own
 * header for why a generic stub is the wrong shape here.
 *
 * `claimedRow` is what the CLAIM (the atomic `delete ... returning` this
 * suite's own header now documents) hands back — pass the same row the
 * test's `buildRestoreSessionMock` was given, so the values restoreScene
 * writes still come from a single, consistent archive snapshot. `null`
 * models the other caller having already won the race — see the "already
 * restored" test below.
 *
 * `calls` records each spy's label in invocation order, shared across every
 * spy this mock exposes, so a test can assert ORDERING (e.g. "the claim
 * happens before a single `scenes` row is touched") and not just occurrence.
 */
function buildRestoreAdminMock(opts: {
  lastIdx: number | null;
  claimedRow?: Record<string, unknown> | null;
  claimError?: { message: string } | null;
  assetsError?: { message: string } | null;
  versionsError?: { message: string } | null;
  refsError?: { message: string } | null;
  reinsertError?: { message: string } | null;
  compensateDeleteError?: { message: string } | null;
  /** What the post-claim re-read finds: a row with hard_deleted_at set means
   * the entry was purged, not raced. Null models the raced case. */
  purgedRow?: Record<string, unknown> | null;
}) {
  const calls: string[] = [];
  const claimSpy = vi.fn();
  const claimPurgeFilterSpy = vi.fn();
  const sceneInsertSpy = vi.fn();
  const assetsInsertSpy = vi.fn();
  const versionsInsertSpy = vi.fn();
  const refsInsertSpy = vi.fn();
  const sceneUpdateSpy = vi.fn();
  const sceneDeleteSpy = vi.fn();
  const reinsertSpy = vi.fn();

  const from = (table: string) => ({
    select: () => {
      if (table === "scenes") {
        return {
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: opts.lastIdx === null ? null : { idx: opts.lastIdx },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      // After a claim comes back empty, restoreScene reads the row again to
      // find out WHICH empty it is: lost the race, or purged. Two different
      // pieces of news, and the editor gets told which.
      if (table === "deleted_scenes") {
        return {
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.purgedRow ?? null,
              error: null,
            }),
          }),
        };
      }
      throw new Error(`unmodelled select on ${table}`);
    },
    insert: (rows: unknown) => {
      if (table === "scenes") {
        calls.push("sceneInsert");
        sceneInsertSpy(rows);
        return {
          select: () => ({
            single: async () => ({ data: { id: "scene-1" }, error: null }),
          }),
        };
      }
      if (table === "assets") {
        assetsInsertSpy(rows);
        return Promise.resolve({ data: null, error: opts.assetsError ?? null });
      }
      if (table === "scene_versions") {
        versionsInsertSpy(rows);
        return Promise.resolve({ data: null, error: opts.versionsError ?? null });
      }
      if (table === "scene_references") {
        refsInsertSpy(rows);
        return Promise.resolve({ data: null, error: opts.refsError ?? null });
      }
      if (table === "deleted_scenes") {
        // Compensation's reinsert — puts `claimed` back before the catch's
        // own `scenes` delete runs. See this file's restoreScene catch
        // comment for why that order is load-bearing.
        calls.push("reinsert");
        reinsertSpy(rows);
        return Promise.resolve({ data: null, error: opts.reinsertError ?? null });
      }
      throw new Error(`unmodelled insert on ${table}`);
    },
    update: (patch: unknown) => {
      if (table === "scenes") {
        sceneUpdateSpy(patch);
        return { eq: () => Promise.resolve({ data: null, error: null }) };
      }
      throw new Error(`unmodelled update on ${table}`);
    },
    delete: () => {
      if (table === "deleted_scenes") {
        return {
          eq: (col: string, val: string) => {
            calls.push("claim");
            claimSpy(col, val);
            // `.is("hard_deleted_at", null)` (0092) is part of the claim, not
            // decoration: it is what stops a scene already purged from the bin
            // being restored back out of it. Modelled rather than skipped so a
            // test can assert the filter is really there.
            return {
              is: (col2: string, val2: unknown) => {
                claimPurgeFilterSpy(col2, val2);
                return {
                  select: () => ({
                    maybeSingle: async () => ({
                      data: opts.claimError ? null : (opts.claimedRow ?? null),
                      error: opts.claimError ?? null,
                    }),
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "scenes") {
        return {
          eq: (col: string, val: string) => {
            calls.push("compensateDelete");
            sceneDeleteSpy(col, val);
            return Promise.resolve({ data: null, error: opts.compensateDeleteError ?? null });
          },
        };
      }
      throw new Error(`unmodelled delete on ${table}`);
    },
  });

  return {
    from,
    calls,
    claimSpy,
    sceneInsertSpy,
    assetsInsertSpy,
    versionsInsertSpy,
    refsInsertSpy,
    sceneUpdateSpy,
    sceneDeleteSpy,
    reinsertSpy,
    claimPurgeFilterSpy,
  };
}

/** The session-client half: only ever reads deleted_scenes, once. */
function buildRestoreSessionMock(archived: Record<string, unknown> | null) {
  return {
    from: (table: string) => {
      if (table !== "deleted_scenes") throw new Error(`unmodelled select on ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: archived, error: null }) }),
        }),
      };
    },
  };
}

describe("restoreScene", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("assigns a fresh trailing idx rather than reusing the archived one", async () => {
    // The scene was scene_idx 2 when it was deleted, but the project's live
    // scenes have since been repacked and idx 2 is taken again — 5 is now
    // the highest live idx, so the restore must land at 6, not 2.
    const archived = anArchivedRow({ scene_idx: 2, scene: anArchivedSceneSnapshot({ idx: 2 }) });
    const adminMock = buildRestoreAdminMock({ lastIdx: 5, claimedRow: archived });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    const result = await restoreScene(form);

    expect(result).toBeUndefined();
    expect(adminMock.sceneInsertSpy).toHaveBeenCalledTimes(1);
    const written = adminMock.sceneInsertSpy.mock.calls[0]![0] as { idx: number };
    expect(written.idx, "restored at the OLD slot instead of appended after the live max").toBe(6);
  });

  it("claims only a bin entry that has not been permanently removed", async () => {
    // The purge in 0092 does not delete the archive row, it marks it. So the
    // claim is the only thing standing between "emptied from the bin" and
    // "restored anyway", and it stands there by way of one filter. A restore
    // that reached the row regardless would undo a deliberate deletion.
    const archived = anArchivedRow({});
    const adminMock = buildRestoreAdminMock({ lastIdx: 0, claimedRow: archived });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    await restoreScene(form);

    expect(
      adminMock.claimPurgeFilterSpy,
      "the claim no longer filters on hard_deleted_at — a purged scene can be restored",
    ).toHaveBeenCalledWith("hard_deleted_at", null);
  });

  it("brings back the assets/versions/scene_references rows", async () => {
    const asset = { id: "asset-1", project_id: "proj-1", scene_id: "scene-1", kind: "ref_frame" };
    const version = { id: "ver-1", scene_id: "scene-1", n: 1 };
    const ref = {
      id: "ref-1",
      scene_id: "scene-1",
      asset_id: "asset-1",
      kind: "image",
      ordinal: 1,
    };
    const archived = anArchivedRow({ assets: [asset], versions: [version], refs: [ref] });
    const adminMock = buildRestoreAdminMock({ lastIdx: null, claimedRow: archived });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    await restoreScene(form);

    expect(adminMock.assetsInsertSpy).toHaveBeenCalledWith([asset]);
    expect(adminMock.versionsInsertSpy).toHaveBeenCalledWith([version]);
    expect(adminMock.refsInsertSpy).toHaveBeenCalledWith([ref]);
  });

  it("claims the trash entry via an atomic delete...returning, before a single `scenes` row is touched", async () => {
    // THE FIX FOR F1: the old code deleted `deleted_scenes` only at the very
    // END, after every insert had succeeded (RULE 3), which is exactly what
    // let two overlapping restores both pass a plain read and both reach
    // the inserts. Now the delete IS the claim, and it has to run first —
    // see this suite's own describe-level interleaving test below for the
    // race this ordering closes.
    const archived = anArchivedRow();
    const adminMock = buildRestoreAdminMock({ lastIdx: null, claimedRow: archived });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    const result = await restoreScene(form);

    expect(result).toBeUndefined();
    expect(adminMock.claimSpy).toHaveBeenCalledWith("scene_id", "scene-1");
    expect(
      adminMock.calls.indexOf("claim"),
      "the claim must run before the scene insert, not after",
    ).toBeLessThan(adminMock.calls.indexOf("sceneInsert"));
  });

  it.each(["queued", "rendering"] as const)(
    "clamps a %s archived status to failed rather than reviving a spend trigger",
    async (dangerousStatus) => {
      const archived = anArchivedRow({
        scene: anArchivedSceneSnapshot({ status: dangerousStatus }),
      });
      const adminMock = buildRestoreAdminMock({ lastIdx: null, claimedRow: archived });

      vi.doMock("@/actions/guard", () => ({
        requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
        requireProject: async () => ({ project: { id: "proj-1" } }),
        requireScene: async () => ({}),
      }));
      vi.doMock("@/lib/supabase/server", () => ({
        createClient: async () => buildRestoreSessionMock(archived),
        createAdminClient: () => adminMock,
      }));
      vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

      const { restoreScene } = await import("./ugc");
      const form = new FormData();
      form.set("sceneId", "scene-1");
      await restoreScene(form);

      const written = adminMock.sceneInsertSpy.mock.calls[0]![0] as { status: string };
      expect(
        written.status,
        `restored a ${dangerousStatus} scene as ${written.status} — ClaimQueuedScenes could pick this up and spend real money`,
      ).toBe("failed");
    },
  );

  it("leaves a done/failed archived status exactly as it was", async () => {
    // The clamp is narrowly for queued/rendering — this pins that it does
    // NOT also rewrite the ordinary case, which a careless `?? "failed"` or
    // an inverted condition would both pass the test above while failing
    // this one.
    const archived = anArchivedRow({ scene: anArchivedSceneSnapshot({ status: "done" }) });
    const adminMock = buildRestoreAdminMock({ lastIdx: null, claimedRow: archived });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    await restoreScene(form);

    const written = adminMock.sceneInsertSpy.mock.calls[0]![0] as { status: string };
    expect(written.status).toBe("done");
  });

  it("refuses a non-owner exactly the way deleteClipScene does", async () => {
    // RLS on deleted_scenes (`user_id = auth.uid() or is_admin()`) can admit
    // an ADMIN's read even when they are not the owner — requireProject is
    // what still has to refuse them, same as deleteClipScene's own
    // requireScene->requireProject chain, via the exact same notFound().
    const archived = anArchivedRow();
    const adminMock = buildRestoreAdminMock({ lastIdx: null });
    const requireProject = vi.fn(async () => {
      throw new Error("NEXT_NOT_FOUND");
    });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "admin-1" }, profile: {} }),
      requireProject,
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");

    await expect(restoreScene(form)).rejects.toThrow(/NEXT_NOT_FOUND/);

    expect(requireProject).toHaveBeenCalledWith("proj-1");
    expect(
      adminMock.sceneInsertSpy,
      "requireProject refused, so nothing should have reached the admin client at all",
    ).not.toHaveBeenCalled();
  });

  it("refuses a stranger before requireProject is even asked, via RLS on the read itself", async () => {
    // A plain (non-admin) stranger's session client gets no row back at all
    // — deleted_scenes_select's RLS filters it, exactly like a stranger
    // querying `scenes` directly. This is the OTHER half of "refused exactly
    // like deleteClipScene": the row-missing branch, not the ownership
    // branch above.
    const requireProject = vi.fn();
    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "stranger-1" }, profile: {} }),
      requireProject,
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(null),
      createAdminClient: () => {
        throw new Error(
          "the admin client must never be reached for a row RLS already filtered out",
        );
      },
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    const result = await restoreScene(form);

    expect(result?.error).toMatch(/not in the trash/i);
    expect(requireProject).not.toHaveBeenCalled();
  });

  it("refuses without a scene id rather than restoring nothing", async () => {
    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(null),
      createAdminClient: () => {
        throw new Error("must not touch the database with no scene id");
      },
    }));

    const { restoreScene } = await import("./ugc");
    const result = await restoreScene(new FormData());

    expect(result?.error).toMatch(/no scene to restore/i);
  });

  it("refuses to restore a scene that has been in the bin for more than 2 weeks", async () => {
    const expiredDeletedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const archived = anArchivedRow({ deleted_at: expiredDeletedAt });
    const adminMock = buildRestoreAdminMock({ lastIdx: null, claimedRow: archived });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    const result = await restoreScene(form);

    expect(result?.error).toMatch(/expired from the bin after 2 weeks/i);
    expect(adminMock.sceneInsertSpy).not.toHaveBeenCalled();
  });

  // THE BUG: a scene inserted, then assets/versions/refs/patch failing
  // partway, used to leave a half-restored scene behind AND leave the
  // archive row gone nowhere — reusing the ORIGINAL scene id (unlike
  // generateClip's always-fresh one) meant every later Restore attempt on
  // that same trash entry then failed on a duplicate key, forever. The fix
  // is now two-part: the claim already deleted the archive row before a
  // single insert ran, so the catch must REINSERT it (not merely leave it
  // alone, RULE 3 style) before deleting the scene it partially wrote — see
  // restoreScene's own catch comment for why that order matters. This is
  // the assertion that matters: a SECOND restore attempt, after the first
  // failed, succeeds — which depends on the reinsert having put the row
  // back within reach of a second claim.
  it("compensates a partial failure: no scene is left behind, the archive row is reinserted before it, and a retry then succeeds", async () => {
    const asset = { id: "asset-1", project_id: "proj-1", scene_id: "scene-1", kind: "ref_frame" };
    const archived = anArchivedRow({ assets: [asset] });

    let assetsShouldFail = true;
    // Models deleted_scenes' one row for scene-1 — starts present, exactly
    // like the real table before any restore attempt.
    let archivePresent = true;
    const liveSceneIds = new Set<string>();
    const sceneInsertSpy = vi.fn();
    const sceneDeleteSpy = vi.fn();
    const assetsInsertSpy = vi.fn();
    const claimSpy = vi.fn();
    const reinsertSpy = vi.fn();
    const callOrder: string[] = [];

    const adminMock = {
      from: (table: string) => ({
        select: () => {
          if (table === "scenes") {
            return {
              eq: () => ({
                order: () => ({
                  limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
                }),
              }),
            };
          }
          throw new Error(`unmodelled select on ${table}`);
        },
        insert: (rows: unknown) => {
          if (table === "scenes") {
            sceneInsertSpy(rows);
            liveSceneIds.add("scene-1");
            return {
              select: () => ({ single: async () => ({ data: { id: "scene-1" }, error: null }) }),
            };
          }
          if (table === "assets") {
            assetsInsertSpy(rows);
            return Promise.resolve({
              data: null,
              error: assetsShouldFail ? { message: "connection reset" } : null,
            });
          }
          if (table === "scene_versions" || table === "scene_references") {
            return Promise.resolve({ data: null, error: null });
          }
          if (table === "deleted_scenes") {
            // Compensation's reinsert.
            callOrder.push("reinsert");
            reinsertSpy(rows);
            archivePresent = true;
            return Promise.resolve({ data: null, error: null });
          }
          throw new Error(`unmodelled insert on ${table}`);
        },
        update: () => {
          throw new Error(
            "no ref_frame_asset_id/active_version_id in this fixture — should not be reached",
          );
        },
        delete: () => {
          if (table === "scenes") {
            return {
              eq: (col: string, val: string) => {
                callOrder.push("compensateDelete");
                sceneDeleteSpy(col, val);
                liveSceneIds.delete(val);
                return Promise.resolve({ data: null, error: null });
              },
            };
          }
          if (table === "deleted_scenes") {
            return {
              eq: (col: string, val: string) => {
                callOrder.push("claim");
                claimSpy(col, val);
                // The claim's `.is("hard_deleted_at", null)` (0092). Modelled
                // here too, so this concurrency test exercises the same chain
                // the single-restore tests do rather than a shorter one.
                return {
                  is: () => {
                    const wasPresent = archivePresent;
                    archivePresent = false;
                    return {
                      select: () => ({
                        maybeSingle: async () => ({
                          data: wasPresent ? archived : null,
                          error: null,
                        }),
                      }),
                    };
                  },
                };
              },
            };
          }
          throw new Error(`unmodelled delete on ${table}`);
        },
      }),
    };

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");

    // Attempt 1: the claim succeeds, the scene inserts, then the assets
    // insert fails.
    await expect(restoreScene(form)).rejects.toThrow(/scene's assets/i);

    expect(claimSpy).toHaveBeenCalledWith("scene_id", "scene-1");
    expect(
      reinsertSpy,
      "the archive row was never put back — a retry would find nothing left to claim",
    ).toHaveBeenCalledWith(archived);
    expect(
      sceneDeleteSpy,
      "the compensating delete never ran — a half-restored scene was left behind",
    ).toHaveBeenCalledWith("id", "scene-1");
    expect(liveSceneIds.has("scene-1"), "the scene is still live after a failed restore").toBe(
      false,
    );
    expect(archivePresent, "the archive row must be back in the trash after compensation").toBe(
      true,
    );
    expect(
      callOrder.indexOf("reinsert"),
      "the archive row must be reinserted BEFORE the partial scene is deleted, or the delete's own " +
        "archive trigger has nothing to conflict with and overwrites the original snapshot — see " +
        "restoreScene's own catch comment",
    ).toBeLessThan(callOrder.indexOf("compensateDelete"));

    // Attempt 2: same trash entry, assets insert now succeeds. THIS is the
    // assertion that matters — before the fix, this call failed on a
    // duplicate key against the scene attempt 1 left behind; the fix
    // depends on the reinsert above having put the archive row back within
    // reach of a second claim, not on some leftover RULE-3-style flag.
    assetsShouldFail = false;
    const secondResult = await restoreScene(form);

    expect(secondResult).toBeUndefined();
    expect(sceneInsertSpy).toHaveBeenCalledTimes(2);
    expect(claimSpy).toHaveBeenCalledTimes(2);
    expect(
      archivePresent,
      "a successful restore claims and consumes the trash entry, same as always",
    ).toBe(false);
  });

  it("refuses a second restore of an entry another call already claimed, without touching `scenes` at all", async () => {
    // The claim itself returning nothing — the shape a second, overlapping
    // caller sees once the first has already won. Isolated here (fast,
    // no real interleaving needed) as a direct pin of the refusal message;
    // the interleaving test below is what proves the race is actually
    // closed end-to-end.
    const archived = anArchivedRow();
    const adminMock = buildRestoreAdminMock({ lastIdx: null, claimedRow: null });

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => buildRestoreSessionMock(archived),
      createAdminClient: () => adminMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    const result = await restoreScene(form);

    expect(result?.error).toMatch(/already.*restored/i);
    expect(
      adminMock.sceneInsertSpy,
      "lost the race, so must never reach an insert",
    ).not.toHaveBeenCalled();
  });

  // THE INTERLEAVING ITSELF — not two sequential calls. Both restoreScene()
  // invocations are started together (Promise.all, no await between them)
  // against a SHARED, mutable fake table store, so their internal awaits
  // genuinely interleave via the JS microtask queue exactly the way two
  // browser tabs' network round trips would. Neither call is told about the
  // other; only the claim (a synchronous check-and-delete on the shared
  // store, standing in for Postgres's own atomic row-level DELETE — see
  // this suite's own header) decides who wins, because a synchronous
  // Map.get+delete cannot itself be interrupted by the other call's
  // microtask, regardless of how the rest of the two calls interleave
  // around it.
  it("two overlapping restores of the SAME entry: exactly one succeeds, and the winner's scene/version/asset/ref all survive intact", async () => {
    const asset = { id: "asset-1", project_id: "proj-1", scene_id: "scene-1", kind: "ref_frame" };
    const version = { id: "ver-1", scene_id: "scene-1", n: 1 };
    const ref = {
      id: "ref-1",
      scene_id: "scene-1",
      asset_id: "asset-1",
      kind: "image",
      ordinal: 1,
    };
    const archivedRow = anArchivedRow({ assets: [asset], versions: [version], refs: [ref] });

    type Row = Record<string, unknown>;
    const store = {
      scenes: new Map<string, Row>(),
      assets: new Map<string, Row>(),
      scene_versions: new Map<string, Row>(),
      scene_references: new Map<string, Row>(),
      deleted_scenes: new Map<string, Row>([["scene-1", archivedRow]]),
    };
    type TableName = keyof typeof store;
    const asTable = (t: string): TableName => t as TableName;

    const admin = {
      from: (table: string) => ({
        select: () => {
          if (table === "scenes") {
            return {
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => {
                      const rows = [...store.scenes.values()];
                      const maxIdx = rows.reduce((m, r) => Math.max(m, r.idx as number), 0);
                      return { data: rows.length ? { idx: maxIdx } : null, error: null };
                    },
                  }),
                }),
              }),
            };
          }
          // The loser of the race re-reads the archive to find out whether it
          // lost or whether the entry had been purged. Here it always lost:
          // the winner deleted the row, so there is nothing with a
          // hard_deleted_at to find, and the refusal says "already restored".
          if (table === "deleted_scenes") {
            return {
              eq: (_col: string, val: string) => ({
                maybeSingle: async () => ({
                  data: store.deleted_scenes.get(val) ?? null,
                  error: null,
                }),
              }),
            };
          }
          throw new Error(`unmodelled select on ${table}`);
        },
        insert: (rowsOrRow: unknown) => {
          if (table === "scenes") {
            const row = rowsOrRow as Row;
            return {
              select: () => ({
                single: async () => {
                  if (store.scenes.has(row.id as string)) {
                    // Real Postgres would refuse this with a duplicate-key
                    // error (scenes_pkey) — the fixed claim should make this
                    // branch unreachable; it stays here so a regression
                    // fails loudly instead of two scenes silently coexisting.
                    return {
                      data: null,
                      error: {
                        message: 'duplicate key value violates unique constraint "scenes_pkey"',
                      },
                    };
                  }
                  store.scenes.set(row.id as string, row);
                  return { data: { id: row.id }, error: null };
                },
              }),
            };
          }
          if (table === "assets" || table === "scene_versions" || table === "scene_references") {
            const rows = rowsOrRow as Row[];
            return (async () => {
              for (const r of rows) store[asTable(table)].set(r.id as string, r);
              return { data: null, error: null };
            })();
          }
          if (table === "deleted_scenes") {
            const row = rowsOrRow as Row;
            return (async () => {
              store.deleted_scenes.set(row.scene_id as string, row);
              return { data: null, error: null };
            })();
          }
          throw new Error(`unmodelled insert on ${table}`);
        },
        update: (patch: unknown) => {
          if (table === "scenes") {
            return {
              eq: (_col: string, val: string) =>
                (async () => {
                  const existing = store.scenes.get(val);
                  if (existing) store.scenes.set(val, { ...existing, ...(patch as object) });
                  return { data: null, error: null };
                })(),
            };
          }
          throw new Error(`unmodelled update on ${table}`);
        },
        delete: () => {
          if (table === "deleted_scenes") {
            return {
              eq: (_col: string, val: string) => ({
                is: () => ({
                  select: () => ({
                    maybeSingle: async () => {
                      // THE CLAIM. Synchronous check-and-delete, no `await`
                      // anywhere above it in this call — JS run-to-completion
                      // means this line always finishes before the OTHER
                      // call's own claim can run, no matter how their
                      // surrounding awaits interleave. This is what makes
                      // "whoever gets the row owns the restore" true.
                      const row = store.deleted_scenes.get(val) ?? null;
                      store.deleted_scenes.delete(val);
                      return { data: row, error: null };
                    },
                  }),
                }),
              }),
            };
          }
          if (table === "scenes") {
            return {
              eq: (_col: string, val: string) =>
                (async () => {
                  store.scenes.delete(val);
                  for (const [k, v] of store.assets) if (v.scene_id === val) store.assets.delete(k);
                  for (const [k, v] of store.scene_versions)
                    if (v.scene_id === val) store.scene_versions.delete(k);
                  for (const [k, v] of store.scene_references)
                    if (v.scene_id === val) store.scene_references.delete(k);
                  return { data: null, error: null };
                })(),
            };
          }
          throw new Error(`unmodelled delete on ${table}`);
        },
      }),
    };

    const session = {
      from: (table: string) => {
        if (table !== "deleted_scenes") throw new Error(`unmodelled select on ${table}`);
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => ({
                data: store.deleted_scenes.get(val) ?? null,
                error: null,
              }),
            }),
          }),
        };
      },
    };

    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => session,
      createAdminClient: () => admin,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { restoreScene } = await import("./ugc");
    const form1 = new FormData();
    form1.set("sceneId", "scene-1");
    const form2 = new FormData();
    form2.set("sceneId", "scene-1");

    // NOT sequential awaits — both start before either finishes, so their
    // internal awaits genuinely interleave. This is the "not just two
    // sequential calls" this suite's own header promises.
    const [result1, result2] = await Promise.all([restoreScene(form1), restoreScene(form2)]);

    const results = [result1, result2];
    const successes = results.filter((r) => r === undefined);
    const refusals = results.filter((r): r is { error: string } => Boolean(r?.error));

    expect(successes, "exactly one of the two overlapping restores should succeed").toHaveLength(1);
    expect(
      refusals,
      "the other must be refused outright, not silently destroy what the winner wrote",
    ).toHaveLength(1);
    expect(refusals[0]?.error).toMatch(/already.*restored/i);

    expect(store.scenes.size, "the winner's scene must survive").toBe(1);
    expect(store.scene_versions.size, "the winner's version must survive").toBe(1);
    expect(store.assets.size, "the winner's asset must survive").toBe(1);
    expect(store.scene_references.size, "the winner's reference must survive").toBe(1);
    expect(
      store.deleted_scenes.has("scene-1"),
      "the trash entry must be gone after a successful restore, not left behind",
    ).toBe(false);
  });
});

describe("purgeDeletedScene and purgeDeletedVersion (admin-only permanent delete)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("refuses a non-admin caller via requireAdmin before touching the admin client", async () => {
    const requireAdmin = vi.fn(async () => {
      throw new Error("User user-1 is not an admin.");
    });
    vi.doMock("@/actions/guard", () => ({
      requireAdmin,
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({}),
      createAdminClient: () => {
        throw new Error("admin client must not be reached when requireAdmin rejects");
      },
    }));

    const { purgeDeletedScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");

    await expect(purgeDeletedScene(form)).rejects.toThrow(/not an admin/i);
    expect(requireAdmin).toHaveBeenCalledTimes(1);
  });

  it("hard-deletes the archive row and removes unreferenced Storage objects for an admin", async () => {
    const removeStorageObjects = vi.fn(async () => {});
    const deleteSpy = vi.fn();

    vi.doMock("@/actions/guard", () => ({
      requireAdmin: async () => ({ user: { id: "admin-1" }, profile: { role: "admin" } }),
      requireUser: async () => ({ user: { id: "admin-1" }, profile: { role: "admin" } }),
      requireProject: async () => ({ project: { id: "proj-1" } }),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/storage", async () => {
      const actual = await vi.importActual<typeof StorageModule>("@/lib/storage");
      return { ...actual, removeStorageObjects };
    });
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({}),
      createAdminClient: () => ({
        from: (table: string) => {
          if (table === "deleted_scenes") {
            return {
              delete: () => ({
                eq: (col: string, val: string) => {
                  deleteSpy(col, val);
                  return {
                    select: () => ({
                      maybeSingle: async () => ({
                        data: {
                          scene_id: "scene-1",
                          project_id: "proj-1",
                          assets: [
                            { kind: "clip", storage_key: "projects/proj-1/clip/c1.mp4" },
                            { kind: "poster", storage_key: "projects/proj-1/poster/p1.jpg" },
                          ],
                        },
                        error: null,
                      }),
                    }),
                  };
                },
              }),
            };
          }
          if (table === "assets") {
            return {
              select: () => ({
                in: async () => ({ data: [], error: null }),
              }),
            };
          }
          throw new Error(`unmodelled table ${table}`);
        },
      }),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));

    const { purgeDeletedScene } = await import("./ugc");
    const form = new FormData();
    form.set("sceneId", "scene-1");
    const result = await purgeDeletedScene(form);

    expect(result).toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledWith("scene_id", "scene-1");
    expect(removeStorageObjects).toHaveBeenCalledWith([
      "projects/proj-1/clip/c1.mp4",
      "projects/proj-1/poster/p1.jpg",
    ]);
  });
});

/**
 * THE CAP IS CHECKED AGAINST THE WHOLE BILL, VIDEO INCLUDED.
 *
 * A video reference is billed on top of the clip's own seconds, and until
 * 2026-09-10 nothing told the cap so: estimateCost had taken a
 * `videoReferenceDurationsS` since the day video shipped and no caller in the
 * product ever passed one. The parameter existed and the unit tests
 * exercised it, so every layer looked covered while every real quote went
 * out short.
 *
 * These assert the NUMBER HANDED TO assertWithinSpendCaps, which is the one
 * thing a cap can be wrong about. Deleting the argument in generateClip
 * turns them red and turns nothing else red.
 */
describe("generateClip prices the video reference into the cap check", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("charges the cap for the video's seconds as well as the clip's", async () => {
    const spies = mockWriteSurfaces({
      elementNames: [
        { name: "greta", assetKind: "ref_frame" },
        { name: "clip1", assetKind: "video_ref", durationS: 4.064 },
      ],
      element: { asset_id: "asset-greta", user_id: "user-1" },
    });
    const form = aClipForm({
      prompt: "@greta sips coffee, @clip1 style",
      durationS: "4",
      resolution: "480p",
      modelId: "seedance-2.5-byteplus",
    });

    const { generateClip } = await import("./ugc");
    await generateClip(form);

    // Output seconds plus the video's own, at the with-video rate. Output-only would have
    // offered the cap less than the bill. Credits are whole numbers, hence two digits.
    const credits = videoRateFor("seedance-2.5-byteplus", "480p")!.creditsPerSecond * (4 + 4.064);
    const charged = (spies.assertWithinSpendCaps.mock.calls[0] as unknown[])?.[2] as number;
    expect(charged, "the cap was checked against a number that is not the bill").toBeCloseTo(
      credits / 200,
      2,
    );
  });

  it("leaves an ordinary clip's cap check exactly where it was", async () => {
    // The branch that must not move. Every render without a video still
    // prices off the sound table.
    const spies = mockWriteSurfaces({
      elementNames: [{ name: "greta", assetKind: "ref_frame" }],
      element: { asset_id: "asset-greta", user_id: "user-1" },
    });
    const form = aClipForm({
      prompt: "@greta sips coffee",
      durationS: "4",
      resolution: "480p",
      modelId: "seedance-2.5-byteplus",
    });

    const { generateClip } = await import("./ugc");
    await generateClip(form);

    expect((spies.assertWithinSpendCaps.mock.calls[0] as unknown[])?.[2] as number).toBeCloseTo(
      (rateFor("seedance-2.5-byteplus", "480p", true)!.creditsPerSecond * 4) / 200,
      2,
    );
  });

  it("refuses to price a video nobody could measure, rather than quoting it free", async () => {
    // assets.duration_s is null when the browser could not decode the file
    // at upload. A cap must refuse what it cannot price; treating the
    // unknown as zero would wave the render through on the output-only
    // figure, which is the exact failure this whole change closes.
    const spies = mockWriteSurfaces({
      elementNames: [
        { name: "greta", assetKind: "ref_frame" },
        { name: "clip1", assetKind: "video_ref", durationS: null },
      ],
      element: { asset_id: "asset-greta", user_id: "user-1" },
    });
    const form = aClipForm({
      prompt: "@greta sips coffee, @clip1 style",
      durationS: "4",
      resolution: "480p",
      modelId: "seedance-2.5-byteplus",
    });

    const { generateClip } = await import("./ugc");
    await generateClip(form);

    expect((spies.assertWithinSpendCaps.mock.calls[0] as unknown[])?.[2] as number).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("a Kling prompt that still @tags a video element is refused, never priced at Infinity", async () => {
    // THE DECISION THAT REPLACED THE OLD FIX. A Kling prompt copied from a
    // Seedance scene can still carry an '@tag' naming a video_ref element —
    // Kling never substitutes and never sends the video (generateClip's own
    // "KLING NEVER SUBSTITUTES" comment) — and until this refusal existed,
    // that tag reached taggedVideoInputDurationsS, which has no rate for
    // Kling's video input and priced the clip at +Infinity, refused
    // downstream as "cannot be priced" with no reason an operator could see.
    // The fix is not to price it specially: it is klingTagRefusal, the same
    // one any other Kling @tag hits, which catches this case before
    // taggedVideoInputDurationsS (or assertWithinSpendCaps) ever runs.
    const spies = mockWriteSurfaces({
      elementNames: [{ name: "clip1", assetKind: "video_ref", durationS: 4.064 }],
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
    });
    const { generateClip } = await import("./ugc");

    const result = await generateClip(
      aKlingClipForm({ prompt: "a dog skateboarding, @clip1 style", resolution: "720p" }),
    );

    expect(result).toEqual({ error: expect.stringMatching(/kling can.t use @tags/i) });
    expect(result?.error).toMatch(/@clip1/);
    expect(spies.assertWithinSpendCaps).not.toHaveBeenCalled();
  });
});

/**
 * THE SERVER REFUSES AN OVER-LONG PROMPT TOO.
 *
 * The column refuses it before the press, which is where an operator should
 * meet this. This is the other half: the retry control does not go through
 * the column at all, and a hand-posted form goes through neither. kie's own
 * refusal is a code=422 that arrives after the scene is written and queued.
 */
describe("generateClip refuses a prompt longer than the model accepts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /** Long enough that substitution alone clears Kling's 2,500. */
  const VERBOSE = "a woman in a cream linen shirt ".repeat(120);

  it("refuses on Kling — the TYPED length, not a substitution — and writes nothing", async () => {
    // KLING NEVER SUBSTITUTES (see the "Kling mode: generateClip" describe
    // above): a short prompt whose tag expands, the shape that used to
    // trigger this refusal, no longer can. Only a prompt this long AS TYPED
    // still does.
    const spies = mockWriteSurfaces({
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
    });
    const result = await (async () => {
      const { generateClip } = await import("./ugc");
      return generateClip(aKlingClipForm({ prompt: "a".repeat(2501) }));
    })();

    expect(result?.error, "queued a render kie answers with a 422").toMatch(
      /characters over its 2,500 limit/i,
    );
    expect(
      spies.insert,
      "wrote a scene for a render that cannot be submitted",
    ).not.toHaveBeenCalled();
  });

  it("names the overage, without claiming a substitution Kling never does", async () => {
    mockWriteSurfaces({
      elementsById: { "start-el": { asset_id: "asset-start", user_id: "user-1" } },
      assetsById: { "asset-start": { kind: "ref_frame", storage_key: "elements/start.jpg" } },
    });
    const { generateClip } = await import("./ugc");
    const result = await generateClip(aKlingClipForm({ prompt: "a".repeat(2501) }));

    expect(result?.error).toMatch(/Kling 3\.0/);
    expect(result?.error).toMatch(/2,500/);
    // NOT "every @tag is replaced by its full description" — that sentence
    // is Seedance's box mechanism and is false for Kling, which sends the
    // prompt exactly as typed (see generateClip's own submittedPrompt).
    expect(result?.error).not.toMatch(/replaced by its full description/i);
  });

  it("LEAVES SEEDANCE ALONE with the same prompt", async () => {
    // THE REGRESSION THIS GUARDS. Seedance declares no maxPromptChars, and
    // several production renders have gone out past 4,000 characters. A cap
    // applied to every model would break the route this product runs on.
    const spies = mockWriteSurfaces({
      elementNames: [{ name: "greta", description: VERBOSE, assetKind: "ref_frame" }],
      element: { asset_id: "asset-greta", user_id: "user-1" },
    });
    const form = aClipForm({
      prompt: "@greta sips coffee",
      durationS: "4",
      resolution: "480p",
      modelId: "seedance-2.5-byteplus",
    });

    const { generateClip } = await import("./ugc");
    const result = await generateClip(form);

    expect(
      result?.error,
      "refused a Seedance render for a length it has no limit on",
    ).toBeUndefined();
    expect(spies.insert, "did not write the scene").toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The /ugc References box (ugc-column.tsx) submits its contents as repeated
// `referenceTag` fields plus a `referencesBox` marker. generateClip and
// regenerateClip refuse a prompt tag that resolves to a real element but is
// missing from that box — ONLY when the marker is present. retryClip never
// sends either field (it regenerates from the scene's own scene_references,
// never mounting the column), so a marker-less submission must render
// exactly as it always has.
// ---------------------------------------------------------------------------

describe("generateClip enforces the References box only when the marker is present", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("refuses more than ten submitted references before writing", async () => {
    const { insert } = mockWriteSurfaces({});
    const { generateClip } = await import("./ugc");
    const form = aClipForm();
    form.set("referencesBox", "1");
    for (let i = 0; i < 11; i++) form.append("referenceTag", `ref${i}`);

    expect(((await generateClip(form)) as { error: string }).error).toMatch(
      /at most 10 references/,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses a tag that resolves to a saved element outside the submitted box", async () => {
    mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "@jen holds the bottle to camera");
    form.set("referencesBox", "1");
    // No referenceTag at all — an empty box.

    const result = await generateClip(form);

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/@jen/);
    expect((result as { error: string }).error).toMatch(/References box/);
  });

  it("passes once the box names every resolvable tag", async () => {
    const { insert } = mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "@jen holds the bottle to camera");
    form.set("referencesBox", "1");
    form.set("referenceTag", "jen");

    const result = await generateClip(form);

    expect(result ?? {}).not.toHaveProperty("error");
    expect(insert).toHaveBeenCalled();
  });

  it("SEEDANCE IS UNTOUCHED: a tagged webp reference still passes — CHANGE 1/2 are Kling-only", async () => {
    // Neither of the new refusals (klingTagRefusal, refuseIfNotOwnedImageElement's
    // extension check) ever runs on a non-Kling submission — this pins that a
    // Seedance clip with an @tag AND a webp source picture still writes
    // exactly as it did before either check existed.
    const { insert } = mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
      sourceStorageKey: "elements/jen.webp",
      sourceAssetKind: "ref_frame",
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("elementId", "el-jen");
    form.set("prompt", "@jen holds the bottle to camera");
    form.set("referencesBox", "1");
    form.set("referenceTag", "jen");

    const result = await generateClip(form);

    expect(result ?? {}).not.toHaveProperty("error");
    expect(insert).toHaveBeenCalled();
  });

  it("is case-insensitive, the same way findElementByTag is on the client", async () => {
    const { insert } = mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "@Jen holds the bottle to camera");
    form.set("referencesBox", "1");
    form.set("referenceTag", "JEN");

    const result = await generateClip(form);

    expect(result ?? {}).not.toHaveProperty("error");
    expect(insert).toHaveBeenCalled();
  });

  it("does not refuse the identical prompt when the marker is absent — retryClip's own shape", async () => {
    // retryClip (actions/ugc.ts) calls retryScene, never generateClip, so
    // this is really pinning the general rule the marker exists to enforce:
    // no `referencesBox` field at all must behave exactly as it always has,
    // whatever the box would have said.
    const { insert } = mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "@jen holds the bottle to camera");
    // No referencesBox, no referenceTag.

    const result = await generateClip(form);

    expect(result ?? {}).not.toHaveProperty("error");
    expect(insert).toHaveBeenCalled();
  });

  it("does not report a tag that resolves to no element at all — unchanged, notice-only behaviour", async () => {
    // unknownElementTags' own rule survives the box untouched: a tag with
    // nothing behind it has never blocked a render and must not start now,
    // marker or no marker.
    const { insert } = mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { generateClip } = await import("./ugc");

    const form = aClipForm();
    form.delete("image");
    form.set("prompt", "@jen holds the bottle, styled like @not_a_real_tag");
    form.set("referencesBox", "1");
    form.set("referenceTag", "jen");

    const result = await generateClip(form);

    expect(result ?? {}).not.toHaveProperty("error");
    expect(insert).toHaveBeenCalled();
  });

  it("writes byte-identical scene_references rows and ai_generated_prompt with or without the marker", async () => {
    // THE PROOF for point 8 of the spec: what actually gets sent is
    // unchanged. An all-in-box prompt must produce exactly the same write as
    // the marker-less path — the box only ever REFUSES a submission before
    // any write happens; it never alters what a passing one writes.
    function fixtureForm(markerOn: boolean): FormData {
      const form = aClipForm();
      form.delete("image");
      form.set("prompt", "@jen holds the bottle to camera");
      if (markerOn) {
        form.set("referencesBox", "1");
        form.set("referenceTag", "jen");
      }
      return form;
    }

    const { insert: insertA } = mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { generateClip: generateClipNoMarker } = await import("./ugc");
    const resultA = await generateClipNoMarker(fixtureForm(false));
    expect(resultA ?? {}).not.toHaveProperty("error");
    const sceneCallA = insertA.mock.calls.find(
      (c: unknown[]) => c[0] && typeof c[0] === "object" && "video_prompt" in (c[0] as object),
    );
    const refsCallA = insertA.mock.calls.find((c: unknown[]) => Array.isArray(c[0]));

    vi.resetModules();
    vi.clearAllMocks();
    const { insert: insertB } = mockWriteSurfaces({
      element: { asset_id: "asset-jen", user_id: "user-1" },
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { generateClip: generateClipWithMarker } = await import("./ugc");
    const resultB = await generateClipWithMarker(fixtureForm(true));
    expect(resultB ?? {}).not.toHaveProperty("error");
    const sceneCallB = insertB.mock.calls.find(
      (c: unknown[]) => c[0] && typeof c[0] === "object" && "video_prompt" in (c[0] as object),
    );
    const refsCallB = insertB.mock.calls.find((c: unknown[]) => Array.isArray(c[0]));

    expect((sceneCallA?.[0] as { video_prompt: string }).video_prompt).toBe(
      (sceneCallB?.[0] as { video_prompt: string }).video_prompt,
    );
    expect((sceneCallA?.[0] as { ai_generated_prompt: string }).ai_generated_prompt).toBe(
      (sceneCallB?.[0] as { ai_generated_prompt: string }).ai_generated_prompt,
    );
    expect(refsCallA?.[0]).toEqual(refsCallB?.[0]);
  });
});

describe("regenerateClip enforces the References box only when the marker is present", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("refuses a tag outside the submitted box, before writing anything", async () => {
    const spies = mockSceneSurfaces({
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { regenerateClip } = await import("./ugc");

    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "@jen holds the bottle to camera");
    form.set("referencesBox", "1");

    const result = await regenerateClip(form);

    expect(result?.error).toMatch(/@jen/);
    expect(result?.error).toMatch(/References box/);
    expect(spies.update, "wrote before refusing").not.toHaveBeenCalled();
    expect(spies.rerenderScene, "rendered before refusing").not.toHaveBeenCalled();
  });

  it("passes once the box names every resolvable tag", async () => {
    const spies = mockSceneSurfaces({
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { regenerateClip } = await import("./ugc");

    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "@jen holds the bottle to camera");
    form.set("referencesBox", "1");
    form.set("referenceTag", "jen");

    const result = await regenerateClip(form);

    expect(result?.error).toBeUndefined();
    expect(spies.rerenderScene).toHaveBeenCalled();
  });

  it("SEEDANCE IS UNTOUCHED: an @tag over a webp source still passes regenerateClip", async () => {
    // Same Kling-only gating as generateClip's own copy of this test —
    // neither klingTagRefusal nor the webp extension check ever runs when
    // isKlingNow is false, so a plain prompt-edit regenerate with a tag and
    // a webp source element must be unaffected.
    const spies = mockSceneSurfaces({
      elementNames: [{ name: "jen", description: "the presenter" }],
      elementsById: { "el-jen": { asset_id: "asset-jen", user_id: "user-1" } },
      assetsById: { "asset-jen": { kind: "ref_frame", storage_key: "elements/jen.webp" } },
    });
    const { regenerateClip } = await import("./ugc");

    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "@jen holds the bottle to camera");
    form.set("referencesBox", "1");
    form.set("referenceTag", "jen");

    const result = await regenerateClip(form);

    expect(result?.error).toBeUndefined();
    expect(spies.rerenderScene).toHaveBeenCalled();
  });

  it("does not refuse the identical prompt when the marker is absent", async () => {
    const spies = mockSceneSurfaces({
      elementNames: [{ name: "jen", description: "the presenter" }],
    });
    const { regenerateClip } = await import("./ugc");

    const form = new FormData();
    form.set("sceneId", "scene-1");
    form.set("prompt", "@jen holds the bottle to camera");
    // No referencesBox, no referenceTag — retryClip's own shape (it never
    // calls regenerateClip at all, but this pins the rule it depends on).

    const result = await regenerateClip(form);

    expect(result?.error).toBeUndefined();
    expect(spies.rerenderScene).toHaveBeenCalled();
  });
});

describe("ensurePersonalClipProject", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** One admin client whose projects table is a tiny fake: finds answer in order, then an insert. */
  async function load(
    founds: ({ id: string } | null)[],
    insertResult: { data: unknown; error: unknown },
  ) {
    const insert = vi
      .fn()
      .mockReturnValue({ select: () => ({ single: async () => insertResult }) });
    const filters: Record<string, unknown> = {};
    let finds = 0;
    const find = {
      select: () => find,
      eq: (col: string, value: unknown) => {
        filters[col] = value;
        return find;
      },
      maybeSingle: async () => ({ data: founds[finds++] ?? null }),
    };
    vi.doMock("@/actions/guard", () => ({
      requireUser: async () => ({ user: { id: "user-1" }, profile: {} }),
      requireProject: async () => ({}),
      requireScene: async () => ({}),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({}),
      createAdminClient: () => ({ from: () => ({ ...find, insert }) }),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
    const { ensurePersonalClipProject } = await import("./ugc");
    return { ensurePersonalClipProject, insert, filters };
  }

  it("finds the personal project by its marker and makes nothing", async () => {
    const { ensurePersonalClipProject, insert, filters } = await load([{ id: "proj-1" }], {
      data: null,
      error: null,
    });
    expect(await ensurePersonalClipProject()).toEqual({ projectId: "proj-1" });
    expect(insert).not.toHaveBeenCalled();
    expect(filters).toEqual({ user_id: "user-1", is_personal: true });
  });

  it("makes a clip project marked personal on first use", async () => {
    const { ensurePersonalClipProject, insert } = await load([null], {
      data: { id: "proj-2" },
      error: null,
    });
    expect(await ensurePersonalClipProject()).toEqual({ projectId: "proj-2" });
    expect(insert.mock.calls[0]![0]).toMatchObject({
      user_id: "user-1",
      kind: "clip",
      is_personal: true,
    });
  });

  it("re-reads the winner when two first presses race (unique index, 23505)", async () => {
    const { ensurePersonalClipProject } = await load([null, { id: "proj-winner" }], {
      data: null,
      error: { code: "23505" },
    });
    expect(await ensurePersonalClipProject()).toEqual({ projectId: "proj-winner" });
  });
});
