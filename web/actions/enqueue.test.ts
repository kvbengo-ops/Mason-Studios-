import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSceneStatuses,
  retryAllFailed,
  retryScene,
  enqueueRender,
  enqueueScene,
  rerenderScene,
} from "./enqueue";
import { requireProject, requireScene } from "@/actions/guard";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { assertWithinSpendCaps } from "@/lib/spend";
import {
  GEMINI_OMNI_VIDEO,
  HAILUO_2_3_PRO,
  KLING_3_PRO,
  SEEDANCE_2_5,
  isModelAvailableForSelection,
  priceForSecond,
} from "@/lib/models";
import type * as ModelsModule from "@/lib/models";

vi.mock("@/lib/models", async () => {
  const actual = await vi.importActual<typeof ModelsModule>("@/lib/models");
  return {
    ...actual,
    isModelAvailableForSelection: vi.fn(actual.isModelAvailableForSelection),
  };
});

// retryScene (and retryAllFailed/rerenderScene alongside it) is one of the
// re-render paths required to clear a stale `projects.status = 'delivered'`
// — see actions/deliver.ts's markDelivered doc comment and
// 0018_derived_project_status.sql: 'delivered' is the one status value
// still read back as fact, so a project that re-renders after being marked
// delivered must not keep reporting it. Before this fix, retryScene wrote
// scenes.status only and left `projects.status` untouched — this test pins
// the fix: the project row is written unconditionally, same pattern
// enqueueRender/rerenderScene already use, which is what takes a delivered
// project back out of that status.
vi.mock("@/actions/guard", () => ({
  requireScene: vi.fn(),
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/spend", () => ({
  assertWithinSpendCaps: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

// scene_versions' own maybeSingle/single resolve immediately rather than
// through `then` — openSceneVersion (actions/enqueue.ts) awaits them
// directly without ever iterating the builder as a thenable.
function fakeBuilder(result: FakeQueryResult = { data: null, error: null }): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    in: vi.fn(() => builder),
    is: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    single: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

// scene_versions defaults to "no prior version, version row created fine" —
// openSceneVersion's own best-effort failure path (actions/enqueue.ts) is
// only exercised by a test that overrides this explicitly.
function fakeSceneVersionsBuilder(): FakeQueryBuilder {
  return fakeBuilder({ data: { id: "version-1", n: 1 }, error: null });
}

function fakeAdminClient(): {
  from: ReturnType<typeof vi.fn>;
  builders: {
    scenes: FakeQueryBuilder;
    assets: FakeQueryBuilder;
    scene_references: FakeQueryBuilder;
    projects: FakeQueryBuilder;
    scene_versions: FakeQueryBuilder;
  };
} {
  const builders = {
    scenes: fakeBuilder(),
    assets: fakeBuilder(),
    // Retry/re-render now read live scene_references before pricing. The
    // default fixture has none, so make that shape explicit instead of
    // returning null and accidentally exercising the legacy fallback.
    scene_references: fakeBuilder({ data: [], error: null }),
    projects: fakeBuilder(),
    scene_versions: fakeSceneVersionsBuilder(),
  };
  return {
    from: vi.fn((table: string) => {
      const builder = builders[table as keyof typeof builders];
      if (!builder) throw new Error(`Test did not stub table "${table}"`);
      return builder;
    }),
    builders,
  };
}

const failedScene = {
  id: "scene-1",
  project_id: "project-1",
  status: "failed" as const,
  script_line: "line",
  video_prompt: "prompt",
  is_talking_head: false,
  duration_s: 8,
};

afterEach(() => {
  vi.mocked(requireScene).mockReset();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(assertWithinSpendCaps).mockReset();
});

describe("retryScene", () => {
  it("clears a stale 'delivered' status by writing the project back to 'rendering'", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: failedScene,
      project: { id: "project-1", status: "delivered", render_settings: {} },
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await retryScene("scene-1");

    expect(result).toBeUndefined();
    expect(admin.builders.projects.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rendering" }),
    );
  });

  it("still refuses a scene that isn't 'failed', without touching the project row", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { ...failedScene, status: "queued" },
      project: { id: "project-1", status: "delivered", render_settings: {} },
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await retryScene("scene-1");

    expect(result).toEqual({ error: expect.stringMatching(/not "failed"/) });
    expect(admin.from).not.toHaveBeenCalled();
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
  });
});

// One query for `scenes`, one for `runs` (never one `runs` query per scene —
// see getSceneStatuses's own doc comment) — this pins the TypeScript-side
// reduction, lib/render-error.ts's latestErrorsByScene, actually picking the
// newest of several run rows for the same scene rather than the first/last
// one the (unordered, from the mock's point of view) query happened to
// return.
function fakeSelectBuilder(result: FakeQueryResult): {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  then: FakeQueryBuilder["then"];
} {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    not: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (onFulfilled: (r: FakeQueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

describe("getSceneStatuses", () => {
  afterEach(() => {
    vi.mocked(requireProject).mockReset();
    vi.mocked(createClient).mockReset();
  });

  it("reduces several run rows for one scene down to just the newest error", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1" },
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const scenesBuilder = fakeSelectBuilder({
      data: [
        { id: "scene-1", status: "failed", submitted_at: "2026-08-14T09:00:00.000Z" },
        { id: "scene-2", status: "done", submitted_at: "2026-08-14T09:00:00.000Z" },
      ],
      error: null,
    });
    const runsBuilder = fakeSelectBuilder({
      data: [
        // Deliberately unordered/mixed — the reduction must sort by
        // created_at itself, not trust query order.
        {
          scene_id: "scene-1",
          error: "an older, superseded failure reason",
          created_at: "2026-08-14T09:00:00.000Z",
        },
        { scene_id: "scene-1", error: "timeout", created_at: "2026-08-14T09:05:00.000Z" },
        {
          scene_id: "scene-2",
          error: "a stale error from before scene-2 succeeded",
          created_at: "2026-08-14T09:01:00.000Z",
        },
      ],
      error: null,
    });

    vi.mocked(createClient).mockResolvedValue({
      from: vi.fn((table: string) => (table === "scenes" ? scenesBuilder : runsBuilder)),
    } as never);

    const result = await getSceneStatuses("project-1");

    const sceneOne = result.find((s) => s.id === "scene-1");
    expect(sceneOne?.error?.message).toMatch(/transient failure/i);
    expect(sceneOne?.error?.message).not.toMatch(/superseded/);

    // scene-2 isn't 'failed' — its runs row (from a prior attempt) must not
    // resurface as if it were the current status.
    const sceneTwo = result.find((s) => s.id === "scene-2");
    expect(sceneTwo?.error).toBeNull();
  });
});

// Gemini's video-input rate is a fixed published price, not a per-second
// output rate. These cap checks therefore need the live scene_references
// rows (not just scenes.ref_frame_asset_id) before they can quote safely.
describe("Gemini live video-reference cap pricing", () => {
  const project = {
    id: "project-1",
    status: "draft",
    render_settings: {
      model: GEMINI_OMNI_VIDEO.id,
      resolution: "720p",
      fps: 24,
    },
  };
  const scene = {
    id: "scene-1",
    project_id: "project-1",
    status: "frame_ready" as const,
    script_line: "line",
    video_prompt: "prompt",
    is_talking_head: false,
    duration_s: 4,
    ref_frame_asset_id: "frame-1",
    render_settings_override: null,
  };

  function adminWithLiveVideoReference(sceneIds: readonly string[] = ["scene-1"]) {
    const admin = fakeAdminClient();
    admin.builders.scene_references = fakeBuilder({
      data: sceneIds.map((scene_id) => ({
        scene_id,
        asset_id: "source-video-1",
        kind: "video",
      })),
      error: null,
    });
    admin.builders.assets = fakeBuilder({
      data: [{ id: "source-video-1", kind: "video_ref", duration_s: 9 }],
      error: null,
    });
    return admin;
  }

  beforeEach(() => {
    vi.mocked(assertWithinSpendCaps).mockResolvedValue({ error: "Over cap." });
    // The separate receipt-gate tests below cover production's refusal. This
    // seam models the future paid-receipt state so these tests can reach the
    // cap calculation and pin its live-reference input.
    vi.mocked(isModelAvailableForSelection).mockReturnValue(true);
  });

  afterEach(() => {
    vi.mocked(requireProject).mockReset();
    vi.mocked(requireScene).mockReset();
    vi.mocked(createClient).mockReset();
    vi.mocked(createAdminClient).mockReset();
    vi.mocked(assertWithinSpendCaps).mockReset();
    vi.mocked(isModelAvailableForSelection).mockImplementation(
      (modelId) => modelId !== GEMINI_OMNI_VIDEO.id,
    );
  });

  it("prices enqueueScene at Gemini's fixed video-input cost", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene,
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    const admin = adminWithLiveVideoReference();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await enqueueScene("scene-1");

    expect(assertWithinSpendCaps).toHaveBeenCalledWith("user-1", { role: "editor" }, 0.84);
  });

  it("prices enqueueRender's frame-ready batch at Gemini's fixed video-input cost", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    const scenesBuilder = fakeSelectBuilder({ data: [scene], error: null });
    vi.mocked(createClient).mockResolvedValue({ from: vi.fn(() => scenesBuilder) } as never);
    const admin = adminWithLiveVideoReference();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await enqueueRender("project-1");

    expect(assertWithinSpendCaps).toHaveBeenCalledWith("user-1", { role: "editor" }, 0.84);
    expect(admin.builders.scene_references.in).toHaveBeenCalledTimes(1);
    expect(admin.builders.assets.in).toHaveBeenCalledTimes(1);
  });

  it("prices retryAllFailed's failed batch at Gemini's fixed video-input cost", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    const scenesBuilder = fakeSelectBuilder({
      data: [
        { ...scene, status: "failed" },
        { ...scene, id: "scene-2", status: "failed" },
      ],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ from: vi.fn(() => scenesBuilder) } as never);
    const admin = adminWithLiveVideoReference(["scene-1", "scene-2"]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await retryAllFailed("project-1");

    expect(assertWithinSpendCaps).toHaveBeenCalledWith("user-1", { role: "editor" }, 1.68);
    expect(admin.builders.scene_references.in).toHaveBeenCalledTimes(1);
    expect(admin.builders.assets.in).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The spend-cap seam for 0045_scene_render_settings_override.sql
// ---------------------------------------------------------------------------
// THE test for the per-scene model override, and the reason that migration is
// dangerous rather than merely additive.
//
// Every function in actions/enqueue.ts prices a render and hands that number
// to assertWithinSpendCaps BEFORE writing anything — the number IS the
// guard. Before 0045 there was exactly one model per project, so pricing
// from projects.render_settings could not be wrong. With a per-scene
// override, a scene can render on a model several times the project's rate;
// price it at the project's rate and the ceiling is enforced against a bill
// that will never be charged, while the real one sails past it. Nothing else
// catches this: the write succeeds, the worker submits happily (it reads the
// merged settings — that is the point of doing the merge in SQL), and the
// only symptom is the fal invoice.
//
// So these assert on the ARGUMENT assertWithinSpendCaps receives, not on
// whether it was called. Both directions matter:
//
//   * an override supplied on THIS call must be priced at the new model, and
//   * an override a PREVIOUS retry left on the scene must still be priced at
//     that model on a later, plain retry — 0045's overrides are sticky, so
//     "no model was passed" does not mean "the project's model".
//
// Hailuo vs Kling (talking-head, sound on) is the pair with a real spread
// among the three models kie serves ($0.045/s vs $0.135/s), and reaching
// Kling's SOUND rate at all requires a talking-head scene with audio on
// (lib/models.ts's renderAudioOn) — hence the AUDIO_ENABLED flip and
// is_talking_head below. If those two facts change, this test starts
// asserting that two identical numbers differ and will say so loudly
// rather than silently stop testing anything. 10s, not 8: Hailuo's own
// allowed set is {6, 10} only.
describe("per-scene model override and the spend cap", () => {
  const SECONDS = 10;
  const cheapUsd = SECONDS * priceForSecond(HAILUO_2_3_PRO, HAILUO_2_3_PRO.defaultResolution);
  // kie bills exactly the seconds requested — no billed-seconds multiplier
  // the way fal's Kling once needed (see lib/kie/rates.ts's own header).
  // audioOn=true: Kling's SOUND rate, a different measured number from its
  // silent one, not a multiplier on top of it.
  const expensiveUsd = SECONDS * priceForSecond(KLING_3_PRO, KLING_3_PRO.defaultResolution, true);

  const talkingHeadScene = {
    ...failedScene,
    is_talking_head: true,
    duration_s: SECONDS,
    render_settings_override: null,
  };
  // A project explicitly on the CHEAP model — this is the settings blob the
  // pre-0045 code would have priced everything from.
  const cheapProject = {
    id: "project-1",
    status: "rendering",
    render_settings: {
      model: HAILUO_2_3_PRO.id,
      resolution: HAILUO_2_3_PRO.defaultResolution,
      fps: HAILUO_2_3_PRO.defaultFps,
    },
  };

  let previousAudioEnabled: string | undefined;

  beforeEach(() => {
    previousAudioEnabled = process.env.AUDIO_ENABLED;
    process.env.AUDIO_ENABLED = "1";
  });

  afterEach(() => {
    if (previousAudioEnabled === undefined) {
      delete process.env.AUDIO_ENABLED;
    } else {
      process.env.AUDIO_ENABLED = previousAudioEnabled;
    }
    vi.mocked(requireProject).mockReset();
    vi.mocked(createClient).mockReset();
  });

  // Sanity anchor: the two rates really are different, so every expectation
  // below is a real assertion rather than two equal numbers agreeing.
  it("prices the two models apart at all", () => {
    expect(expensiveUsd).toBeGreaterThan(cheapUsd * 2);
  });

  it("prices retryScene's expensive override at the EXPENSIVE model, not the project's cheap one", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: talkingHeadScene,
      project: cheapProject,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await retryScene("scene-1", KLING_3_PRO.id);

    expect(result).toBeUndefined();
    expect(assertWithinSpendCaps).toHaveBeenCalledWith("user-1", { role: "editor" }, expensiveUsd);
    // The bypass, stated as its own expectation so a regression names itself:
    // the cap must never have seen the project's cheap price.
    expect(assertWithinSpendCaps).not.toHaveBeenCalledWith("user-1", { role: "editor" }, cheapUsd);
    // And the override is written onto the scene in the same statement that
    // re-queues it — the worker claims on status='queued' and reads the
    // column in that same claim, so a later write would be too late.
    expect(admin.builders.scenes.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "queued",
        render_settings_override: { model: KLING_3_PRO.id },
      }),
    );
  });

  it("keeps pricing a STICKY override at the expensive model on a later plain retry", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      // No modelId passed to retryScene below — this scene simply still
      // carries the override an earlier retry wrote. 0045 never clears it,
      // so this is what the scene will actually render on.
      scene: { ...talkingHeadScene, render_settings_override: { model: KLING_3_PRO.id } },
      project: cheapProject,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await retryScene("scene-1");

    expect(assertWithinSpendCaps).toHaveBeenCalledWith("user-1", { role: "editor" }, expensiveUsd);
    // A plain retry says nothing about the model, so it must not rewrite the
    // column either — sticky means an explicit write is the only thing that
    // replaces one.
    expect(admin.builders.scenes.update).toHaveBeenCalledWith(
      expect.not.objectContaining({ render_settings_override: expect.anything() }),
    );
  });

  it("prices retryAllFailed's bulk override at the expensive model for every scene it re-queues", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: cheapProject,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);

    const scenesBuilder = fakeSelectBuilder({
      data: [
        { ...talkingHeadScene, id: "scene-1" },
        { ...talkingHeadScene, id: "scene-2" },
        // Not failed — must not be priced, and must not be repointed either.
        { ...talkingHeadScene, id: "scene-3", status: "done" },
      ],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({
      from: vi.fn(() => scenesBuilder),
    } as never);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await retryAllFailed("project-1", KLING_3_PRO.id);

    expect(result).toBeUndefined();
    expect(assertWithinSpendCaps).toHaveBeenCalledWith(
      "user-1",
      { role: "editor" },
      expensiveUsd * 2,
    );
    expect(admin.builders.scenes.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "queued",
        render_settings_override: { model: KLING_3_PRO.id },
      }),
    );
  });

  it("refuses a model that cannot be selected, before any price or write", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: talkingHeadScene,
      project: cheapProject,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await retryScene("scene-1", "not-a-model");

    expect(result).toEqual({ error: expect.stringMatching(/Invalid retry model/) });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("refuses Gemini retry overrides without a paid receipt before any price or write", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: talkingHeadScene,
      project: cheapProject,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await retryScene("scene-1", GEMINI_OMNI_VIDEO.id);

    expect(result).toEqual({
      error: "Gemini Omni Video is unavailable until a paid receipt exists.",
    });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("refuses a stored unpaid Gemini override on a plain bulk retry", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: cheapProject,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    const scenesBuilder = fakeSelectBuilder({
      data: [
        {
          ...talkingHeadScene,
          render_settings_override: { model: GEMINI_OMNI_VIDEO.id },
        },
      ],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ from: vi.fn(() => scenesBuilder) } as never);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await retryAllFailed("project-1");

    expect(result).toEqual({
      error: "Gemini Omni Video is unavailable until a paid receipt exists.",
    });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(admin.from).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// enqueueScene — the workbench's per-scene "Render this scene" button.
// ---------------------------------------------------------------------------
describe("enqueueScene", () => {
  const framedScene = {
    id: "scene-1",
    project_id: "project-1",
    status: "frame_ready" as const,
    script_line: "line",
    video_prompt: "prompt",
    is_talking_head: false,
    duration_s: 8,
    ref_frame_asset_id: "ref-1",
    render_settings_override: null,
  };
  const project = {
    id: "project-1",
    status: "draft",
    render_settings: { model: SEEDANCE_2_5.id, resolution: "1080p", fps: 24 },
  };

  afterEach(() => {
    vi.mocked(requireScene).mockReset();
    vi.mocked(createAdminClient).mockReset();
    vi.mocked(assertWithinSpendCaps).mockReset();
  });

  it("refuses an unauthorized caller before touching the admin client or the spend cap", async () => {
    vi.mocked(requireScene).mockRejectedValue(new Error("not authorized"));

    await expect(enqueueScene("scene-1")).rejects.toThrow("not authorized");

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
  });

  it("refuses a scene that has already been queued/rendered/failed once, before any spend check", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { ...framedScene, status: "queued" },
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const result = await enqueueScene("scene-1");

    expect(result).toEqual({
      error: expect.stringMatching(/already.*rendered|already.*enqueued/i),
    });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("refuses a scene with no reference frame yet, before any spend check", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { ...framedScene, ref_frame_asset_id: null },
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const result = await enqueueScene("scene-1");

    expect(result).toEqual({ error: expect.stringMatching(/reference frame/) });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("stops at a spend-cap refusal and writes nothing", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: framedScene,
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue({ error: "Over cap." });

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await enqueueScene("scene-1");

    expect(result).toEqual({ error: "Over cap." });
    // Live video-reference metadata is read before the cap check; a cap
    // refusal must still prevent every queue/version/project write.
    expect(admin.builders.scenes.update).not.toHaveBeenCalled();
    expect(admin.builders.projects.update).not.toHaveBeenCalled();
    expect(admin.builders.scene_versions.insert).not.toHaveBeenCalled();
  });

  it("on the happy path: opens a version, queues just this scene, and marks the project rendering", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: framedScene,
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await enqueueScene("scene-1");

    expect(result).toBeUndefined();
    // A version is opened for the attempt about to be billed.
    expect(admin.builders.scene_versions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ scene_id: "scene-1", n: 2 }),
    );
    // Only this scene is queued — not a project-wide batch. dev: true
    // because MODE is unset in the test process and defaults to
    // "development" (lib/mode.ts) — this is the write half of the MODE
    // contract: a scene queued here can only ever be claimed by a worker
    // also running MODE=development.
    expect(admin.builders.scenes.update).toHaveBeenCalledWith({ status: "queued", dev: true });
    expect(admin.builders.scenes.eq).toHaveBeenCalledWith("id", "scene-1");
    expect(admin.builders.projects.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rendering" }),
    );
  });
});

// ---------------------------------------------------------------------------
// rerenderScene — the selective-regeneration path for an already-`done`
// scene (0058_scene_versions.sql).
// ---------------------------------------------------------------------------
describe("rerenderScene", () => {
  const doneScene = {
    id: "scene-1",
    project_id: "project-1",
    status: "done" as const,
    script_line: "line",
    video_prompt: "prompt",
    is_talking_head: false,
    duration_s: 8,
    ref_frame_asset_id: "ref-1",
    render_settings_override: null,
    active_version_id: "version-old",
  };
  const project = {
    id: "project-1",
    status: "rendering",
    render_settings: { model: SEEDANCE_2_5.id, resolution: "1080p", fps: 24 },
  };

  afterEach(() => {
    vi.mocked(requireScene).mockReset();
    vi.mocked(createAdminClient).mockReset();
    vi.mocked(assertWithinSpendCaps).mockReset();
  });

  it("refuses a scene that has never rendered ('draft'/'frame_ready') — only a done scene can be re-rendered", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { ...doneScene, status: "draft" },
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const result = await rerenderScene("scene-1");

    expect(result).toEqual({ error: expect.stringMatching(/not "done"/) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("refuses a scene already in flight ('queued'/'rendering') — would submit a second paid job", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { ...doneScene, status: "rendering" },
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const result = await rerenderScene("scene-1");

    expect(result).toEqual({ error: expect.stringMatching(/already in flight/) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("refuses an unpaid Gemini override before estimating or writing a re-render", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { ...doneScene, render_settings_override: { model: GEMINI_OMNI_VIDEO.id } },
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const result = await rerenderScene("scene-1");

    expect(result).toEqual({
      error: "Gemini Omni Video is unavailable until a paid receipt exists.",
    });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // THE fix versioning exists for: a re-render used to delete the old clip
  // outright, destroying paid output. It must not happen any more — and as
  // of 0060_final_versions.sql the project's assembled cut is not deleted
  // either (getCutStatus reports it stale instead), so a 'new' re-render
  // deletes NOTHING at all.
  it("versionMode 'new' opens a fresh version and does NOT delete the previous clip", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: doneScene,
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await rerenderScene("scene-1", "new");

    expect(result).toBeUndefined();
    expect(admin.builders.assets.delete).not.toHaveBeenCalled();
    expect(admin.builders.scene_versions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ scene_id: "scene-1" }),
    );
    expect(admin.builders.scenes.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued" }),
    );
  });

  it("defaults to 'new' (non-destructive) when versionMode is omitted", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: doneScene,
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);

    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await rerenderScene("scene-1");

    expect(admin.builders.assets.delete).not.toHaveBeenCalled();
    expect(admin.builders.scene_versions.insert).toHaveBeenCalled();
    expect(admin.builders.scene_versions.update).not.toHaveBeenCalled();
  });

  it("versionMode 'update' reuses the current version and DOES delete its old clip", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: doneScene,
      project,
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);

    const admin = fakeAdminClient();
    // reuseSceneVersion reads the active version's clip_asset_id to decide
    // whether there is an old clip to delete.
    admin.builders.scene_versions = fakeBuilder({
      data: { id: "version-old", clip_asset_id: "clip-old" },
      error: null,
    });
    admin.from = vi.fn((table: string) => {
      const builder = admin.builders[table as keyof typeof admin.builders];
      if (!builder) throw new Error(`Test did not stub table "${table}"`);
      return builder;
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await rerenderScene("scene-1", "update");

    expect(result).toBeUndefined();
    // Exactly one: the clip this version is replacing. Nothing project-level
    // is touched any more.
    expect(admin.builders.assets.delete).toHaveBeenCalledTimes(1);
    expect(admin.builders.assets.eq).toHaveBeenCalledWith("id", "clip-old");
    // The version row is overwritten in place, not a new one opened.
    expect(admin.builders.scene_versions.insert).not.toHaveBeenCalled();
    expect(admin.builders.scene_versions.update).toHaveBeenCalledWith(
      expect.objectContaining({ clip_asset_id: null }),
    );
  });
});
