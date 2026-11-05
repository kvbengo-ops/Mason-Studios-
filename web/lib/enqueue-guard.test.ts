import { describe, expect, it } from "vitest";
import {
  assertAllFramed,
  assertNotAlreadySpent,
  assertRenderableDurations,
  assertSceneRerenderable,
  assertSettingsAllowedForDurations,
  findUnrenderableDurations,
  scenesAwaitingRender,
} from "./enqueue-guard";
import {
  DEFAULT_RENDER_SETTINGS,
  KLING_3_PRO,
  SEEDANCE_2_5,
  type RenderSettings,
  type VideoModelDescriptor,
} from "./models";

// The project's render settings for every assertRenderableDurations test
// below — the default (Seedance 2.5, allowedDurationsS 4-15s) at its
// defaults, same as an unconfigured project. Duration validation reads
// settings.model (via pickModel), not resolution/fps, so only `model`
// actually matters here; the rest just has to be a valid RenderSettings
// shape.
const settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };

/**
 * An id VIDEO_MODELS has never heard of — getModel's fallback path (see its
 * own doc comment) is now the ONLY way an override lands on a different
 * model than the one named: there is no more "disabled descriptor" tier to
 * substitute away from (every real entry in VIDEO_MODELS is unconditionally
 * selectable), so the one remaining case is a stale or hand-written id that
 * doesn't resolve to anything. Standing in for the old SEEDANCE_2_MINI
 * fixture, which this test suite used for the same purpose before that
 * descriptor was removed outright rather than left disabled.
 */
const UNKNOWN_MODEL_ID = "some-removed-model";

describe("assertAllFramed", () => {
  it("allows an empty scene list", () => {
    expect(() => assertAllFramed([])).not.toThrow();
  });

  it("allows scenes that all have a reference frame", () => {
    expect(() =>
      assertAllFramed([{ ref_frame_asset_id: "a" }, { ref_frame_asset_id: "b" }]),
    ).not.toThrow();
  });

  it("refuses when any scene is missing a reference frame", () => {
    expect(() =>
      assertAllFramed([{ ref_frame_asset_id: "a" }, { ref_frame_asset_id: null }]),
    ).toThrow(/reference frame/i);
  });
});

describe("assertNotAlreadySpent", () => {
  it("allows all scenes in draft or frame_ready", () => {
    expect(() =>
      assertNotAlreadySpent([{ status: "draft" }, { status: "frame_ready" }]),
    ).not.toThrow();
  });

  it("refuses when a scene is queued", () => {
    expect(() => assertNotAlreadySpent([{ status: "queued" }])).toThrow(/already/i);
  });

  it("refuses when a scene is rendering", () => {
    expect(() => assertNotAlreadySpent([{ status: "rendering" }])).toThrow(/already/i);
  });

  it("refuses when a scene is done", () => {
    expect(() => assertNotAlreadySpent([{ status: "done" }])).toThrow(/already/i);
  });

  it("refuses when a scene is failed", () => {
    expect(() => assertNotAlreadySpent([{ status: "failed" }])).toThrow(/already/i);
  });
});

describe("findUnrenderableDurations — per-scene overrides", () => {
  // The gap this closes. A retry pins a scene to another model (0045) and
  // that choice is sticky, so the scene renders — and is validated by kie —
  // on THAT model, not the project's. The blocking callers in
  // actions/enqueue.ts each merged the override themselves before calling,
  // but the render gate passes the picker's raw project settings, so the
  // warning above the button could not see what the guard behind it would
  // refuse: a gate that shows nothing and then rejects the click.
  // Kling's allowed set ({3..15}) is a strict SUPERSET of Seedance25's
  // ({4..15}), so no override to a real, currently-offered model can shrink
  // what's legal below the project's own default. What this test
  // demonstrates instead, in the one direction still reachable: an override
  // to Kling (eligible here — talking-head + audio enabled) makes 3s legal
  // where it is illegal on the project's own (Seedance25) default.
  it("resolves an overridden scene against the OVERRIDE model's own allowed set, not the project's", () => {
    const groups = findUnrenderableDurations(
      [
        {
          duration_s: 3,
          is_talking_head: true,
          render_settings_override: { model: KLING_3_PRO.id },
        },
      ],
      settings,
      true,
    );

    expect(groups).toEqual([]);
  });

  it("catches the same scene when it is NOT overridden — 3s is illegal on the project's own default", () => {
    const groups = findUnrenderableDurations(
      [{ duration_s: 3, is_talking_head: true }],
      settings,
      true,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.model.id).toBe(SEEDANCE_2_5.id);
    expect(groups[0]?.durationsS).toEqual([3]);
  });

  // An override naming an id VIDEO_MODELS has never heard of (a stale value
  // from before a model was removed, or a hand-written SQL update — see
  // UNKNOWN_MODEL_ID's own comment) falls back to the default the same way
  // getModel(id) does for any other unrecognised id, before this function
  // ever sees the durations that unknown model would have allowed. 40s is
  // illegal on the fallback (Seedance25 caps at 30s), so the group is
  // reported against Seedance25, not against the id that was actually named.
  it("falls back to the default for an override naming an unrecognised model id", () => {
    const groups = findUnrenderableDurations(
      [
        {
          duration_s: 40,
          is_talking_head: false,
          render_settings_override: { model: UNKNOWN_MODEL_ID },
        },
      ],
      settings,
      false,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.model.id).toBe(SEEDANCE_2_5.id);
    expect(groups[0]?.durationsS).toEqual([40]);
  });

  it("leaves an un-overridden scene judged by the project's own model", () => {
    // 10s is legal on the project's own default (Seedance25, 4-15s) — no
    // override, nothing to report.
    expect(
      findUnrenderableDurations([{ duration_s: 10, is_talking_head: false }], settings, false),
    ).toEqual([]);
  });

  it("is idempotent for callers that already merged the override in", () => {
    // actions/enqueue.ts hands in settings it merged itself. Merging the
    // same override again must not change the verdict.
    const alreadyMerged = { ...settings, model: UNKNOWN_MODEL_ID };
    const groups = findUnrenderableDurations(
      [
        {
          duration_s: 40,
          is_talking_head: false,
          render_settings_override: { model: UNKNOWN_MODEL_ID },
        },
      ],
      alreadyMerged,
      false,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.model.id).toBe(SEEDANCE_2_5.id);
  });
});

describe("findUnrenderableDurations", () => {
  // assertRenderableDurations now throws FROM this function's result rather
  // than running its own scan (this task's whole point) — the render gate
  // renders a warning off the same list before the operator ever clicks
  // Render, so "empty means renderable" has to be true on its own, not just
  // as a side effect of the throwing wrapper's behaviour.
  it("returns empty for a batch whose durations all fit their routed model", () => {
    expect(
      findUnrenderableDurations(
        [
          { duration_s: 6, is_talking_head: false },
          { duration_s: 10, is_talking_head: false },
        ],
        settings,
        false,
      ),
    ).toEqual([]);
  });

  // Grouping is by MODEL, not a flat list of bad scenes (see this
  // function's own doc comment on why: a mixed batch can route different
  // scenes to different models for different reasons). settings here is the
  // project's default (Seedance25 — see its own `enabled` doc comment),
  // which stops at 30s. Three scenes at 40/31/40s must collapse to the two
  // DISTINCT offending durations, ascending, with the full scene count —
  // not three separate entries and not insertion order (40 appears before
  // 31 in the input).
  it("groups by model and reports distinct offending durations ascending, with the total scene count", () => {
    const groups = findUnrenderableDurations(
      [
        { duration_s: 40, is_talking_head: false },
        { duration_s: 31, is_talking_head: false },
        { duration_s: 40, is_talking_head: false },
      ],
      settings,
      false,
    );
    expect(groups).toEqual([{ model: SEEDANCE_2_5, durationsS: [31, 40], count: 3 }]);
  });
});

describe("assertRenderableDurations", () => {
  // The seam this task creates: assertRenderableDurations now THROWS FROM
  // findUnrenderableDurations's result instead of running its own scan, so
  // the two must never be able to drift — a batch findUnrenderableDurations
  // calls renderable must never throw here, and a batch it flags non-empty
  // must always throw. Asserted against each other (not restated expected
  // strings) across a spread of batches/settings so the two can't silently
  // diverge under some future edit to either one.
  it("throws iff findUnrenderableDurations reports a non-empty group list, across a spread of inputs", () => {
    const klingSettings: RenderSettings = {
      ...settings,
      model: KLING_3_PRO.id,
      resolution: KLING_3_PRO.defaultResolution,
      fps: KLING_3_PRO.defaultFps,
    };
    const cases: [{ duration_s: number; is_talking_head: boolean }[], RenderSettings, boolean][] = [
      [[{ duration_s: 6, is_talking_head: false }], settings, false],
      [[{ duration_s: 2.5, is_talking_head: false }], settings, false],
      [
        [
          { duration_s: 20, is_talking_head: false },
          { duration_s: 16, is_talking_head: false },
        ],
        settings,
        false,
      ],
      [[{ duration_s: 15, is_talking_head: false }], settings, false],
      [[{ duration_s: 16, is_talking_head: true }], klingSettings, true],
      [[{ duration_s: 6, is_talking_head: true }], klingSettings, true],
    ];

    for (const [scenes, caseSettings, audioEnabled] of cases) {
      const groups = findUnrenderableDurations(scenes, caseSettings, audioEnabled);
      if (groups.length === 0) {
        expect(() => assertRenderableDurations(scenes, caseSettings, audioEnabled)).not.toThrow();
      } else {
        expect(() => assertRenderableDurations(scenes, caseSettings, audioEnabled)).toThrow();
      }
    }
  });
});

describe("assertRenderableDurations (message content)", () => {
  // 2.5s is the exact value fal rejected on the first real render (LTX,
  // since decommissioned); 4s is what template v1 rows in the live database
  // still hold.
  it("throws on a duration no current model accepts", () => {
    expect(() =>
      assertRenderableDurations(
        [
          { duration_s: 6, is_talking_head: false },
          { duration_s: 2.5, is_talking_head: false },
        ],
        settings,
        false,
      ),
    ).toThrow(/2.5s/);
  });

  it("names every distinct bad duration once, so one message covers the batch", () => {
    // 2s and 3s, not 2s and 4s: Seedance25 (the default now) starts at 4s,
    // not LTX's old 6s floor — 4 is legal here where it used to be one of
    // the two offending values.
    expect(() =>
      assertRenderableDurations(
        [
          { duration_s: 3, is_talking_head: false },
          { duration_s: 2, is_talking_head: false },
          { duration_s: 3, is_talking_head: false },
        ],
        settings,
        false,
      ),
    ).toThrow(/2s, 3s/);
  });

  it("passes when every duration is in the allowed set", () => {
    // 6s and 15s: both legal on the default (Seedance25, 4-15s). 20s (LTX's
    // old ceiling) no longer is.
    expect(() =>
      assertRenderableDurations(
        [
          { duration_s: 6, is_talking_head: false },
          { duration_s: 15, is_talking_head: false },
        ],
        settings,
        false,
      ),
    ).not.toThrow();
  });

  // On a project that has never selected Kling (`settings` above, the
  // default — Seedance25, see its own `enabled` doc comment — at its
  // defaults), a talking-head scene must validate against that default,
  // same as any other scene — pickModel no longer routes it to Kling
  // automatically just because is_talking_head is true and audio is on.
  // This is the defect this whole routing rewrite exists to fix: Kling used
  // to be reachable without the project ever selecting it.
  it("validates a talking-head scene against the default model on a project that never selected Kling", () => {
    expect(() =>
      assertRenderableDurations([{ duration_s: 6, is_talking_head: true }], settings, true),
    ).not.toThrow();
    // 15s is legal on the default (Seedance25's own ceiling) — proves this
    // scene is genuinely being checked against Seedance25's set.
    expect(() =>
      assertRenderableDurations([{ duration_s: 15, is_talking_head: true }], settings, true),
    ).not.toThrow();
  });

  // Pins the bug this rewrite exists to fix (two independent audits): a
  // talking-head scene must be validated against the model pickModel will
  // actually route IT to, not against the project's one selected model —
  // see this function's doc comment and lib/models.ts's pickModel, which
  // mirrors worker/internal/kie/models.go's PickModel. Exercised here on a
  // project that has explicitly selected Kling, since that's the only way
  // a scene reaches it now.
  it("resolves each scene's model via pickModel, not the project's selected model alone", () => {
    const klingSettings: RenderSettings = {
      ...settings,
      model: KLING_3_PRO.id,
      resolution: KLING_3_PRO.defaultResolution,
      fps: KLING_3_PRO.defaultFps,
    };

    // A talking-head scene at Seedance25's shortest allowed duration, with
    // audio enabled, on a project that selected Kling: this scene genuinely
    // routes to Kling (not a substitution) — and 6s is legal there too
    // (Kling's real range is 3-15s, verified live; see KLING_3_PRO's own
    // doc comment).
    expect(() =>
      assertRenderableDurations([{ duration_s: 6, is_talking_head: true }], klingSettings, true),
    ).not.toThrow();

    // A duration neither model accepts must still fail, naming Kling now
    // (the model this scene actually routes to) rather than the default.
    expect(() =>
      assertRenderableDurations([{ duration_s: 2.5, is_talking_head: true }], klingSettings, true),
    ).toThrow(/2.5s/);

    // The one duration boundary that still tells the two models apart after
    // the 2026-08-29 cut: Kling's real range starts at 3s, one second below
    // Seedance25's own floor of 4s (Kling's [3..15] is a strict SUPERSET of
    // Seedance25's [4..15] — see this describe block's own comment above).
    // 3s is refused as "outside the allowed set" on neither model in
    // isolation... except it genuinely is legal on Kling and illegal on the
    // default, so a talking-head scene compiled at 3s must be ACCEPTED once
    // the project selects Kling — proving this scene is checked against
    // Kling's own set, not the default's.
    expect(() =>
      assertRenderableDurations([{ duration_s: 3, is_talking_head: true }], klingSettings, true),
    ).not.toThrow();

    // The same 3s scene on a project that has NOT selected Kling must be
    // REFUSED — it routes to the default (Seedance25), where 3s is illegal
    // (floor of 4s). Confirms this guard is genuinely keyed off
    // settings.model rather than is_talking_head alone.
    expect(() =>
      assertRenderableDurations([{ duration_s: 3, is_talking_head: true }], settings, true),
    ).toThrow(/Seedance 2\.5.*3s.*allowed 4, 5, 6, .*, 29, 30 seconds/s);

    // A duration illegal on BOTH models (31s — above either's ceiling) must
    // still be refused with a message naming whichever model the scene
    // actually routed to: Kling when selected, the default otherwise — not
    // a generic "no model accepts this" message.
    expect(() =>
      assertRenderableDurations([{ duration_s: 31, is_talking_head: true }], klingSettings, true),
    ).toThrow(/Kling 3\.0 \(31s.*allowed 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 seconds/s);
    expect(() =>
      assertRenderableDurations([{ duration_s: 31, is_talking_head: true }], settings, true),
    ).toThrow(/Seedance 2\.5.*31s.*allowed 4, 5, 6, .*, 29, 30 seconds/s);
  });
});

describe("assertSceneRerenderable", () => {
  // 'done' is the entire point of rerenderScene — a scene the operator
  // watched and disliked, with nothing else wrong with the render pipeline.
  it("allows a done scene", () => {
    expect(() => assertSceneRerenderable("done")).not.toThrow();
  });

  // Re-queuing a scene that's already in flight would submit a second paid
  // kie job for the same clip, not just be a redundant click — this is the
  // double-bill case the spec calls out by name.
  it("refuses a queued scene, naming the double-bill risk", () => {
    expect(() => assertSceneRerenderable("queued")).toThrow(/already in flight/i);
  });

  it("refuses a rendering scene, naming the double-bill risk", () => {
    expect(() => assertSceneRerenderable("rendering")).toThrow(/already in flight/i);
  });

  // 'failed' has its own dedicated recovery path (retryScene) — rerenderScene
  // must not silently duplicate it under a second name.
  it("refuses a failed scene and points at retryScene instead", () => {
    expect(() => assertSceneRerenderable("failed")).toThrow(/retryScene/);
  });

  it("refuses a scene that hasn't rendered yet", () => {
    expect(() => assertSceneRerenderable("draft")).toThrow(/not "done"/);
  });
});

describe("scenesAwaitingRender", () => {
  // The core promise of Test scene 1 only: after it lands, enqueueRender
  // must be able to run again and only pick up what's left.
  it("selects only draft/frame_ready scenes, in their original order", () => {
    const scenes = [
      { id: "a", status: "draft" as const },
      { id: "b", status: "queued" as const },
      { id: "c", status: "frame_ready" as const },
    ];
    expect(scenesAwaitingRender(scenes)).toEqual([
      { id: "a", status: "draft" },
      { id: "c", status: "frame_ready" },
    ]);
  });

  // This is the double-bill guard for the whole feature: a scene enqueueTestScene
  // already queued/rendered must never be swept back into a later enqueueRender
  // call just because it's still sitting in the same scenes array.
  it("never re-selects a scene that is queued, rendering, done, or failed", () => {
    const statuses = ["queued", "rendering", "done", "failed"] as const;
    for (const status of statuses) {
      expect(scenesAwaitingRender([{ id: "x", status }])).toEqual([]);
    }
  });

  it("selects nothing once every scene has left draft/frame_ready", () => {
    expect(
      scenesAwaitingRender([
        { id: "a", status: "done" },
        { id: "b", status: "queued" },
      ]),
    ).toEqual([]);
  });

  it("selects everything when nothing has been queued yet — the first-ever enqueueRender call", () => {
    const scenes = [
      { id: "a", status: "draft" as const },
      { id: "b", status: "frame_ready" as const },
    ];
    expect(scenesAwaitingRender(scenes)).toEqual(scenes);
  });
});

describe("single-scene guard (enqueueTestScene's scope)", () => {
  // enqueueTestScene calls these same guards with a one-element array —
  // scene 1 alone — rather than a parallel copy scoped to a single row.
  // These pin that a one-element array is treated identically to any other
  // list, not as some special case the guards happen to handle by accident.
  it("assertAllFramed refuses a lone scene missing its reference frame", () => {
    expect(() => assertAllFramed([{ ref_frame_asset_id: null }])).toThrow(/reference frame/i);
  });

  it("assertRenderableDurations refuses a lone scene with a bad duration", () => {
    expect(() =>
      assertRenderableDurations([{ duration_s: 2.5, is_talking_head: false }], settings, false),
    ).toThrow(/2.5s/);
  });

  it("assertNotAlreadySpent refuses re-testing a scene that's already queued", () => {
    // The guard against clicking "Test scene 1 only" twice — the second
    // click would otherwise submit a second paid job for the same clip.
    expect(() => assertNotAlreadySpent([{ status: "queued" }])).toThrow(/already/i);
  });

  it("passes a lone scene that is framed, renderable, and not yet spent", () => {
    expect(() => assertAllFramed([{ ref_frame_asset_id: "a" }])).not.toThrow();
    expect(() =>
      assertRenderableDurations([{ duration_s: 8, is_talking_head: false }], settings, false),
    ).not.toThrow();
    expect(() => assertNotAlreadySpent([{ status: "draft" }])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cross-field constraints: settings that are each legal alone, illegal
// together with a scene's length.
// ---------------------------------------------------------------------------

describe("assertSettingsAllowedForDurations", () => {
  const scenes = (...durations: number[]) => durations.map((duration_s) => ({ duration_s }));

  // Synthetic descriptors, not a real model. LTX (the fps constraint) and
  // Hailuo 2.3 Standard (the resolution constraint) both carried one of
  // these historically, and both descriptors are gone — LTX decommissioned
  // with fal, Hailuo Standard never priced on kie and removed outright (see
  // lib/models.ts's file header: "there is no 'disabled pending
  // verification' tier any more"). Every model VIDEO_MODELS carries today
  // has an empty maxDurationSByFps/maxDurationSByResolution, so testing this
  // function against real descriptors would only prove it's a no-op. A
  // fixture with the constraint the function exists to enforce proves the
  // MECHANISM still works, independent of which real model last happened to
  // exercise it — exactly the promise this function's own doc comment
  // makes: "a model that adds a limit on either axis is covered without
  // touching this function."
  const fpsConstrainedModel: VideoModelDescriptor = {
    ...SEEDANCE_2_5,
    id: "test-fps-constrained",
    label: "Test model (fps x duration)",
    allowedFps: [24, 50],
    maxDurationSByFps: { 50: 10 },
  };

  const resolutionConstrainedModel: VideoModelDescriptor = {
    ...SEEDANCE_2_5,
    id: "test-resolution-constrained",
    label: "Test model (resolution x duration)",
    allowedResolutions: ["768P", "1080p"],
    maxDurationSByResolution: { "1080p": 6 },
  };

  describe("fps x duration", () => {
    const withFps = (fps: number): RenderSettings => ({
      model: fpsConstrainedModel.id,
      resolution: fpsConstrainedModel.defaultResolution,
      fps,
    });

    it("throws when any scene is longer than the fps allows", () => {
      expect(() =>
        assertSettingsAllowedForDurations(scenes(6, 12), fpsConstrainedModel, withFps(50)),
      ).toThrow(/50 fps is only valid for clips of 10s or shorter/);
    });

    it("names how many scenes offend and the longest of them, not the batch size", () => {
      // 2 of 3, up to 14 — a message saying "3 scenes are too long" would
      // send the operator looking for a third scene that is fine.
      expect(() =>
        assertSettingsAllowedForDurations(scenes(6, 12, 14), fpsConstrainedModel, withFps(50)),
      ).toThrow(/2 of 3 scene\(s\) are longer \(up to 14s\)/);
    });

    it("allows a scene exactly at the limit", () => {
      // The boundary is <=, not <. 10s at 50fps is legal here, and a guard
      // that refused it would block a combination the vendor accepts.
      expect(() =>
        assertSettingsAllowedForDurations(scenes(10), fpsConstrainedModel, withFps(50)),
      ).not.toThrow();
    });

    it("allows any length at an fps that carries no limit", () => {
      expect(() =>
        assertSettingsAllowedForDurations(scenes(15), fpsConstrainedModel, withFps(24)),
      ).not.toThrow();
    });
  });

  describe("resolution x duration", () => {
    const withResolution = (resolution: string): RenderSettings => ({
      model: resolutionConstrainedModel.id,
      resolution,
      fps: resolutionConstrainedModel.defaultFps,
    });

    it("throws on a 10s scene at the constrained resolution", () => {
      expect(() =>
        assertSettingsAllowedForDurations(
          scenes(10),
          resolutionConstrainedModel,
          withResolution("1080p"),
        ),
      ).toThrow(/only accepts 1080p for clips of 6s or shorter/);
    });

    it("allows the same 10s scene at the unconstrained resolution", () => {
      // The point of the whole field: the length is not the problem and the
      // resolution is not the problem — only the pair is. A guard that
      // rejected 10s outright would ban the longer format entirely.
      expect(() =>
        assertSettingsAllowedForDurations(
          scenes(10),
          resolutionConstrainedModel,
          withResolution("768P"),
        ),
      ).not.toThrow();
    });

    it("allows a 6s scene at the constrained resolution", () => {
      expect(() =>
        assertSettingsAllowedForDurations(
          scenes(6),
          resolutionConstrainedModel,
          withResolution("1080p"),
        ),
      ).not.toThrow();
    });

    it("tells the operator to lower the resolution, not the frame rate", () => {
      // The two axes need two different fixes, and the fps message's advice
      // ("Lower the frame rate") is useless here.
      expect(() =>
        assertSettingsAllowedForDurations(
          scenes(10),
          resolutionConstrainedModel,
          withResolution("1080p"),
        ),
      ).toThrow(/Lower the resolution on the Render step, or shorten those scenes\./);
    });
  });

  it("passes a model that constrains neither axis", () => {
    expect(() =>
      assertSettingsAllowedForDurations(scenes(4, 15), SEEDANCE_2_5, {
        ...DEFAULT_RENDER_SETTINGS,
      }),
    ).not.toThrow();
  });

  it("passes an empty scene list", () => {
    // enqueueRender refuses an empty project earlier; this only pins that the
    // guard does not throw on Math.max of nothing (-Infinity) along the way.
    expect(() =>
      assertSettingsAllowedForDurations([], fpsConstrainedModel, {
        model: fpsConstrainedModel.id,
        resolution: fpsConstrainedModel.defaultResolution,
        fps: 50,
      }),
    ).not.toThrow();
  });
});
