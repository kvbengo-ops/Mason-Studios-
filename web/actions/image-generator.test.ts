// resolvePromptReferences (lib/image-generation.ts): the regression test
// for the cross-feature leak this /ugc voice-description change would
// otherwise open.
//
// THE LEAK. This function builds one `descriptions` map from EVERY element
// with no kind filter, then filtered audio out of the reference-IMAGE array
// only — the function's own comment already said "a sound file cannot
// condition an image at all" and applied that rule to just one of its two
// outputs. That was safe exactly as long as every audio element's
// description was empty (nothing to leak). It stopped being safe once
// lib/kie-audio-describe.ts gave audio elements real descriptions: an
// @voice1 tag typed into an IMAGE prompt would get replaced with prose
// about a voice — a reference nano-banana cannot use and a prompt that now
// silently makes no sense.

import { describe, expect, it, vi } from "vitest";
import { resolvePromptReferences } from "@/lib/image-generation";

// signedUrl is the only other thing this function touches outside the fake
// admin client — mocked rather than exercising the real Supabase signing
// path, the same boundary actions/elements.test.ts and actions/ugc-
// redescribe.test.ts already draw.
vi.mock("@/lib/storage", () => ({
  signedUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
}));

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

/** Chainable stand-in for the two read-only queries this function makes: elements (.select().eq()) and assets (.select().in()), both awaited directly rather than via maybeSingle/single. */
function fakeBuilder(result: FakeResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    in: vi.fn(() => builder),
    then: (onFulfilled: (r: FakeResult) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeAdmin(elements: unknown[], assets: unknown[]) {
  return {
    from: vi.fn((table: string) => {
      if (table === "elements") return fakeBuilder({ data: elements, error: null });
      if (table === "assets") return fakeBuilder({ data: assets, error: null });
      throw new Error(`Unexpected table in test: ${table}`);
    }),
  } as never;
}

describe("resolvePromptReferences — an audio element's description never reaches an image prompt", () => {
  it("substitutes an image element's description but leaves an @voice tag's description out, even though it has one", async () => {
    const admin = fakeAdmin(
      [
        {
          name: "lena",
          description: "a woman with shoulder-length auburn hair",
          ai_description: null,
          asset_id: "asset-image",
        },
        {
          name: "voice1",
          // THE CASE THAT DID NOT EXIST BEFORE THIS CHANGE: an audio element
          // carrying a real description, from lib/kie-audio-describe.ts.
          description: "a mature female voice with a clear, resonant timbre. Delivery: calm.",
          ai_description: null,
          asset_id: "asset-audio",
        },
      ],
      [
        { id: "asset-image", storage_key: "projects/p1/ref_frame/lena.jpg", kind: "ref_frame" },
        { id: "asset-audio", storage_key: "projects/p1/audio/voice1.mp3", kind: "audio" },
      ],
    );

    const result = await resolvePromptReferences(
      admin,
      "user-1",
      "@lena standing beside @voice1 in a kitchen",
    );

    expect(result.prompt).toContain("a woman with shoulder-length auburn hair");
    // The regression: the voice's prose must NOT be spliced into an image
    // prompt. Before the fix this contained "mature female voice ...".
    // "@voice1" itself is LEFT AS WRITTEN — an unresolved tag degrades to
    // its bare word, same contract resolveElementTags documents in
    // actions/ugc.ts — which is the visible proof the substitution was
    // skipped rather than silently emptied.
    expect(result.prompt).not.toContain("mature female voice");
    expect(result.prompt).toContain("@voice1");

    // And the reference-image array — the OTHER half of the same guard,
    // which already existed — still carries only the picture.
    expect(result.refImageUrls).toHaveLength(1);
    expect(result.refImageUrls[0]).toContain("lena.jpg");
  });

  it("still substitutes a pre-0081 element with no assets row link cleanly (asset missing => no description, no crash)", async () => {
    const admin = fakeAdmin(
      [
        {
          name: "ghost",
          description: "an old description",
          ai_description: null,
          asset_id: "missing-asset",
        },
      ],
      [],
    );

    const result = await resolvePromptReferences(admin, "user-1", "@ghost in the frame");

    // No assets row for "missing-asset" — assetById has nothing for it, so
    // the element is treated as non-audio (asset undefined, not "audio") and
    // its description still substitutes. Matches the pre-existing behaviour
    // for a dangling asset_id, which this change must not disturb.
    expect(result.prompt).toContain("an old description");
  });
});

// ---------------------------------------------------------------------------
// The per-model aspect ratio guard (generateImageFor).
//
// `!isImageAspectRatio(v) || !imageModel.aspectRatios.includes(v)` is two
// checks, and only the first is obvious. The second is the one with no other
// backstop for Nano Banana: byteplus-image.ts re-checks the ratio before it
// builds a request, so a bad Seedream ratio would still be refused somewhere —
// as a thrown 500 rather than a sentence — but nano-banana's args go to kie
// unvalidated, so for those models this line is the only thing between the
// operator and a 422 they paid the reservation for.
//
// Reached with a tagless prompt and no chain id, which short-circuits
// resolvePromptReferences before its first round trip (see its own comment) —
// so the admin client below is deliberately a bomb: if this path ever starts
// touching the database before validating its input, these tests fail rather
// than quietly passing against a stub.
vi.mock("@/actions/guard", () => ({
  requireUser: vi.fn(async () => ({ user: { id: "user-1" }, profile: {} })),
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => {
      throw new Error("reached the database before validating the aspect ratio");
    },
  })),
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

function generateForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  // A prompt with no "@" and no chainFromAssetId: the two things that would
  // otherwise send this down a query path this test has no business exercising.
  form.set("prompt", "a red ceramic mug on a windowsill");
  form.set("idempotencyKey", "key-1");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

const RATIO_REFUSAL = "Choose a supported aspect ratio before generating.";

describe("generatePersonalImage refuses an aspect ratio the chosen model cannot take", () => {
  it("refuses a real ratio that this model does not offer", async () => {
    const { generatePersonalImage } = await import("./image-generator");

    // 4:5 passes isImageAspectRatio and is fine on Nano Banana. Only the
    // per-model half of the guard can catch it here, which makes this the one
    // case that proves the second condition is still doing something.
    expect(
      await generatePersonalImage(
        generateForm({ imageModel: "seedream-5.0-pro", aspectRatio: "4:5" }),
      ),
    ).toEqual({ error: RATIO_REFUSAL });
  });

  it("refuses a ratio that is not a ratio at all", async () => {
    const { generatePersonalImage } = await import("./image-generator");

    expect(
      await generatePersonalImage(
        generateForm({ imageModel: "nano-banana", aspectRatio: "portrait" }),
      ),
    ).toEqual({ error: RATIO_REFUSAL });
  });

  it("accepts the same ratio on a model that does offer it", async () => {
    const { generatePersonalImage } = await import("./image-generator");

    // The negative control. Without it every test above would still pass if
    // the guard were changed to refuse everything, which is not a fix.
    //
    // Getting PAST the guard means reaching the admin client, which throws by
    // design here. Two callers downstream of the guard swallow that throw and
    // log it (sweepStaleImageReservations, getInFlightSpend) before a third
    // lets it escape, so console.error is silenced for this one case: those
    // traces are the expected shape of success here, and leaving them in the
    // suite output trains everyone to ignore stack traces that are real.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await generatePersonalImage(
        generateForm({ imageModel: "nano-banana", aspectRatio: "4:5" }),
      ).catch((error: unknown) => error);

      // Deliberately NOT an assertion about which error: what is being pinned
      // is that the ratio cleared the guard, not how far past it the request
      // then got with a database that is a bomb.
      expect(outcome).not.toEqual({ error: RATIO_REFUSAL });
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
