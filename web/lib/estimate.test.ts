import { describe, expect, it } from "vitest";
import {
  estimateCost,
  estimateUsdForScenes,
  type EstimatableBrief,
  type OverridableScene,
} from "./estimate";
import {
  DEFAULT_RENDER_SETTINGS,
  KLING_3_PRO,
  SEEDANCE_2_5,
  billingResolution,
  clipCostUsd,
  pickModel,
  priceForSecond,
  renderAudioOn,
  type RenderSettings,
} from "./models";

function oneSceneBrief(isTalkingHead: boolean, durationS: number): EstimatableBrief {
  return {
    character: "Test Character",
    scenes: [
      {
        script_line: "line",
        video_prompt: "prompt",
        is_talking_head: isTalkingHead,
        duration_s: durationS,
      },
    ],
  };
}

describe("estimateCost", () => {
  it("prices a silent scene at the selected model's per-second rate for the given resolution", () => {
    // 720p, not the default 480p: proves the resolution argument is what
    // actually drives the price, not just whichever tier happens to be
    // selected by default.
    const settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, resolution: "720p" };
    const result = estimateCost(oneSceneBrief(false, 8), false, settings);
    expect(result.totalUsd).toBeCloseTo(8 * priceForSecond(SEEDANCE_2_5, "720p"));
    expect(result.silentCount).toBe(1);
    expect(result.talkingHeadCount).toBe(0);
  });

  it("bills a talking-head scene at the silent rate when audio is disabled", () => {
    const result = estimateCost(oneSceneBrief(true, 10), false, DEFAULT_RENDER_SETTINGS);
    expect(result.totalUsd).toBeCloseTo(
      10 * priceForSecond(SEEDANCE_2_5, DEFAULT_RENDER_SETTINGS.resolution),
    );
    // The informational split still reflects the script's real
    // is_talking_head value even though nothing billed at Kling's rate.
    expect(result.talkingHeadCount).toBe(1);
    expect(result.silentCount).toBe(0);
  });

  // THE regression this file exists to pin: estimateCost must never bill a
  // talking-head scene at Kling's rate just because AUDIO_ENABLED=1 holds —
  // settings.model is authoritative (see pickModel's own doc comment). A
  // project that has never selected Kling (DEFAULT_RENDER_SETTINGS, i.e.
  // Seedance 2.5) must be quoted — and billed, see the "agrees with
  // pickModel" block below — at that default's rate for every scene,
  // talking-head or not, even with audio on.
  it("bills a talking-head scene at the default rate on a default (never-selected) project, even with audio enabled", () => {
    const result = estimateCost(oneSceneBrief(true, 10), true, DEFAULT_RENDER_SETTINGS);
    expect(result.totalUsd).toBeCloseTo(
      10 * priceForSecond(SEEDANCE_2_5, DEFAULT_RENDER_SETTINGS.resolution),
    );
    expect(result.talkingHeadCount).toBe(1);
  });

  // The replacement behavior: a project that has explicitly selected Kling
  // bills its eligible (talking-head, audio-on) scene at Kling's SOUND
  // rate — a genuinely different measured number (27 cr/s), not a
  // multiplier applied to the silent one (18 cr/s). kie bills exactly the
  // seconds requested, so this is a plain rate * duration.
  it("bills a talking-head scene at Kling's sound rate once the project has selected it", () => {
    const settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, model: KLING_3_PRO.id };
    const result = estimateCost(oneSceneBrief(true, 10), true, settings);
    expect(result.totalUsd).toBeCloseTo(10 * priceForSecond(KLING_3_PRO, "1080p", true));
    expect(result.totalUsd).toBeCloseTo(1.35);
    expect(result.talkingHeadCount).toBe(1);
  });

  // THE RESOLUTION RULE, pinned directly: settings.resolution when Kling's
  // own descriptor lists it, else Kling's default (billingResolution, same
  // shape as the worker's standardModel containsString check). This is what
  // replaced the old unconditional "Kling always prices at its
  // defaultResolution" — which was harmless while Kling had one tier and
  // would have gone silently wrong the moment kie's std mode (720p, 20
  // cr/s) gave it a second, cheaper one: a /ugc project saved at 720p would
  // have priced, and rendered, at pro/1080p's 27 regardless of what was
  // stored — caught in review, never shipped.
  it("prices a Kling scene with settings.resolution 720p at the std 20 cr/s rate, not pro's 27", () => {
    const settings: RenderSettings = {
      ...DEFAULT_RENDER_SETTINGS,
      model: KLING_3_PRO.id,
      resolution: "720p",
    };
    const result = estimateCost(oneSceneBrief(true, 10), true, settings);
    expect(result.totalUsd).toBeCloseTo(10 * priceForSecond(KLING_3_PRO, "720p", true));
    expect(result.totalUsd).toBeCloseTo(1.0, 5);
  });

  // The other half of the std/720p receipt pair, pinned the same explicit
  // way as the sound case above: a B-roll (non-talking-head) scene on a
  // std/720p Kling project bills the SILENT rate, 14 cr/s ($0.07/s) — the
  // rate that was missing entirely before kling-3.0-pro.silent["720p"] got
  // its own receipt (lib/kie/rates.ts), which priced every such scene at
  // +Infinity.
  it("prices a non-talking-head Kling scene at std/720p's silent 14 cr/s rate", () => {
    const settings: RenderSettings = {
      ...DEFAULT_RENDER_SETTINGS,
      model: KLING_3_PRO.id,
      resolution: "720p",
    };
    const result = estimateCost(oneSceneBrief(false, 10), true, settings);
    expect(result.totalUsd).toBeCloseTo(10 * priceForSecond(KLING_3_PRO, "720p", false));
    expect(result.totalUsd).toBeCloseTo(0.7, 5);
  });

  it("still prices a Kling scene at pro/1080p when settings.resolution names a tier Kling doesn't have", () => {
    // "480p" is a real Seedance tier, not a Kling one — a scripted project
    // could carry it on a scene override from before the project switched to
    // Kling (mergeRenderSettings, 0045). Kling has no 480p rate at all, so
    // this must fall back to its own default (pro/1080p, 27 cr/s) exactly as
    // it did before Kling had a second tier — never +Infinity, and never a
    // silent guess at std's cheaper number.
    const settings: RenderSettings = {
      ...DEFAULT_RENDER_SETTINGS,
      model: KLING_3_PRO.id,
      resolution: "480p",
    };
    const result = estimateCost(oneSceneBrief(true, 10), true, settings);
    expect(result.totalUsd).toBeCloseTo(10 * priceForSecond(KLING_3_PRO, "1080p", true));
    expect(result.totalUsd).toBeCloseTo(1.35, 5);
  });

  it("sums a mixed batch of silent and talking-head scenes on a default project — both at the default's rate", () => {
    const brief: EstimatableBrief = {
      character: "Test Character",
      scenes: [
        { script_line: "a", video_prompt: "a", is_talking_head: false, duration_s: 6 },
        { script_line: "b", video_prompt: "b", is_talking_head: true, duration_s: 10 },
      ],
    };
    const result = estimateCost(brief, true, DEFAULT_RENDER_SETTINGS);
    // Neither scene routes to Kling on a project that never selected it —
    // both bill at the default's one silent rate.
    const silentRate = priceForSecond(SEEDANCE_2_5, DEFAULT_RENDER_SETTINGS.resolution);
    expect(result.totalUsd).toBeCloseTo(6 * silentRate + 10 * silentRate);
    expect(result.talkingHeadCount).toBe(1);
    expect(result.silentCount).toBe(1);
  });

  it("sums a mixed batch of silent and talking-head scenes once the project selects Kling", () => {
    const settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, model: KLING_3_PRO.id };
    const brief: EstimatableBrief = {
      character: "Test Character",
      scenes: [
        { script_line: "a", video_prompt: "a", is_talking_head: false, duration_s: 6 },
        { script_line: "b", video_prompt: "b", is_talking_head: true, duration_s: 10 },
      ],
    };
    const result = estimateCost(brief, true, settings);
    // BOTH scenes are on Kling now. The silent one used to fall back to
    // SEEDANCE_2_5 "because Kling being selected does not make every scene
    // expensive" — which had it backwards: silent Kling is 18 credits a
    // second at 1080p where SEEDANCE_2_5 is 63 at 720p, so the fallback was
    // the expensive branch.
    //
    // What still varies per scene is the sound, and kie prices that as a
    // genuinely different rate (18 cr/s silent, 27 with) rather than a
    // multiplier.
    const silent = clipCostUsd(KLING_3_PRO, {
      resolution: KLING_3_PRO.defaultResolution,
      durationS: 6,
      audioOn: false,
    });
    const spoken = clipCostUsd(KLING_3_PRO, {
      resolution: KLING_3_PRO.defaultResolution,
      durationS: 10,
      audioOn: true,
    });
    expect(result.totalUsd).toBeCloseTo(silent + spoken);

    // Sound costs more per second — the asymmetry this whole change rests
    // on, so it is asserted rather than assumed.
    expect(spoken / 10).toBeGreaterThan(silent / 6);
    expect(result.talkingHeadCount).toBe(1);
    expect(result.silentCount).toBe(1);
  });

  // The test the audit asked for by name: estimateCost must never bill a
  // scene at a rate other than the one pickModel() — the same routing
  // function lib/enqueue-guard.ts's assertRenderableDurations validates a
  // scene against — says it actually routes to. Parametrized over every
  // isTalkingHead x audioEnabled combination and a couple of resolutions,
  // and computes the expected rate FROM pickModel's own return value each
  // time rather than hardcoding a model by name.
  describe("agrees with pickModel on every scene", () => {
    const settingsVariants: RenderSettings[] = [
      DEFAULT_RENDER_SETTINGS,
      { ...DEFAULT_RENDER_SETTINGS, resolution: "1080p" },
      {
        model: KLING_3_PRO.id,
        resolution: KLING_3_PRO.defaultResolution,
        fps: KLING_3_PRO.defaultFps,
      },
      // Kling's OTHER tier — added 2026-09-10 alongside kie's std mode.
      // Without this variant, every case above happened to already carry
      // settings.resolution === KLING_3_PRO.defaultResolution, so the old
      // "Kling always prices at its default" logic and the current
      // billingResolution rule could never be told apart by this loop.
      {
        model: KLING_3_PRO.id,
        resolution: "720p",
        fps: KLING_3_PRO.defaultFps,
      },
    ];
    const durationS = 10;

    for (const isTalkingHead of [true, false]) {
      for (const audioEnabled of [true, false]) {
        for (const settings of settingsVariants) {
          it(`isTalkingHead=${isTalkingHead} audioEnabled=${audioEnabled} resolution=${settings.resolution}`, () => {
            const routedModel = pickModel(isTalkingHead, audioEnabled, settings);
            // billingResolution: settings.resolution when routedModel lists
            // it, else its own default — the same rule estimateCost itself
            // applies (see that module's own comment).
            const resolution = billingResolution(routedModel, settings.resolution);
            const audioOn = renderAudioOn(routedModel, isTalkingHead, audioEnabled);
            const expectedRate = priceForSecond(routedModel, resolution, audioOn);

            const result = estimateCost(
              oneSceneBrief(isTalkingHead, durationS),
              audioEnabled,
              settings,
            );

            expect(result.totalUsd).toBeCloseTo(durationS * expectedRate);
          });
        }
      }
    }
  });

  // This used to pin the opposite: a Kling project's non-talking-head scene
  // was substituted to SEEDANCE_2_5, and estimateCost had to price off the
  // substitution rather than off getModel(settings.model).
  //
  // The substitution is gone. It rested on the premise that Kling bills a
  // flat rate whether or not a clip has sound, which kie's own billing
  // disproved on 2026-08-31 — 18 credits a second silent against 27 with
  // sound. Silent Kling at 1080p is $0.09/s where SEEDANCE_2_5 is $0.315/s
  // at 720p, so the fallback was moving every B-roll scene of a Kling
  // project onto a model 3.5x dearer at a lower-value tier.
  //
  // What estimateCost still must do is price off pickModel's answer rather
  // than its own copy of the routing rule — which is why routedModel is read
  // from pickModel here instead of being asserted as a literal.
  it("keeps Kling on a non-talking-head scene now that silent Kling is the cheaper route", () => {
    const settingsNamingKling: RenderSettings = {
      ...DEFAULT_RENDER_SETTINGS,
      model: KLING_3_PRO.id,
    };
    const result = estimateCost(oneSceneBrief(false, 10), false, settingsNamingKling);
    const routedModel = pickModel(false, false, settingsNamingKling);
    expect(routedModel).toBe(KLING_3_PRO);

    // Silent, because the scene is not talking-head — so this is the 18 cr/s
    // rate, not the 27. Priced at Kling's OWN resolution: settings.resolution
    // belongs to the silent model and never reaches Kling, which renders
    // 1080p regardless.
    expect(result.totalUsd).toBeCloseTo(
      clipCostUsd(KLING_3_PRO, {
        resolution: KLING_3_PRO.defaultResolution,
        durationS: 10,
        audioOn: false,
      }),
    );

    // The whole point of removing the fallback: this is cheaper than where
    // the scene used to be sent. If that ever stops being true the routing
    // decision is wrong, and this fails before any operator is overcharged.
    expect(result.totalUsd).toBeLessThan(
      clipCostUsd(SEEDANCE_2_5, {
        resolution: settingsNamingKling.resolution,
        durationS: 10,
        audioOn: false,
      }),
    );
  });

  // getModel's own fallback (VIDEO_MODELS has no unknown-id tier to
  // "disable" any more — see lib/models.ts's file header) — a settings row
  // naming a model that no longer exists (a hand-written SQL update, or a
  // model this app used to offer and has since removed) must still price
  // at the default rather than throwing.
  it("prices off the default model when settings.model names an id VIDEO_MODELS no longer recognises", () => {
    const settingsWithRemovedModel: RenderSettings = {
      ...DEFAULT_RENDER_SETTINGS,
      model: "some-removed-model",
    };
    const result = estimateCost(oneSceneBrief(false, 10), false, settingsWithRemovedModel);
    const routedModel = pickModel(false, false, settingsWithRemovedModel);
    expect(routedModel).toBe(SEEDANCE_2_5); // pins the unknown-id fallback
    expect(result.totalUsd).toBeCloseTo(
      10 * priceForSecond(SEEDANCE_2_5, settingsWithRemovedModel.resolution),
    );
  });
});

// ---------------------------------------------------------------------------
// PRICING ASKS WHAT WE ACTUALLY SEND.
//
// Every Seedance render sets generate_audio true, but the estimate picked its
// rate table with renderAudioOn — `model.nativeAudio && ...`, true only for
// Kling — so it priced every Seedance from the silent table. Invisible while
// seedance-2.5 carried 28 cr/s in both; fatal once 2.0 and 2.0 Fast arrived
// priced only under sound, where the lookup found nothing, priceForSecond
// returned +Infinity and the operator was told the kie account needed funding.
//
// The two halves pinned here are the fix and its blast radius: 480p prices,
// and 720p/1080p quote exactly what they quoted before.
// ---------------------------------------------------------------------------
describe("estimateCost prices the render this product actually makes", () => {
  const scene = {
    script_line: "",
    video_prompt: "",
    is_talking_head: false,
    duration_s: 4,
  };
  const brief = { character: "", scenes: [scene] };

  it("prices Seedance 2.0 and 2.0 Fast at 480p instead of refusing them", () => {
    for (const [model, creditsPerSecond] of [
      ["seedance-2", 19],
      ["seedance-2-fast", 11.7],
    ] as const) {
      const { totalUsd } = estimateCost(brief, true, {
        model,
        resolution: "480p",
        fps: 24,
      });
      expect(Number.isFinite(totalUsd), `${model} at 480p is still unpriceable`).toBe(true);
      expect(totalUsd).toBeCloseTo((creditsPerSecond * 4) / 200, 5);
    }
  });

  it("quotes Seedance 2.5 from kie's current published price at every tier", () => {
    // 28/63/158 cr/s, and 200 credits to the dollar. 480p now resolves through
    // the sound table and 720p/1080p still through silent — the point is that
    // the operator-visible number did not move at any of them.
    for (const [resolution, creditsPerSecond] of [
      ["480p", 28],
      ["720p", 63],
      ["1080p", 158],
    ] as const) {
      const { totalUsd } = estimateCost(brief, true, {
        model: "seedance-2.5",
        resolution,
        fps: 24,
      });
      expect(totalUsd, `seedance-2.5 at ${resolution} changed price`).toBeCloseTo(
        (creditsPerSecond * 4) / 200,
        5,
      );
    }
  });

  it("still quotes silent Kling at the silent rate, not the spoken one", () => {
    // The one model where sound is genuinely optional and priced differently
    // (18 vs 27 cr/s). A blanket "price everything with sound" would have
    // quietly overcharged every silent cutaway.
    const { totalUsd } = estimateCost(brief, true, {
      model: "kling-3.0-pro",
      resolution: "1080p",
      fps: 24,
    });
    expect(totalUsd).toBeCloseTo((18 * 4) / 200, 5);
  });
});

// ---------------------------------------------------------------------------
// THE MONEY SEAM: kie prices a render carrying a video reference at
// Price x (Input + Output), not Price x Output alone (lib/kie/rates.ts's
// VIDEO_INPUT_PRICING). estimateCost is where a scene's videoReferenceDurationsS
// (assets.duration_s for every element it tags) turns into the extra seconds
// clipCostUsd bills for — see that function's own comment in ./models for the
// other half of this formula.
//
// THE FIRST TEST BELOW IS THE IMPORTANT ONE, per the task this file was
// written against: most renders carry no video reference at all, so a
// brief that never mentions videoReferenceDurationsS — every test above this
// point, unmodified — must keep quoting exactly what it quoted before this
// field existed.
// ---------------------------------------------------------------------------
describe("estimateCost prices a scene's attached video references", () => {
  const settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, resolution: "720p" };
  const silentRate = priceForSecond(SEEDANCE_2_5, "720p");

  it("is unaffected by an ABSENT videoReferenceDurationsS — the regression this task's brief named by hand", () => {
    // oneSceneBrief (used by every test above this describe block) never
    // sets this field at all, and every one of those tests already passed
    // before this field existed — this test exists only to say so in one
    // place, aimed straight at the field this task added.
    const result = estimateCost(oneSceneBrief(false, 8), false, settings);
    expect(result.totalUsd).toBeCloseTo(8 * silentRate);
  });

  it("is unaffected by an EMPTY videoReferenceDurationsS — same number as absent, not a different zero", () => {
    const brief: EstimatableBrief = {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: "",
          is_talking_head: false,
          duration_s: 8,
          videoReferenceDurationsS: [],
        },
      ],
    };
    const result = estimateCost(brief, false, settings);
    expect(result.totalUsd).toBeCloseTo(8 * silentRate);
  });

  // THESE TWO USED TO ASSERT THE SAME PER-SECOND RATE over more seconds,
  // which is what kie's page implies and what this file believed until
  // 2026-09-10. Two real receipts say otherwise: attaching a video moves
  // seedance-2.5 480p from 28 cr/s to 17 — DOWNWARD — and 17 x (4 + output)
  // reproduces both bills to the credit. The published formula's shape
  // survived; its price did not. See lib/kie/rates.ts's `video` table.
  //
  // The 720p video-input rate is published, and published prices are sold.
  it("prices a video reference at 720p from kie's published video rate", () => {
    const brief: EstimatableBrief = {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: "",
          is_talking_head: false,
          duration_s: 8,
          videoReferenceDurationsS: [5],
        },
      ],
    };
    const result = estimateCost(brief, false, settings);
    expect(result.totalUsd).toBeCloseTo((38 * 13) / 200, 6);
  });

  it("prices a 480p video reference at the measured video rate, input floored", () => {
    const at480: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, resolution: "480p" };
    const brief: EstimatableBrief = {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: "",
          is_talking_head: false,
          duration_s: 4,
          // The exact file both receipts carried.
          videoReferenceDurationsS: [4.064],
        },
      ],
    };
    const result = estimateCost(brief, false, at480);
    // THE PRODUCTION RECEIPT, to the cent: task b0e0a5e8, 136 credits.
    expect(result.totalUsd).toBeCloseTo(0.68, 6);
  });

  it("reproduces the 8s receipt too, which is what fixed the rate", () => {
    // One receipt gives a point; two give the line. The 4s bill alone is
    // equally consistent with a flat surcharge, and this is the sample that
    // ruled the naive readings out.
    const at480: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, resolution: "480p" };
    const brief: EstimatableBrief = {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: "",
          is_talking_head: false,
          duration_s: 8,
          videoReferenceDurationsS: [4.064],
        },
      ],
    };
    const result = estimateCost(brief, false, at480);
    // Task 49426148, 204 credits.
    expect(result.totalUsd).toBeCloseTo(1.02, 6);
  });

  it("sums more than one video reference's duration into the input side", () => {
    const at480: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, resolution: "480p" };
    const brief: EstimatableBrief = {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: "",
          is_talking_head: false,
          duration_s: 6,
          // @new_video1 and @new_video2, both tagged into the same scene.
          videoReferenceDurationsS: [3, 4],
        },
      ],
    };
    const result = estimateCost(brief, false, at480);
    // 17 cr/s x (6 + 3 + 4) seconds / 200 credits per USD.
    expect(result.totalUsd).toBeCloseTo((17 * 13) / 200, 6);
  });

  // THE OVER-QUOTE FALLBACK. A null entry is how an unmeasured upload is
  // spelled (assets.duration_s the operator's browser could not decode —
  // components/ugc-reference-picker.tsx's videoDurationSeconds returns null
  // in exactly that case), and the safe direction for a number the spend
  // cap will be checked against is to over-quote without limit, never to
  // guess a finite one that could under-quote the real bill.
  it("over-quotes to +Infinity when a video reference's duration is unknown", () => {
    const brief: EstimatableBrief = {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: "",
          is_talking_head: false,
          duration_s: 8,
          videoReferenceDurationsS: [null],
        },
      ],
    };
    const result = estimateCost(brief, false, settings);
    expect(result.totalUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it("over-quotes to +Infinity even when ONE of several references is unknown — a known 3s does not dilute an unknown one", () => {
    const brief: EstimatableBrief = {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: "",
          is_talking_head: false,
          duration_s: 8,
          videoReferenceDurationsS: [3, null],
        },
      ],
    };
    const result = estimateCost(brief, false, settings);
    expect(result.totalUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it("does not fold a video reference's input seconds into CostEstimate.seconds — that field is OUTPUT length only", () => {
    // seconds is read elsewhere (e.g. a progress bar) as how much CLIP this
    // batch renders; a scene tagging a 5s reference does not render 5
    // seconds more footage, it just costs more, so `seconds` must not move.
    const brief: EstimatableBrief = {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: "",
          is_talking_head: false,
          duration_s: 8,
          videoReferenceDurationsS: [5],
        },
      ],
    };
    const result = estimateCost(brief, false, settings);
    expect(result.seconds).toBe(8);
  });
});

// estimateUsdForScenes is THE number the spend caps are checked against
// (its own doc comment) — a video reference that priced correctly through
// estimateCost above but never reached this function would still let a cap
// check under-count a real render, the exact 0045 failure mode
// estimateUsdForScenes exists to close for a render-settings override.
describe("estimateUsdForScenes carries a scene's video references into the cap-check total", () => {
  const projectSettings = { ...DEFAULT_RENDER_SETTINGS, resolution: "720p" };
  const silentRate = priceForSecond(SEEDANCE_2_5, "720p");

  it("is unaffected by a scene with no videoReferenceDurationsS at all", () => {
    const scenes: OverridableScene[] = [
      { is_talking_head: false, duration_s: 8, render_settings_override: null },
    ];
    expect(estimateUsdForScenes(scenes, false, projectSettings)).toBeCloseTo(8 * silentRate);
  });

  it("carries a video reference into the cap-check total, priced the same way estimateCost prices it", () => {
    // 480p, because that is where the receipts are — projectSettings above
    // is 720p, which has no video rate and would refuse. THE POINT OF THIS
    // TEST is the path, not the number: a video priced correctly through
    // estimateCost but never reaching estimateUsdForScenes would let a cap
    // clear against an output-only figure, which is exactly the hole this
    // whole change closes.
    const at480 = { ...DEFAULT_RENDER_SETTINGS, resolution: "480p" };
    const scenes: OverridableScene[] = [
      {
        is_talking_head: false,
        duration_s: 4,
        render_settings_override: null,
        videoReferenceDurationsS: [4.064],
      },
    ];
    expect(estimateUsdForScenes(scenes, false, at480)).toBeCloseTo(0.68, 6);
  });

  it("prices a 720p video reference from kie's published video rate", () => {
    const scenes: OverridableScene[] = [
      {
        is_talking_head: false,
        duration_s: 8,
        render_settings_override: null,
        videoReferenceDurationsS: [5],
      },
    ];
    expect(estimateUsdForScenes(scenes, false, projectSettings)).toBeCloseTo((38 * 13) / 200, 6);
  });
});
