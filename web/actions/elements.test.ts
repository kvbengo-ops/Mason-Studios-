import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerElement } from "./elements";
import { isAdmin, requireProject, requireUser } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { removeStorageObjects, uploadFile } from "@/lib/storage";
import { describeReferenceImage } from "@/lib/claude";
import { assertWithinSpendCaps } from "@/lib/spend";
import { AudioDescribeUnusableError, describeReferenceAudio } from "@/lib/kie-audio-describe";
import { recordRun } from "@/lib/runs";

// Same fakes-over-the-boundary approach as actions/profile.test.ts: the
// ownership guard (actions/guard.ts), the admin Supabase client factory,
// and lib/storage.ts (the only file allowed to touch supabase.storage) are
// mocked; next/cache's revalidatePath is a no-op outside a real request.
// BOTH guards, because these actions now take one or the other: a form
// carrying a projectId goes through requireProject exactly as before, and one
// without it (the Elements Library, which has no project) goes through
// requireUser. Mocking only the first would let the project-less branch fail
// as "not a function" and read like a bug in the action.
// isAdmin is mocked alongside them even though it is a pure one-line predicate
// over the profile — mocking a module replaces ALL of its exports, so leaving
// it out makes deleteElement throw "No isAdmin export is defined" rather than
// exercise the owner-or-admin branch 0091 gave it.
//
// NOT-AN-ADMIN IS THE DEFAULT IN BOTH DIRECTIONS: `() => false` for the first
// test in a file, and afterEach's vi.resetAllMocks() strips that implementation
// so every later one gets undefined, which the action reads as falsy just the
// same. The single admin case below opts in explicitly and cannot leak into its
// neighbours.
vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
  requireUser: vi.fn(),
  isAdmin: vi.fn(() => false),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  resolveStagedUploads: vi.fn(),
  uploadFile: vi.fn(),
  removeStorageObjects: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// registerElement describes the reference itself now, so the modules that
// cost money go through are faked here too. Their own behaviour is tested
// where they live; what matters in this file is that a save still happens.
vi.mock("@/lib/spend", () => ({
  assertWithinSpendCaps: vi.fn(async () => undefined),
}));

vi.mock("@/lib/claude", () => ({
  CLAUDE_VENDOR: "anthropic",
  describeReferenceImage: vi.fn(async () => ({ description: "a woman in a linen shirt" })),
}));

// A REAL class in the mock, not a stub — describeAudioOnSave's catch block
// decides whether to keep the metered cost with `err instanceof
// AudioDescribeUnusableError`, and a mock missing it reads `instanceof
// undefined`, a TypeError that would mask the failure being tested. Declared
// inside the factory: vi.mock is hoisted above every top-level statement in
// this file, so a class defined outside it is still in the factory's
// temporal dead zone when it runs (same note as ugc-redescribe.test.ts's).
vi.mock("@/lib/kie-audio-describe", () => {
  class AudioDescribeUnusableError extends Error {
    readonly costUsd: number | null;
    constructor(message: string, costUsd: number | null) {
      super(message);
      this.name = "AudioDescribeUnusableError";
      this.costUsd = costUsd;
    }
  }
  return {
    AUDIO_DESCRIBE_MODEL: "gemini-3-8-flash",
    AUDIO_DESCRIBE_ESTIMATE_USD: 0.001,
    AudioDescribeUnusableError,
    describeReferenceAudio: vi.fn(async () => ({
      description: "a mature female voice, calm and deliberate delivery",
      costUsd: 0.00015,
    })),
  };
});

// Video's own sibling to the audio mock above, same reason (describeVideoOnSave's
// catch block checks `err instanceof VideoDescribeUnusableError`) and same
// hoisting constraint (the class has to be declared inside the factory).
vi.mock("@/lib/kie-video-describe", () => {
  class VideoDescribeUnusableError extends Error {
    readonly costUsd: number | null;
    constructor(message: string, costUsd: number | null) {
      super(message);
      this.name = "VideoDescribeUnusableError";
      this.costUsd = costUsd;
    }
  }
  return {
    VIDEO_DESCRIBE_MODEL: "gemini-3-8-flash",
    VIDEO_DESCRIBE_ESTIMATE_USD: 0.0002,
    VideoDescribeUnusableError,
    describeReferenceVideo: vi.fn(async () => ({
      description: "a woman unboxing a skincare set on a marble counter",
      costUsd: 0.0002,
    })),
  };
});

vi.mock("@/lib/runs", () => ({
  recordRun: vi.fn(async () => undefined),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

interface FakeQueryBuilder {
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  // deleteElement's chains: .select().eq().maybeSingle() to read, then
  // .delete().eq() to remove. `delete` is a reserved word as a bare property
  // name in some tooling, so it is quoted here for the same reason the real
  // client quotes it.
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  like: ReturnType<typeof vi.fn>;
  ilike: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  // updateElement's write chain: .update({...}).eq("id", ...). Absent until
  // 0091 gave admins the edit verb, because until then no test in this file
  // reached a successful update — the only update path exercised was the
  // ownership REFUSAL, which returns before touching the builder.
  update: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

/** Minimal chainable Supabase query builder stand-in, extended with `.insert()`/`.single()` for this file's own chains. */
function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    insert: vi.fn(() => builder),
    select: vi.fn(() => builder),
    single: vi.fn(async () => result),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    // nextAutoName's chain: .select().eq().like()
    like: vi.fn(() => builder),
    ilike: vi.fn(() => builder),
    or: vi.fn(() => builder),
    limit: vi.fn(() => fakeBuilder({ data: [], error: null })),
    maybeSingle: vi.fn(async () => result),
    delete: vi.fn(() => builder),
    update: vi.fn(() => builder),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

const USER = { id: "user-1", email: "editor@example.com" };
const PROJECT = { id: "project-1", title: "New project" };

function okFormData(overrides: Partial<Record<string, string>> = {}): FormData {
  const formData = new FormData();
  formData.set("projectId", "project-1");
  if (overrides.name !== "") formData.set("name", overrides.name ?? "jen");
  if (overrides.category !== "") formData.set("category", overrides.category ?? "character");
  if (overrides.description !== undefined) formData.set("description", overrides.description);
  const file = new File([new Uint8Array(10)], "jen.jpg", { type: "image/jpeg" });
  formData.set("image", file);
  return formData;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("registerElement — refusals never reach storage or the database", () => {
  it("refuses a missing tag before uploading", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    const result = await registerElement(okFormData({ name: "" }));
    expect(result?.error).toContain("Enter a tag");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(describeReferenceImage).not.toHaveBeenCalled();
  });

  it("falls back to character for a category it does not recognise", async () => {
    // Also no longer a refusal. The upload form stopped asking, an image with
    // nothing said about it is a character far more often than anything else,
    // and the badge on the Elements card is where it gets corrected.
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/ref_frame/x.jpg" });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    let insertedCategory: string | undefined;
    elementBuilder.insert = vi.fn((row: { category: string }) => {
      insertedCategory = row.category;
      return elementBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const formData = okFormData();
    formData.set("category", "mascot");

    const result = await registerElement(formData);

    expect(result).toBeUndefined();
    // "image", not "character": the category says what the reference IS as of
    // 0081, and an unrecognised value from the form still falls back to the
    // default rather than being written through.
    expect(insertedCategory).toBe("image");
  });

  it("refuses a non-image file", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });

    const formData = okFormData();
    formData.set("image", new File(["x"], "notes.txt", { type: "text/plain" }));

    const result = await registerElement(formData);

    // Asserted kind by kind, not as one phrase. The old assertion matched
    // "picture, or an MP3 or WAV" — a single substring, which went red the
    // moment 0093 added video to the sentence even though the refusal was
    // still correct, and would have stayed green if a kind had been dropped
    // from the list instead. What the operator needs is that every kind the
    // uploader actually accepts is named in the refusal that rejects them.
    // A refusal, not a silent success — asserted before the copy, because a
    // registerElement that returned undefined here would satisfy every
    // toMatch below by vacuously never running one.
    const refusal = result?.error;
    expect(refusal).toBeDefined();
    expect(refusal).toMatch(/JPG, PNG or WebP/i);
    expect(refusal).toMatch(/MP3 or WAV/i);
    expect(refusal).toMatch(/MP4/i);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("accepts an MP3, stores it as an audio asset, and describes it by kie, never Claude", async () => {
    // THE TRAP THIS STILL PINS, half of it: an mp3 must never reach
    // describeReferenceImage — Claude sent bytes that are not a picture
    // comes back either a vendor error or, worse, a confident paragraph
    // about a picture that does not exist. What no longer holds is "a voice
    // tag needs no prose" — bindUITags on the worker deletes an undescribed
    // audio tag outright, so this asserts the OTHER vendor was reached
    // instead: kie's Gemini pass, which listens to the clip.
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/audio/v.mp3" });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    let insertedAsset: { kind: string } | undefined;
    let insertedElement: { category: string; description: string | null } | undefined;
    assetBuilder.insert = vi.fn((row: { kind: string }) => {
      insertedAsset = row;
      return assetBuilder;
    });
    elementBuilder.insert = vi.fn((row: { category: string; description: string | null }) => {
      insertedElement = row;
      return elementBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const formData = okFormData({ name: "lena_voice" });
    formData.set("image", new File(["ID3"], "lena.mp3", { type: "audio/mpeg" }));

    const result = await registerElement(formData);

    expect(result).toBeUndefined();
    expect(insertedAsset?.kind).toBe("audio");
    // A voice is audio whatever the form's category said. The word changed in
    // 0081 — 'voice' and 'audio' had never meant different things here — and
    // the point is unchanged: the FILE decides this, not the form.
    expect(insertedElement?.category).toBe("audio");
    expect(insertedElement?.description).toBe(
      "a mature female voice, calm and deliberate delivery",
    );
    expect(describeReferenceAudio).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: "audio/mpeg", name: "lena_voice", category: "audio" }),
    );
    expect(describeReferenceImage).not.toHaveBeenCalled();
    expect(vi.mocked(recordRun)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: 0.00015 }),
    );
    // And it went to storage under the audio kind, not ref_frame.
    expect(vi.mocked(uploadFile).mock.calls[0]?.[0]).toMatchObject({ kind: "audio" });
  });

  it("still saves an audio element with no description when the describe fails, and reports the failure as a notice", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/audio/v.mp3" });
    vi.mocked(describeReferenceAudio).mockRejectedValueOnce(
      new AudioDescribeUnusableError(
        "That clip could not be used as a voice reference (mostly silence) — write the description yourself.",
        0.00015,
      ),
    );

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    let insertedElement: { description: string | null } | undefined;
    elementBuilder.insert = vi.fn((row: { description: string | null }) => {
      insertedElement = row;
      return elementBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const formData = okFormData({ name: "lena_voice" });
    formData.set("image", new File(["ID3"], "lena.mp3", { type: "audio/mpeg" }));

    const result = await registerElement(formData);

    // A FAILED DESCRIBE MUST NOT LOSE THE UPLOAD — the same rule the image
    // path already followed. The element saves with no description, and the
    // card's own "Describe" button is what tries again. What's new is that
    // the caller is TOLD — an ActionNotice, not an error, because the upload
    // itself succeeded.
    expect(result).toEqual({
      notice: expect.stringMatching(/lena_voice.*could not be described.*Describe/i),
    });
    expect(insertedElement?.description).toBeNull();
    // AudioDescribeUnusableError carries a real receipt — kie listened to
    // the clip and billed for it before saying no — so that figure, not
    // null, is what gets recorded. And exactly once: a verdict on the clip
    // itself is never retried, unlike a transient failure below.
    expect(vi.mocked(recordRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordRun)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: 0.00015 }),
    );
  });

  it("retries once on a transient describe failure, and succeeds on the second attempt", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/audio/v.mp3" });
    vi.mocked(describeReferenceAudio)
      .mockRejectedValueOnce(new Error("kie Gemini HTTP 503: upstream unavailable"))
      .mockResolvedValueOnce({
        description: "a mature female voice, calm and deliberate delivery",
        costUsd: 0.00015,
      });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    let insertedElement: { description: string | null } | undefined;
    elementBuilder.insert = vi.fn((row: { description: string | null }) => {
      insertedElement = row;
      return elementBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const formData = okFormData({ name: "lena_voice" });
    formData.set("image", new File(["ID3"], "lena.mp3", { type: "audio/mpeg" }));

    const result = await registerElement(formData);

    // No notice at all: the retry absorbed the failure, so there is nothing
    // to tell the operator that a describe went wrong.
    expect(result).toBeUndefined();
    expect(describeReferenceAudio).toHaveBeenCalledTimes(2);
    expect(insertedElement?.description).toBe(
      "a mature female voice, calm and deliberate delivery",
    );
    // BOTH attempts recorded — the first failed one (costUsd null, a network
    // error carries no receipt) and the second, successful one at its real
    // metered cost. A ledger that only kept the second would understate what
    // this upload cost to describe.
    expect(vi.mocked(recordRun)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordRun)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: null }),
    );
    expect(vi.mocked(recordRun)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: 0.00015 }),
    );
  });

  it("gives up after one retry, records both failed attempts, and still saves the upload", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/audio/v.mp3" });
    vi.mocked(describeReferenceAudio)
      .mockRejectedValueOnce(new Error("kie Gemini request failed: fetch failed"))
      .mockRejectedValueOnce(new Error("kie Gemini HTTP 503: upstream unavailable"));

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    let insertedElement: { description: string | null } | undefined;
    elementBuilder.insert = vi.fn((row: { description: string | null }) => {
      insertedElement = row;
      return elementBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const formData = okFormData({ name: "lena_voice" });
    formData.set("image", new File(["ID3"], "lena.mp3", { type: "audio/mpeg" }));

    const result = await registerElement(formData);

    // ONE RETRY, NOT A LOOP: exactly two calls, never a third.
    expect(describeReferenceAudio).toHaveBeenCalledTimes(2);
    expect(insertedElement?.description).toBeNull();
    expect(result).toEqual({
      notice: expect.stringMatching(/lena_voice.*could not be described.*Describe/i),
    });
    expect(vi.mocked(recordRun)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordRun)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ costUsd: null }),
    );
    expect(vi.mocked(recordRun)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ costUsd: null }),
    );
  });

  it("saves an audio element without describing it, and spends nothing, when over the spend cap", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/audio/v.mp3" });
    // The cap, checked BEFORE the spend: an operator over cap still gets
    // their upload, just with no description written for it.
    vi.mocked(assertWithinSpendCaps).mockResolvedValueOnce({
      error: "over the weekly cap",
    } as never);

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    let insertedElement: { description: string | null } | undefined;
    elementBuilder.insert = vi.fn((row: { description: string | null }) => {
      insertedElement = row;
      return elementBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const formData = okFormData({ name: "lena_voice" });
    formData.set("image", new File(["ID3"], "lena.mp3", { type: "audio/mpeg" }));

    const result = await registerElement(formData);

    expect(result).toBeUndefined();
    expect(insertedElement?.description).toBeNull();
    expect(describeReferenceAudio).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("refuses an oversized image", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });

    const formData = okFormData();
    const oversized = new File([new Uint8Array(11 * 1024 * 1024)], "jen.jpg", {
      type: "image/jpeg",
    });
    formData.set("image", oversized);

    const result = await registerElement(formData);

    expect(result).toEqual({ error: expect.stringMatching(/limit/i) });
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe("registerElement — the happy path", () => {
  it("uploads the file, records the asset, then the element, and revalidates the page", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/ref_frame/x.jpg" });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const { revalidatePath } = await import("next/cache");

    const result = await registerElement(okFormData({ description: "the usual talent" }));

    expect(result).toBeUndefined();
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", kind: "ref_frame" }),
    );
    expect(assetBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        kind: "ref_frame",
        storage_key: "projects/project-1/ref_frame/x.jpg",
      }),
    );
    expect(elementBuilder.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      name: "jen",
      description: "the usual talent",
      category: "character",
      asset_id: "asset-1",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/ugc/project-1");
  });

  // THE REGRESSION THIS TASK'S OWN BRIEF ASKED FOR: a picture upload — every
  // upload before this task, and the overwhelming majority after it — must
  // still write assets.duration_s as null, exactly as it always has. This
  // used to be true by omission (the insert never mentioned the column at
  // all); it is true on purpose now that the column is written for real on
  // a video, so this pins the OTHER branch of that same conditional.
  it("writes duration_s as null for a picture — that column is video-only", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/ref_frame/x.jpg" });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const result = await registerElement(okFormData());

    expect(result).toBeUndefined();
    expect(assetBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ref_frame", duration_s: null }),
    );
  });

  // THE WHOLE POINT OF THIS TASK: what the pricing formula needs actually
  // reaches the row it prices FROM. components/ugc-reference-picker.tsx's
  // videoDurationSeconds measures the file in the browser and sends the
  // result as `durationS` on the same FormData the file itself travels on
  // (attachVideoDuration, that file's own comment) — this is the server
  // half, pinning that the field is read, parsed, and written to exactly
  // the column lib/estimate.ts's estimateCost later reads back out.
  it("writes the measured durationS to assets.duration_s for a video reference", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/video_ref/x.mp4" });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const formData = okFormData({ name: "unboxing_clip" });
    formData.set("image", new File(["mp4 bytes"], "unboxing.mp4", { type: "video/mp4" }));
    formData.set("durationS", "12.5");

    const result = await registerElement(formData);

    expect(result).toBeUndefined();
    expect(assetBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "video_ref", duration_s: 12.5 }),
    );
  });

  // THE OTHER HALF: a browser that could not decode the file's metadata
  // sends no durationS field at all (components/ugc-reference-picker.tsx's
  // videoDurationSeconds returns null in exactly that case, and
  // attachVideoDuration leaves the form field unset rather than sending a
  // string spelling out "null"). registerElement must not turn a MISSING
  // field into 0 — Number(null-ish) is NaN, and NaN fails the
  // `> 0` guard the same way a genuinely bad value would.
  it("writes duration_s as null for a video reference the browser could not measure", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/video_ref/x.mp4" });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const formData = okFormData({ name: "unboxing_clip" });
    formData.set("image", new File(["mp4 bytes"], "unboxing.mp4", { type: "video/mp4" }));
    // No durationS field at all — the unmeasurable-file case.

    const result = await registerElement(formData);

    expect(result).toBeUndefined();
    expect(assetBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "video_ref", duration_s: null }),
    );
  });

  it("turns a duplicate name into a friendly refusal instead of throwing", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/ref_frame/x.jpg" });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    const elementBuilder = fakeBuilder({
      data: null,
      error: { message: "duplicate key value violates unique constraint", code: "23505" },
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "assets") return assetBuilder;
        if (table === "elements") return elementBuilder;
        throw new Error(`Unexpected table in test: ${table}`);
      }),
    } as never);

    const result = await registerElement(okFormData({ name: "jen" }));

    expect(result).toEqual({
      error: expect.stringMatching(/@jen is already used/i),
    });
  });

  it("cleans up the uploaded file when the row cannot be recorded", async () => {
    // THE ORPHAN. uploadFile runs before the insert, so a rejected row leaves
    // the object in storage with nothing pointing at it — garbage that cannot
    // be found, let alone reclaimed. Found while working out what a merge
    // ahead of migration 0079 would actually do to production.
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/audio/v.mp3" });

    const assetBuilder = fakeBuilder({
      data: null,
      error: { code: "23514", message: 'violates check constraint "assets_kind_check"' },
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => assetBuilder),
    } as never);

    const formData = okFormData({ name: "lena_voice" });
    formData.set("image", new File(["ID3"], "lena.mp3", { type: "audio/mpeg" }));

    const result = await registerElement(formData);

    // Named, not generic. A check violation on an audio upload means exactly
    // one thing, and "Something went wrong" would send someone reading logs
    // for an answer the error already knows.
    expect(result).toEqual({ error: expect.stringMatching(/0079/) });
    expect(removeStorageObjects).toHaveBeenCalledWith(["projects/project-1/audio/v.mp3"]);
  });

  it("still throws on a failure that is not the missing migration", async () => {
    // A lost connection is not a rejected file. Returning a soft error for it
    // would tell an operator their upload was refused when it was not — and
    // the cleanup must still run either way.
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: {} as never,
      project: PROJECT as never,
      reached: {} as never,
    });
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "projects/project-1/ref_frame/a.png" });

    const assetBuilder = fakeBuilder({
      data: null,
      error: { code: "08006", message: "connection failure" },
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => assetBuilder),
    } as never);

    await expect(registerElement(okFormData({ name: "jen" }))).rejects.toThrow(
      /connection failure/,
    );
    expect(removeStorageObjects).toHaveBeenCalledWith(["projects/project-1/ref_frame/a.png"]);
  });
});

// ---------------------------------------------------------------------------
// deleteElement.
//
// A destructive action on someone's reference library. The two things worth
// pinning are that it refuses a row it does not own, and that it removes the
// ELEMENT and not the asset — generateClip copies a reference into the scene,
// so a rendered clip must not be reachable through this, and two elements can
// legitimately point at one upload.
// ---------------------------------------------------------------------------

function deleteFormData(elementId = "element-1"): FormData {
  const formData = new FormData();
  formData.set("projectId", "project-1");
  formData.set("elementId", elementId);
  return formData;
}

describe("deleteElement", () => {
  beforeEach(() => {
    vi.mocked(requireProject).mockResolvedValue({
      user: USER,
      profile: { id: USER.id, role: "editor", status: "active" },
      project: PROJECT,
    } as unknown as Awaited<ReturnType<typeof requireProject>>);
  });

  it("refuses an element belonging to someone else", async () => {
    const builder = fakeBuilder({
      data: { id: "element-1", name: "jen", user_id: "someone-else" },
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => builder),
    } as unknown as ReturnType<typeof createAdminClient>);

    const { deleteElement } = await import("./elements");
    const result = await deleteElement(deleteFormData());

    expect(result?.error).toMatch(/no longer available/i);
    // The refusal must come BEFORE the delete, not after it.
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("refuses when there is no element id", async () => {
    const { deleteElement } = await import("./elements");
    const formData = new FormData();
    formData.set("projectId", "project-1");

    expect((await deleteElement(formData))?.error).toMatch(/no reference/i);
  });

  // 0091's admin row: BOTH verbs on somebody else's element. An earlier draft
  // of this feature gave admins delete only, and this test asserted the edit
  // was refused; the product decided otherwise, so the assertion is inverted
  // rather than deleted — an admin is expected to be able to correct a bad
  // description or a misleading @name in a shared library.
  it("lets an admin remove AND rewrite another account's element", async () => {
    vi.mocked(isAdmin).mockReturnValue(true);

    const builder = fakeBuilder({
      data: { id: "element-1", name: "jen", user_id: "someone-else" },
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => builder),
    } as unknown as ReturnType<typeof createAdminClient>);

    const { deleteElement, updateElement } = await import("./elements");

    expect(await deleteElement(deleteFormData())).toBeUndefined();
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String), deleted_by: USER.id }),
    );

    // Same door as the delete above (requireProject, the only guard this
    // describe mocks), so the only thing differing between the two calls is
    // which action is asked.
    const upd = new FormData();
    upd.set("projectId", "project-1");
    upd.set("elementId", "element-1");
    upd.set("name", "moderated");
    upd.set("category", "image");
    expect(await updateElement(upd)).toBeUndefined();
  });

  // The other half of that pair, and the one that would otherwise be assumed:
  // an ordinary account browsing the shared library reaches every row and may
  // write none of them. Shared browsing is not an authorisation to edit
  // somebody else's tags.
  it("refuses a non-owner who is not an admin, on both verbs", async () => {
    vi.mocked(isAdmin).mockReturnValue(false);

    const builder = fakeBuilder({
      data: { id: "element-1", name: "jen", user_id: "someone-else" },
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => builder),
    } as unknown as ReturnType<typeof createAdminClient>);

    const { deleteElement, updateElement } = await import("./elements");

    expect((await deleteElement(deleteFormData()))?.error).toMatch(/no longer available/i);
    expect(builder.delete).not.toHaveBeenCalled();

    const upd = new FormData();
    upd.set("projectId", "project-1");
    upd.set("elementId", "element-1");
    upd.set("name", "hijacked");
    upd.set("category", "image");
    expect((await updateElement(upd))?.error).toMatch(/no longer available/i);
  });

  it("soft-deletes the element the caller owns", async () => {
    const builder = fakeBuilder({
      data: { id: "element-1", name: "jen", user_id: USER.id },
      error: null,
    });
    const from = vi.fn(() => builder);
    vi.mocked(createAdminClient).mockReturnValue({
      from,
    } as unknown as ReturnType<typeof createAdminClient>);

    const { deleteElement } = await import("./elements");
    expect(await deleteElement(deleteFormData())).toBeUndefined();

    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String), deleted_by: USER.id }),
    );
    expect(builder.delete).not.toHaveBeenCalled();
    // The ASSET is left alone. Two names for one upload is a thing operators
    // do, and an orphaned asset costs storage where a wrongly deleted one
    // costs somebody's reference frame.
    expect(from).not.toHaveBeenCalledWith("assets");
  });
});

// ---------------------------------------------------------------------------
// The Elements Library's own shape: no project, anywhere.
//
// These three actions are the ONLY writers of `elements`, and both the picker
// and /elements call them. What the project-less branch has to get right is
// narrow and entirely about ownership:
//
//   - it must not fall through to requireProject (which would refuse, since
//     there is no id to check) — requireUser is the door, and it carries the
//     account-approval gate;
//   - the row it writes must be owned by the CALLER, with the asset owned by
//     them too rather than parked in a project;
//   - and the explicit `element.user_id !== user.id` compare has to keep
//     refusing another account's element, because with no project id in the
//     form there is nothing else standing between a guessed element id and a
//     write.
// ---------------------------------------------------------------------------
describe("the project-less (Elements Library) branch", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockResolvedValue({
      user: USER,
      profile: { id: USER.id, role: "editor", status: "active" },
    } as unknown as Awaited<ReturnType<typeof requireUser>>);
  });

  /** okFormData without the projectId — what /elements actually submits. */
  function libraryFormData(): FormData {
    const formData = okFormData();
    formData.delete("projectId");
    return formData;
  }

  it("uses requireUser, never requireProject, and owns the asset by account", async () => {
    vi.mocked(uploadFile).mockResolvedValue({ storageKey: "users/user-1/ref_frame/x.jpg" });

    const assetBuilder = fakeBuilder({ data: { id: "asset-1" }, error: null });
    let assetRow: { project_id: string | null; user_id: string | null } | undefined;
    assetBuilder.insert = vi.fn((row: { project_id: string | null; user_id: string | null }) => {
      assetRow = row;
      return assetBuilder;
    });
    const elementBuilder = fakeBuilder({ data: null, error: null });
    let elementRow: { user_id: string } | undefined;
    elementBuilder.insert = vi.fn((row: { user_id: string }) => {
      elementRow = row;
      return elementBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => (table === "assets" ? assetBuilder : elementBuilder)),
    } as never);

    expect(await registerElement(libraryFormData())).toBeUndefined();

    expect(requireProject).not.toHaveBeenCalled();
    expect(requireUser).toHaveBeenCalledTimes(1);

    // The storage key is the account's, not a project's — uploadFile's union
    // makes "both" and "neither" compile errors, so asserting the argument is
    // asserting which branch ran.
    expect(vi.mocked(uploadFile).mock.calls[0]?.[0]).toMatchObject({ userId: USER.id });

    // Exactly one owner column on the asset. Both would violate the intent of
    // assets_owner_present_check even though the CHECK itself only refuses
    // neither, and a project_id here would park a library upload in a project
    // the operator never chose.
    expect(assetRow).toMatchObject({ project_id: null, user_id: USER.id });
    // The element itself is unchanged in shape — it was always user-owned.
    expect(elementRow).toMatchObject({ user_id: USER.id });
  });

  it("still refuses another account's element with no projectId to hide behind", async () => {
    const builder = fakeBuilder({
      data: { id: "element-1", name: "jen", user_id: "someone-else" },
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => builder),
    } as unknown as ReturnType<typeof createAdminClient>);

    const { deleteElement, updateElement } = await import("./elements");

    const del = new FormData();
    del.set("elementId", "element-1");
    expect((await deleteElement(del))?.error).toMatch(/no longer available/i);
    expect(builder.delete).not.toHaveBeenCalled();

    const upd = new FormData();
    upd.set("elementId", "element-1");
    upd.set("name", "stolen");
    upd.set("category", "image");
    expect((await updateElement(upd))?.error).toMatch(/no longer available/i);
  });

  it("keeps rejecting a name a prompt could never reference", async () => {
    const { updateElement } = await import("./elements");
    const formData = new FormData();
    formData.set("elementId", "element-1");
    formData.set("name", "my ref");
    formData.set("category", "image");

    // Refused before the admin client is even built — createAdminClient is
    // unmocked for this call and would throw if the validation let it through.
    expect((await updateElement(formData))?.error).toMatch(/letters, numbers/i);
  });
});
