// redescribeElement's kind branch (actions/ugc.ts), split into its own file
// rather than folded into actions/ugc.test.ts's pure-function suite: this
// needs the Supabase/guard/spend mocking harness actions/elements.test.ts
// already established for the sibling describe call, and mixing that
// scaffolding into a file whose header specifically says "the guards, the
// Supabase client and storage are mocked" for a DIFFERENT reason would blur
// what each file is pinning.
//
// WHAT THIS PINS. Before this change, redescribeElement only ever called
// describeReferenceImage — pointed at an audio element it either sent an
// mp3 to Claude as a picture (bad) or (before the UI gate that hid the
// button) was simply unreachable. It now branches on assets.kind: an image
// keeps going to Claude, an audio element goes to kie's Gemini pass
// (lib/kie-audio-describe.ts). These tests pin that routing, the vendor/
// model recorded for each branch, and that a failure never fails silently.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redescribeElement } from "./ugc";
import { requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { describeReferenceImage } from "@/lib/claude";
import { AudioDescribeUnusableError, describeReferenceAudio } from "@/lib/kie-audio-describe";
import {
  MAX_DESCRIBABLE_VIDEO_BYTES,
  VideoDescribeUnusableError,
  describeReferenceVideo,
} from "@/lib/kie-video-describe";
import { recordRun } from "@/lib/runs";

vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  signedUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
}));

vi.mock("@/lib/spend", () => ({
  assertWithinSpendCaps: vi.fn(async () => undefined),
}));

vi.mock("@/lib/claude", () => ({
  CLAUDE_VENDOR: "anthropic",
  describeReferenceImage: vi.fn(async () => ({ description: "a woman in a linen shirt" })),
}));

// A REAL class in the mock, not a stub: redescribeElement decides whether to
// record the metered cost with `err instanceof AudioDescribeUnusableError`,
// and a mock that omitted it left that check reading `instanceof undefined`
// — a TypeError inside the catch block, which is a worse failure than the one
// being handled.
//
// Declared INSIDE the factory. vi.mock is hoisted above every top-level
// statement in this file, so a class defined outside it is still in its
// temporal dead zone when the factory runs.
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
    describeReferenceAudio: vi.fn(),
  };
});

// Same shape, same reason as the kie-audio-describe mock immediately above:
// a real class (redescribeElement's catch block does `err instanceof
// VideoDescribeUnusableError`), declared inside the factory to dodge the
// temporal-dead-zone hoist. MAX_DESCRIBABLE_VIDEO_BYTES is re-exported at
// its real value (not re-declared ad hoc) so the too-large test below is
// pinned against the same constant production code actually compares
// against, and would fail if that constant's value ever drifted.
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
    MAX_DESCRIBABLE_VIDEO_BYTES: 15 * 1024 * 1024,
    VideoDescribeUnusableError,
    describeReferenceVideo: vi.fn(),
  };
});

vi.mock("@/lib/runs", () => ({
  recordRun: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const USER = { id: "user-1", email: "editor@example.com" };

interface FakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/** Minimal chainable stand-in covering redescribeElement's two chains: select().eq().maybeSingle() to read, update().eq() to write. */
function fakeBuilder(result: FakeResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    update: vi.fn(() => builder),
  };
  return builder;
}

// Returns the update-chain builder so a test can assert `.update` was never
// called at all — the only reliable way to pin "an unusable describe leaves
// the element's description untouched": redescribeElement's write happens
// AFTER the describe call succeeds, so a rejected describe means the second
// `.from("elements")` hit (the one this builder stands in for) never
// happens, and there is no row to inspect for "unchanged" — only a write
// that either did or did not occur.
function mockAdmin(opts: {
  elementRow: Record<string, unknown>;
  assetRow: Record<string, unknown>;
}): { elementUpdateBuilder: ReturnType<typeof fakeBuilder> } {
  const elementSelectBuilder = fakeBuilder({ data: opts.elementRow, error: null });
  const assetBuilder = fakeBuilder({ data: opts.assetRow, error: null });
  const elementUpdateBuilder = fakeBuilder({ data: null, error: null });

  let elementCalls = 0;
  vi.mocked(createAdminClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === "assets") return assetBuilder;
      if (table === "elements") {
        elementCalls += 1;
        // First hit reads the element; the second (the .update() call) writes
        // the fresh description back — same ordering redescribeElement itself
        // makes.
        return elementCalls === 1 ? elementSelectBuilder : elementUpdateBuilder;
      }
      throw new Error(`Unexpected table in test: ${table}`);
    }),
  } as never);

  return { elementUpdateBuilder };
}

function formData(elementId = "element-1"): FormData {
  const fd = new FormData();
  fd.set("projectId", "project-1");
  fd.set("elementId", elementId);
  return fd;
}

beforeEach(() => {
  vi.mocked(requireProject).mockResolvedValue({
    user: USER,
    profile: {} as never,
    project: { id: "project-1" } as never,
    reached: {} as never,
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("redescribeElement — routes by assets.kind", () => {
  it("sends a ref_frame element to describeReferenceImage, billed at the fixed compiler estimate", async () => {
    mockAdmin({
      elementRow: {
        id: "element-1",
        name: "jen",
        category: "character",
        asset_id: "asset-1",
        user_id: USER.id,
      },
      assetRow: { storage_key: "projects/project-1/ref_frame/jen.jpg", kind: "ref_frame" },
    });

    const result = await redescribeElement(formData());

    expect(result).toEqual({ description: "a woman in a linen shirt" });
    expect(describeReferenceImage).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: "https://signed.example/projects/project-1/ref_frame/jen.jpg",
      }),
    );
    expect(describeReferenceAudio).not.toHaveBeenCalled();
    expect(vi.mocked(recordRun)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "anthropic", model: "claude-sonnet-5" }),
    );
  });

  it("sends an audio element to describeReferenceAudio (never describeReferenceImage), vendor kie", async () => {
    mockAdmin({
      elementRow: {
        id: "element-1",
        name: "voice1",
        category: "audio",
        asset_id: "asset-2",
        user_id: USER.id,
      },
      assetRow: { storage_key: "projects/project-1/audio/voice1.mp3", kind: "audio" },
    });
    vi.mocked(describeReferenceAudio).mockResolvedValue({
      description:
        "a mature female voice with a clear, resonant timbre. Delivery: calm and deliberate.",
      // The REAL metered figure, deliberately different from the $0.001
      // spend-cap estimate — this pins that recordRun gets the receipt, not
      // the guess it was checked against.
      costUsd: 0.00015,
    });

    const result = await redescribeElement(formData());

    expect(result).toEqual({
      description:
        "a mature female voice with a clear, resonant timbre. Delivery: calm and deliberate.",
    });
    expect(describeReferenceAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        audioUrl: "https://signed.example/projects/project-1/audio/voice1.mp3",
      }),
    );
    expect(describeReferenceImage).not.toHaveBeenCalled();
    expect(vi.mocked(recordRun)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: 0.00015 }),
    );
  });

  it("never fails silently: an unusable clip's message reaches the operator, and cost is recorded null", async () => {
    mockAdmin({
      elementRow: {
        id: "element-1",
        name: "voice1",
        category: "audio",
        asset_id: "asset-2",
        user_id: USER.id,
      },
      assetRow: { storage_key: "projects/project-1/audio/voice1.mp3", kind: "audio" },
    });
    vi.mocked(describeReferenceAudio).mockRejectedValue(
      new Error(
        "That clip could not be used as a voice reference (mostly silence) — write the description yourself.",
      ),
    );

    const result = await redescribeElement(formData());

    expect(result).toEqual({
      error:
        "That clip could not be used as a voice reference (mostly silence) — write the description yourself.",
    });
    expect(vi.mocked(recordRun)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: null }),
    );
  });

  it("records what a refused clip actually cost, when the refusal carried a receipt", async () => {
    // Null is the honest answer when the charge is unknown — a request that
    // never landed, a body that would not parse. It is the WRONG answer when
    // kie listened to the clip, reported credits_consumed in the same
    // response, and only then said the clip was no good.
    mockAdmin({
      elementRow: {
        id: "element-1",
        name: "voice1",
        category: "audio",
        asset_id: "asset-2",
        user_id: USER.id,
      },
      assetRow: { storage_key: "projects/project-1/audio/voice1.mp3", kind: "audio" },
    });
    vi.mocked(describeReferenceAudio).mockRejectedValue(
      new AudioDescribeUnusableError(
        "That clip could not be used as a voice reference (music with no speech) — write the description yourself.",
        0.00015,
      ),
    );

    const result = await redescribeElement(formData());

    expect(result).toEqual({
      error:
        "That clip could not be used as a voice reference (music with no speech) — write the description yourself.",
    });
    expect(vi.mocked(recordRun)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: 0.00015 }),
    );
  });

  // Everything below pins the 2026-09-09 change: 'video_ref' used to be a
  // hard refusal here ("A video reference has to be described by hand for
  // now.") with no call to any describer at all. It now routes to
  // describeReferenceVideo, the same way 'audio' already routes to
  // describeReferenceAudio above. Reverting that routing — restoring the
  // refusal, or falling through to describeReferenceImage the way a
  // forgotten `else` branch would — fails every test in this block.
  it("sends a video_ref element to describeReferenceVideo by signed URL (never image or audio), vendor kie", async () => {
    mockAdmin({
      elementRow: {
        id: "element-1",
        name: "new_video1",
        category: "product",
        asset_id: "asset-3",
        user_id: USER.id,
      },
      assetRow: { storage_key: "projects/project-1/video_ref/clip1.mp4", kind: "video_ref" },
    });
    vi.mocked(describeReferenceVideo).mockResolvedValue({
      description: "a red sneaker, on a white studio floor, slowly rotating, static camera",
      // The REAL metered figure, deliberately different from the $0.0002
      // spend-cap estimate — same pin as the audio branch's equivalent test:
      // recordRun must get the receipt, not the guess it was checked
      // against.
      costUsd: 0.00012,
    });

    const result = await redescribeElement(formData());

    expect(result).toEqual({
      description: "a red sneaker, on a white studio floor, slowly rotating, static camera",
    });
    expect(describeReferenceVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        videoUrl: "https://signed.example/projects/project-1/video_ref/clip1.mp4",
      }),
    );
    // Not videoBase64 — the asset is already in storage by the time
    // redescribeElement runs, so there is no in-memory File to base64
    // (that path belongs to describe-on-save, not this action).
    expect(describeReferenceVideo).toHaveBeenCalledWith(
      expect.not.objectContaining({ videoBase64: expect.anything() }),
    );
    expect(describeReferenceAudio).not.toHaveBeenCalled();
    expect(describeReferenceImage).not.toHaveBeenCalled();
    expect(vi.mocked(recordRun)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: 0.00012 }),
    );
  });

  it("an unusable video leaves the element's description untouched and reports kie's message", async () => {
    const { elementUpdateBuilder } = mockAdmin({
      elementRow: {
        id: "element-1",
        name: "new_video1",
        category: "product",
        asset_id: "asset-3",
        user_id: USER.id,
      },
      assetRow: { storage_key: "projects/project-1/video_ref/clip1.mp4", kind: "video_ref" },
    });
    // The unusable-response path (kie watched the clip, billed for it, and
    // then said it could not be used) rather than a network failure — this
    // is the branch that would write a fabricated description if the second
    // guard in lib/kie-video-describe.ts (or this call site's handling of
    // it) were ever weakened.
    vi.mocked(describeReferenceVideo).mockRejectedValue(
      new VideoDescribeUnusableError(
        "That clip could not be used as a visual reference (blank frame) — write the description yourself.",
        0.00012,
      ),
    );

    const result = await redescribeElement(formData());

    expect(result).toEqual({
      error:
        "That clip could not be used as a visual reference (blank frame) — write the description yourself.",
    });
    // THE ASSERTION THAT MATTERS: no write. A prior version of this action
    // could plausibly have written `described.description` even on this
    // path if the error weren't propagated correctly — this line is what
    // catches that, not just the returned `error` string.
    expect(elementUpdateBuilder.update).not.toHaveBeenCalled();
    expect(vi.mocked(recordRun)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "kie", model: "gemini-3-8-flash", costUsd: 0.00012 }),
    );
  });

  it("refuses a video over MAX_DESCRIBABLE_VIDEO_BYTES before ever calling describeReferenceVideo, when the asset row carries a size", async () => {
    const { elementUpdateBuilder } = mockAdmin({
      elementRow: {
        id: "element-1",
        name: "new_video1",
        category: "product",
        asset_id: "asset-3",
        user_id: USER.id,
      },
      assetRow: {
        storage_key: "projects/project-1/video_ref/clip1.mp4",
        kind: "video_ref",
        bytes: MAX_DESCRIBABLE_VIDEO_BYTES + 1,
      },
    });

    const result = await redescribeElement(formData());

    expect(result).toEqual({
      error: expect.stringContaining("too large"),
    });
    // Refused for free: no kie call, no write, no billing record at all —
    // this clip's size was already known from the assets row, so nothing
    // here should cost a network round trip or a ledger row.
    expect(describeReferenceVideo).not.toHaveBeenCalled();
    expect(elementUpdateBuilder.update).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });
});
