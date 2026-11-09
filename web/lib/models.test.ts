import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_ASPECT_RATIOS } from "./image-aspect-ratios";
import {
  CLAUDE_HAIKU_4_5,
  CLAUDE_OPUS_5,
  CLAUDE_SONNET_5,
  COMPILER_MODELS,
  CompilerModelIdSchema,
  DEFAULT_COMPILER_MODEL_ID,
  DEFAULT_RENDER_SETTINGS,
  GPT_5,
  HAILUO_2_3_PRO,
  KLING_3_PRO,
  KLING_4,
  RenderSettingsSchema,
  SEEDANCE_2_5,
  UNIVERSAL_DURATIONS_S,
  VIDEO_MODELS,
  IMAGE_MODELS,
  blocksInline,
  type ImageModelDescriptor,
  kieIdForImageModel,
  applySceneCostUsd,
  computeUniversalDurationsS,
  clipCostUsd,
  isFpsAllowedForDuration,
  isPriceEstimated,
  isVideoInputPricingEstimated,
  maxDurationForFps,
  renderAudioOn,
  compileCostUsd,
  defaultCompilerModelId,
  getCompilerModel,
  getModel,
  parseCompilerModel,
  mergeRenderSettings,
  parseRenderSettings,
  pickModel,
  priceForSecond,
  renderSettingsSchemaFor,
} from "./models";
import { KIE_MODELS } from "@/lib/kie/models";
import { SEEDREAM_PRO_ID } from "./seedream";

describe("priceForSecond", () => {
  // Reads straight through lib/kie/rates.ts — see that module for the
  // receipts these numbers come from. Converted to USD (credits / 200) so
  // this file and lib/kie/rates.test.ts can never quote two different
  // numbers for the same measurement.
  it("returns Seedance 2.5's measured 720p rate", () => {
    expect(priceForSecond(SEEDANCE_2_5, "720p")).toBeCloseTo(0.315);
  });

  it("returns Seedance 2.5's published (unpaid) 480p rate", () => {
    expect(priceForSecond(SEEDANCE_2_5, "480p")).toBeCloseTo(0.14);
  });

  it("returns Kling's measured silent rate", () => {
    expect(priceForSecond(KLING_3_PRO, "1080p")).toBeCloseTo(0.09);
  });

  // kie prices a talking-head second and a silent second as two genuinely
  // different measured numbers, not a base rate plus a surcharge — see
  // lib/kie/rates.ts's own header for what modelling it as a multiplier
  // cost this product once already.
  it("returns Kling's measured SOUND rate when audioOn is true — a different number, not a multiplier", () => {
    expect(priceForSecond(KLING_3_PRO, "1080p", true)).toBeCloseTo(0.135);
    expect(priceForSecond(KLING_3_PRO, "1080p", false)).toBeCloseTo(0.09);
  });

  it("returns Hailuo's measured rate", () => {
    expect(priceForSecond(HAILUO_2_3_PRO, "768P")).toBeCloseTo(0.045);
  });

  // Unknown is not free. A resolution/sound pair nobody has priced must
  // refuse every cap check and total built on it, never read as cheap —
  // the one direction this codebase does not allow a wrong number to be
  // wrong in.
  it("returns +Infinity for a resolution nobody has priced, never 0 or a neighbouring tier's rate", () => {
    expect(priceForSecond(SEEDANCE_2_5, "4K")).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns +Infinity for asking a silent-only model for its sound rate", () => {
    expect(priceForSecond(HAILUO_2_3_PRO, "768P", true)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("isPriceEstimated", () => {
  // "published" means kie's own page says so and nobody here has paid it —
  // good enough to quote, not good enough to pretend is measured.
  it("is true for Seedance 2.5 at 1080p — a published rate, not a receipt", () => {
    expect(isPriceEstimated(SEEDANCE_2_5, "1080p")).toBe(true);
  });

  it("is false for a measured (receipt) rate", () => {
    // 480p joined this list on 2026-09-02: one 4s clip billed 112 credits,
    // exactly the 28 cr/s that had until then only been published.
    expect(isPriceEstimated(SEEDANCE_2_5, "480p")).toBe(false);
    expect(isPriceEstimated(SEEDANCE_2_5, "720p")).toBe(false);
    expect(isPriceEstimated(KLING_3_PRO, "1080p")).toBe(false);
    expect(isPriceEstimated(HAILUO_2_3_PRO, "768P")).toBe(false);
  });

  // A pair with NO rate at all is refused outright by priceForSecond
  // (+Infinity) — a much louder signal than a label — so this reports
  // false rather than asserting anything about a price that doesn't exist.
  it("is false for a resolution nobody has priced at all", () => {
    expect(isPriceEstimated(SEEDANCE_2_5, "4K")).toBe(false);
  });
});

describe("clipCostUsd", () => {
  // kie bills exactly the seconds requested — no billed-seconds multiplier
  // the way fal's Kling needed one (a 6s request there was billed for 7.2
  // seconds). This is priceForSecond times durationS, nothing more.
  it("is priceForSecond times durationS, exactly", () => {
    expect(clipCostUsd(SEEDANCE_2_5, { resolution: "720p", durationS: 8 })).toBeCloseTo(8 * 0.315);
  });

  // The worked example this pricing was measured from: 15s of Kling at
  // 1080p with sound, via kie — 405 credits, $2.025.
  it("reproduces the exact receipt for a 15s spoken Kling render", () => {
    expect(
      clipCostUsd(KLING_3_PRO, { resolution: "1080p", durationS: 15, audioOn: true }),
    ).toBeCloseTo(2.025, 4);
  });

  it("defaults audioOn to false", () => {
    expect(clipCostUsd(KLING_3_PRO, { resolution: "1080p", durationS: 3 })).toBeCloseTo(0.27);
  });

  // THE MONEY SEAM referenceVideoInputSecondsS exists to close: kie prices
  // a render carrying a video reference at Price x (Input + Output), not
  // Price x Output alone (lib/kie/rates.ts's VIDEO_INPUT_PRICING). This is
  // the regression the task's own brief asked for by name — most renders
  // carry no video reference, so the default (0) must reproduce today's
  // number exactly, which is what the very first test in this describe
  // block already pins without passing the argument at all.
  it("defaults referenceVideoInputSecondsS to 0 — no video reference changes nothing", () => {
    expect(
      clipCostUsd(SEEDANCE_2_5, {
        resolution: "720p",
        durationS: 8,
        referenceVideoInputSecondsS: 0,
      }),
    ).toBeCloseTo(clipCostUsd(SEEDANCE_2_5, { resolution: "720p", durationS: 8 }));
  });

  // Published prices are sold by owner decision (2026-10-30), including the
  // 720p video-input rate of 38 cr/s.
  it("prices 720p video input from kie's published rate", () => {
    expect(
      clipCostUsd(SEEDANCE_2_5, {
        resolution: "720p",
        durationS: 8,
        referenceVideoInputSecondsS: 5,
      }),
    ).toBeCloseTo((38 * 13) / 200, 6);
  });

  it("prices a 480p video render off the two production receipts", () => {
    // 17 cr/s x (4 + 4) / 200 = $0.68, task b0e0a5e8.
    expect(
      clipCostUsd(SEEDANCE_2_5, {
        resolution: "480p",
        durationS: 4,
        referenceVideoInputSecondsS: 4.064,
      }),
    ).toBeCloseTo(0.68, 6);

    // 17 cr/s x (4 + 8) / 200 = $1.02, task 49426148. The second point is
    // what turns one bill into a line, and it is the reason this is not
    // modelled as a flat surcharge.
    expect(
      clipCostUsd(SEEDANCE_2_5, {
        resolution: "480p",
        durationS: 8,
        referenceVideoInputSecondsS: 4.064,
      }),
    ).toBeCloseTo(1.02, 6);
  });

  it("counts the input in whole seconds, which is what both receipts show", () => {
    // 4.064 and 4.9 must both bill as 4. If the input were carried at full
    // precision the 4s render would price at 137.1 credits and the real
    // bill was 136 — so this is the receipt talking, not a tidy-number
    // preference.
    const floored = clipCostUsd(SEEDANCE_2_5, {
      resolution: "480p",
      durationS: 4,
      referenceVideoInputSecondsS: 4.9,
    });
    expect(floored).toBeCloseTo(0.68, 6);
  });

  it("still prices a clip with NO video reference off the sound table", () => {
    // The overwhelming majority of renders, and the branch that must not
    // move: 28 cr/s, not 17. A change that routed everything through the
    // video table would underquote every ordinary clip by 39%.
    expect(
      clipCostUsd(SEEDANCE_2_5, { resolution: "480p", durationS: 4, audioOn: true }),
    ).toBeCloseTo(0.56, 6);
  });

  // The over-quote fallback, at the unit this formula actually lives in: an
  // unmeasured video reference must make the WHOLE clip unpriceable rather
  // than quietly using 0 extra seconds, the same "unknown is not free"
  // idiom priceForSecond already uses for a resolution/sound pair nobody
  // has a rate for.
  it("returns +Infinity when referenceVideoInputSecondsS is Infinity (an unmeasured video reference)", () => {
    expect(
      clipCostUsd(SEEDANCE_2_5, {
        resolution: "720p",
        durationS: 8,
        referenceVideoInputSecondsS: Number.POSITIVE_INFINITY,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("isVideoInputPricingEstimated", () => {
  // FALSE SINCE 2026-09-10, and the flip has receipts behind it: two
  // video-conditioned renders billed 136 and 204 credits (tasks b0e0a5e8
  // and 49426148), which is what the previous version of this test said it
  // was waiting for. The warning it carried still stands for the next
  // constant — a flip to false with nothing paid behind it is the filing
  // mistake rates.ts says cost a month of unpriced renders — so the guard
  // is kept and inverted rather than deleted.
  it("is false — MEASURED, over two real renders", () => {
    expect(isVideoInputPricingEstimated()).toBe(false);
  });
});

describe("maxDurationForFps / isFpsAllowedForDuration", () => {
  // Every current model's maxDurationSByFps is empty — LTX's old "50fps
  // only under 10s" rule left with the descriptor that carried it — so
  // this pins the "no constraint" default the mechanism falls back to
  // rather than a specific model's own limit. lib/enqueue-guard.test.ts's
  // synthetic-descriptor fixtures cover the constrained-model branch of
  // this same mechanism.
  it("returns null for an fps with no duration limit on any current model", () => {
    for (const model of VIDEO_MODELS) {
      for (const fps of model.allowedFps) {
        expect(maxDurationForFps(model, fps)).toBeNull();
      }
    }
  });

  it("allows any length at any allowed fps on every current model", () => {
    for (const model of VIDEO_MODELS) {
      for (const fps of model.allowedFps) {
        expect(isFpsAllowedForDuration(model, fps, 15)).toBe(true);
      }
    }
  });
});

describe("getModel", () => {
  it("finds a descriptor by its id", () => {
    expect(getModel("seedance-2.5")).toBe(SEEDANCE_2_5);
    expect(getModel("kling-3.0-pro")).toBe(KLING_3_PRO);
    expect(getModel("hailuo-2.3-pro")).toBe(HAILUO_2_3_PRO);
  });

  // A hand-written SQL update can put anything into render_settings.model —
  // this must degrade to the default model, not throw or return undefined.
  it("falls back to the default model for an unknown id", () => {
    expect(getModel("some-removed-model")).toBe(SEEDANCE_2_5);
  });

  it("falls back to the default model for null", () => {
    expect(getModel(null)).toBe(SEEDANCE_2_5);
  });

  it("falls back to the default model for undefined", () => {
    expect(getModel(undefined)).toBe(SEEDANCE_2_5);
  });
});

describe("RenderSettingsSchema", () => {
  it("accepts the default model (Seedance 2.5) at its default settings", () => {
    const result = RenderSettingsSchema.safeParse({
      model: SEEDANCE_2_5.id,
      resolution: SEEDANCE_2_5.defaultResolution,
      fps: SEEDANCE_2_5.defaultFps,
    });
    expect(result.success).toBe(true);
  });

  // Every current model is unconditionally selectable — there is no more
  // "disabled pending verification" tier (see lib/models.ts's file header)
  // — so all three must be accepted at their own defaults.
  it("accepts every current model at its own defaults", () => {
    for (const model of VIDEO_MODELS) {
      const result = RenderSettingsSchema.safeParse({
        model: model.id,
        resolution: model.defaultResolution,
        fps: model.defaultFps,
      });
      expect(result.success, `${model.id} was rejected at its own defaults`).toBe(true);
    }
  });

  it("rejects a removed model id, like fal's old LTX descriptor", () => {
    const result = RenderSettingsSchema.safeParse({
      model: "ltx-2.3-fast",
      resolution: "1080p",
      fps: 24,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown resolution for the selected model", () => {
    const result = RenderSettingsSchema.safeParse({
      model: SEEDANCE_2_5.id,
      resolution: "2160p",
      fps: 24,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an fps the selected model does not allow", () => {
    const result = RenderSettingsSchema.safeParse({
      model: SEEDANCE_2_5.id,
      resolution: "720p",
      fps: 30,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown model id outright", () => {
    const result = RenderSettingsSchema.safeParse({
      model: "does-not-exist",
      resolution: "1080p",
      fps: 24,
    });
    expect(result.success).toBe(false);
  });
});

describe("renderSettingsSchemaFor", () => {
  // Every current model's maxDurationSByFps/maxDurationSByResolution is
  // empty, so the cross-field branch is presently a no-op — this pins that
  // the MODEL check still runs and still refuses a removed id regardless
  // of the fps/duration combination. The cross-field mechanism itself is
  // exercised generically in lib/enqueue-guard.test.ts against a synthetic
  // constrained descriptor.
  it("rejects an unknown model regardless of fps validity — the model check runs first", () => {
    const schema = renderSettingsSchemaFor(12);
    const result = schema.safeParse({ model: "ltx-2.3-fast", resolution: "1080p", fps: 50 });
    expect(result.success).toBe(false);
  });

  // 0 means "no scenes yet" (a brand-new project) — must not accidentally
  // forbid every fps, since enqueueRender is what refuses an empty project,
  // not this schema.
  it("allows every fps when longestSceneS is 0", () => {
    const schema = renderSettingsSchemaFor(0);
    for (const fps of SEEDANCE_2_5.allowedFps) {
      const result = schema.safeParse({
        model: SEEDANCE_2_5.id,
        resolution: SEEDANCE_2_5.defaultResolution,
        fps,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("parseRenderSettings", () => {
  // This runs on every page load against a jsonb column a direct SQL write
  // can put anything into — it must never throw, only degrade to defaults.
  it("returns the full defaults for null", () => {
    expect(parseRenderSettings(null)).toEqual(DEFAULT_RENDER_SETTINGS);
  });

  it("returns the full defaults for undefined", () => {
    expect(parseRenderSettings(undefined)).toEqual(DEFAULT_RENDER_SETTINGS);
  });

  it("returns the full defaults for an empty object", () => {
    expect(parseRenderSettings({})).toEqual(DEFAULT_RENDER_SETTINGS);
  });

  it("returns the full defaults for garbage input", () => {
    expect(parseRenderSettings("not an object")).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(parseRenderSettings(42)).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(parseRenderSettings([1, 2, 3])).toEqual(DEFAULT_RENDER_SETTINGS);
  });

  // A field-by-field blob: resolution/fps that don't belong to the given
  // model must fall back to that model's own defaults, not throw or mix
  // resolutions across models.
  it("falls back per-field when resolution or fps is invalid for the chosen model", () => {
    const result = parseRenderSettings({ model: "kling-3.0-pro", resolution: "4k", fps: 999 });
    expect(result).toEqual({
      model: "kling-3.0-pro",
      resolution: KLING_3_PRO.defaultResolution,
      fps: KLING_3_PRO.defaultFps,
    });
  });

  it("passes through a fully valid blob unchanged", () => {
    const result = parseRenderSettings({ model: "seedance-2.5", resolution: "1080p", fps: 24 });
    expect(result).toEqual({ model: "seedance-2.5", resolution: "1080p", fps: 24 });
  });

  // Reads are lenient by design — an id already in storage that VIDEO_MODELS
  // no longer recognises must degrade to the default, same as getModel's
  // own fallback, rather than throwing or silently rewriting history.
  it("degrades to the default model for an id already in storage that no longer exists", () => {
    const result = parseRenderSettings({
      model: "some-removed-model",
      resolution: "1080p",
      fps: 24,
    });
    expect(result.model).toBe(SEEDANCE_2_5.id);
  });

  // CASE-INSENSITIVE, resolving to the descriptor's OWN spelling — mirrors
  // worker/internal/kie/models.go's canonicalResolution/EqualFold. Pins the
  // two legacy shapes that actually reach this column: Seedance's
  // resolutions were stored uppercase ("480P"/"720P") until commit 4ac10aa
  // lowercased them, and Kling's allowedResolutions gained "720p" alongside
  // "1080p" on 2026-09-10. Before this, the web side matched CASE-SENSITIVELY
  // (Array.includes), so a stored "720P" fell back to the model's default
  // instead of resolving to "720p" the way the worker's read path already did.
  it("resolves a legacy uppercase resolution to the descriptor's own lowercase spelling", () => {
    expect(parseRenderSettings({ model: "kling-3.0-pro", resolution: "720P" }).resolution).toBe(
      "720p",
    );
    expect(parseRenderSettings({ model: "seedance-2.5", resolution: "720P" }).resolution).toBe(
      "720p",
    );
  });

  it("resolves Kling's own settings", () => {
    const result = parseRenderSettings({
      model: KLING_3_PRO.id,
      resolution: KLING_3_PRO.defaultResolution,
      fps: KLING_3_PRO.defaultFps,
    });
    expect(result).toEqual({
      model: KLING_3_PRO.id,
      resolution: KLING_3_PRO.defaultResolution,
      fps: KLING_3_PRO.defaultFps,
    });
  });
});

describe("pickModel", () => {
  // settings.model is authoritative, full stop — there is no more
  // substitution branch to take (see pickModel's own doc comment): every
  // id VIDEO_MODELS recognises is unconditionally selectable, and an
  // unrecognised one falls back via getModel the same way any other read
  // of the column does. isTalkingHead/audioEnabled no longer influence
  // WHICH descriptor is returned — only renderAudioOn, below, reads them.
  it("returns the default (Seedance 2.5) for a project that has never touched render_settings, regardless of isTalkingHead/audioEnabled", () => {
    expect(pickModel(false, false, DEFAULT_RENDER_SETTINGS)).toBe(SEEDANCE_2_5);
    expect(pickModel(false, true, DEFAULT_RENDER_SETTINGS)).toBe(SEEDANCE_2_5);
    expect(pickModel(true, false, DEFAULT_RENDER_SETTINGS)).toBe(SEEDANCE_2_5);
    expect(pickModel(true, true, DEFAULT_RENDER_SETTINGS)).toBe(SEEDANCE_2_5);
  });

  it("returns whichever model settings.model names", () => {
    expect(pickModel(true, true, { model: KLING_3_PRO.id })).toBe(KLING_3_PRO);
    expect(pickModel(false, false, { model: HAILUO_2_3_PRO.id })).toBe(HAILUO_2_3_PRO);
  });

  it("falls back to the default for an unknown id, regardless of isTalkingHead/audioEnabled", () => {
    expect(pickModel(false, false, { model: "some-removed-model" })).toBe(SEEDANCE_2_5);
    expect(pickModel(true, true, { model: "some-removed-model" })).toBe(SEEDANCE_2_5);
  });
});

describe("renderAudioOn", () => {
  // Only a nativeAudio model (Kling) can produce sound, and only for a
  // talking-head scene, and only when the account has audio on. Every
  // other combination is silent.
  it("is true only for Kling, talking-head, audio enabled", () => {
    expect(renderAudioOn(KLING_3_PRO, true, true)).toBe(true);
  });

  it("is false for Kling when the scene is not talking-head", () => {
    expect(renderAudioOn(KLING_3_PRO, false, true)).toBe(false);
  });

  it("is false for Kling when audio is disabled account-wide", () => {
    expect(renderAudioOn(KLING_3_PRO, true, false)).toBe(false);
  });

  it("is always false for a non-native-audio model, even talking-head with audio on", () => {
    expect(renderAudioOn(SEEDANCE_2_5, true, true)).toBe(false);
    expect(renderAudioOn(HAILUO_2_3_PRO, true, true)).toBe(false);
  });
});

describe("VIDEO_MODELS invariants", () => {
  // READ FROM KIE_MODELS, NOT COPIED FROM IT, and that distinction is the
  // whole reason this drifted.
  //
  // This test's own title said "in KIE_MODELS' order" while asserting a
  // hardcoded literal of three ids. So when Seedance 2.0 and 2.0 Fast were
  // added to KIE_MODELS, it stayed green — it was never comparing the two
  // lists, only restating one of them. A guard that names the thing it is
  // guarding against and does not read it is worse than no guard: it is
  // reported as coverage.
  //
  // What that cost: offerable() reads KIE_MODELS and accepted the operator's
  // choice of Seedance 2.0, then getModel() searched this table, did not find
  // it, and returned SEEDANCE_2_5 — its documented fallback. The scene was
  // written as seedance-2.5 and rendered at 28 credits/s under a button that
  // had quoted 19. Gemini is the explicit UGC-only exception: the generic
  // scripted picker must not expose its job-price model.
  it("names every generic model, in order, and excludes UGC-only Gemini", () => {
    expect(
      VIDEO_MODELS.map((m) => m.id),
      "a model in one list and not the other resolves through getModel's fallback and renders as something else",
    ).toEqual(KIE_MODELS.filter((m) => m.id !== "gemini-omni-video").map((m) => m.id));
    expect(VIDEO_MODELS.some((m) => m.id === "gemini-omni-video")).toBe(false);
  });

  it("every model's defaultFps is in its own allowedFps", () => {
    for (const model of VIDEO_MODELS) {
      expect(model.allowedFps.includes(model.defaultFps)).toBe(true);
    }
  });

  it("every model's defaultResolution is in its own allowedResolutions", () => {
    for (const model of VIDEO_MODELS) {
      expect(model.allowedResolutions.includes(model.defaultResolution)).toBe(true);
    }
  });

  // Every model this app offers must be priced at every resolution it
  // allows — an offered pair with no rate resolves to priceForSecond's
  // +Infinity refusal, which is correct but means the render gate is showing
  // a choice it cannot price.
  //
  // IN EITHER DIRECTION, not silent specifically. This asked for a silent
  // rate on every model, which held only while every model happened to have
  // one. Seedance 2.0 and 2.0 Fast have no silent rate at all, deliberately:
  // nothing has ever been rendered on them that way, and copying the sound
  // number across would assert that audio is free — which kie's own docs
  // deny and lib/kie/cost.test.ts refuses.
  //
  // Loosened to "priced somehow" rather than dropped, because the thing worth
  // guarding is that no offered pair is unpriceable. Which of the two
  // directions a given pair must have is offerable()'s question, and
  // lib/kie/offerable-reality.test.ts is where it is asked.
  it("every allowed resolution on every model has a real price in some direction", () => {
    for (const model of VIDEO_MODELS) {
      for (const resolution of model.allowedResolutions) {
        const priced =
          Number.isFinite(priceForSecond(model, resolution)) ||
          Number.isFinite(priceForSecond(model, resolution, true));
        expect(priced, `${model.id} at ${resolution} has no rate in either direction`).toBe(true);
      }
    }
  });

  // nativeAudio means "Kling-family" everywhere (start/end frames, @tags
  // refused, is_talking_head picks the tier) — mirroring
  // worker/internal/kie/models.go's Descriptor.NativeAudio, which is true
  // only for the two Klings there too.
  it("only the Kling models are nativeAudio", () => {
    const nativeAudioModels = VIDEO_MODELS.filter((model) => model.nativeAudio);
    expect(nativeAudioModels).toEqual([KLING_3_PRO, KLING_4]);
  });

  // Stronger than "priced somehow" above, and only for nativeAudio: a
  // nativeAudio model renders BOTH ways — silent for a B-roll
  // (non-talking-head) scene, with sound for a talking-head one — at
  // WHATEVER AllowedResolution the settings actually name (billingResolution
  // honours it, not just defaultResolution). A tier with only one direction
  // priced is +Infinity the moment a scene needs the other. Mirrors
  // worker/internal/kie/models_test.go's TestRatesCoverAllowedResolutions,
  // widened the same way and for the same reason: Kling's std/720p shipped
  // with a sound rate but no silent one, pricing every B-roll scene on a
  // std/720p project at +Infinity.
  it("every allowed resolution on a nativeAudio model is priced BOTH silent and with sound", () => {
    for (const model of VIDEO_MODELS) {
      if (!model.nativeAudio) continue;
      for (const resolution of model.allowedResolutions) {
        expect(
          Number.isFinite(priceForSecond(model, resolution, false)),
          `${model.id} at ${resolution} has no SILENT rate — a B-roll (non-talking-head) scene at this tier prices at +Infinity`,
        ).toBe(true);
        expect(
          Number.isFinite(priceForSecond(model, resolution, true)),
          `${model.id} at ${resolution} has no SOUND rate — a talking-head scene at this tier prices at +Infinity`,
        ).toBe(true);
      }
    }
  });
});

describe("compiler model descriptors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A project that has never touched render_settings — the {} / null /
  // undefined shapes parseRenderSettings's own suite already covers for
  // the video half of the column.
  it("a project with no compiler setting compiles on Haiku", () => {
    expect(parseCompilerModel(null)).toBe(CLAUDE_HAIKU_4_5);
    expect(parseCompilerModel(undefined)).toBe(CLAUDE_HAIKU_4_5);
    expect(parseCompilerModel({})).toBe(CLAUDE_HAIKU_4_5);
    expect(DEFAULT_COMPILER_MODEL_ID).toBe(CLAUDE_HAIKU_4_5.id);
  });

  // Selecting Sonnet routes compileBrief's `model` argument to Sonnet AND
  // quotes Sonnet's own price — the same object backs both, so they can
  // never read two different numbers.
  it("selecting Sonnet routes to Sonnet and quotes Sonnet's price", () => {
    const resolved = parseCompilerModel({ compileModel: CLAUDE_SONNET_5.id });
    expect(resolved).toBe(CLAUDE_SONNET_5);
    expect(resolved.id).toBe("claude-sonnet-5");
    expect(compileCostUsd(resolved)).toBe(CLAUDE_SONNET_5.costUsd);
    expect(resolved.costUsd).toBeGreaterThan(CLAUDE_HAIKU_4_5.costUsd);
  });

  // The estimate quoted to the operator and the price the spend cap enforces
  // are the same call site in actions/compile.ts (both read
  // compilerModel.costUsd off the object this function returns) — pinned
  // here as a value-level guarantee: compileCostUsd never disagrees with
  // the descriptor's own field for any model in the table.
  it("compileCostUsd always agrees with the descriptor it was given", () => {
    for (const model of COMPILER_MODELS) {
      expect(compileCostUsd(model)).toBe(model.costUsd);
    }
  });

  // applySceneCostUsd (actions/brief.ts's Apply/Split) is derived from the
  // same compileCostUsd a full compile is priced at, preserving the 4x
  // ratio CLAUDE_HAIKU_4_5.costUsd's own doc comment states between a
  // whole-script compile and one compileScene() call — not a second,
  // independently hand-picked number per model.
  it("applySceneCostUsd derives from compileCostUsd at a flat 4x ratio, reproducing Haiku's old flat $0.01", () => {
    expect(applySceneCostUsd(CLAUDE_HAIKU_4_5)).toBeCloseTo(0.01, 10);
    expect(applySceneCostUsd(CLAUDE_SONNET_5)).toBeCloseTo(CLAUDE_SONNET_5.costUsd / 4, 10);
    for (const model of COMPILER_MODELS) {
      expect(applySceneCostUsd(model)).toBeCloseTo(compileCostUsd(model) / 4, 10);
    }
    // Sonnet costs 3x Haiku's compile rate, so it must cost 3x Haiku's
    // Apply/Split rate too — the whole point of deriving rather than
    // flattening.
    expect(applySceneCostUsd(CLAUDE_SONNET_5)).toBeCloseTo(
      applySceneCostUsd(CLAUDE_HAIKU_4_5) * 3,
      10,
    );
  });

  // render_settings.compileModel naming a disabled descriptor directly
  // (only reachable via a hand-written SQL update — no CHECK constraint)
  // must never become selectable through the back door.
  it("a disabled descriptor named directly in render_settings falls back to Haiku", () => {
    expect(parseCompilerModel({ compileModel: CLAUDE_OPUS_5.id })).toBe(CLAUDE_HAIKU_4_5);
    expect(parseCompilerModel({ compileModel: GPT_5.id })).toBe(CLAUDE_HAIKU_4_5);
  });

  it("an unknown compileModel id falls back to Haiku", () => {
    expect(parseCompilerModel({ compileModel: "some-removed-model" })).toBe(CLAUDE_HAIKU_4_5);
  });

  // CLAUDE_MODEL is the *default* for a project that hasn't chosen, never a
  // hard override — mirrors pickModel's own rule for the video model.
  it("CLAUDE_MODEL naming a disabled descriptor falls back to Haiku, not the disabled model", () => {
    vi.stubEnv("CLAUDE_MODEL", CLAUDE_OPUS_5.id);
    expect(defaultCompilerModelId()).toBe(CLAUDE_HAIKU_4_5.id);
    expect(parseCompilerModel({})).toBe(CLAUDE_HAIKU_4_5);
  });

  it("CLAUDE_MODEL naming an enabled model becomes the project's default", () => {
    vi.stubEnv("CLAUDE_MODEL", CLAUDE_SONNET_5.id);
    expect(defaultCompilerModelId()).toBe(CLAUDE_SONNET_5.id);
    expect(parseCompilerModel({})).toBe(CLAUDE_SONNET_5);
  });

  it("an unset or unrecognized CLAUDE_MODEL falls back to Haiku rather than throwing", () => {
    vi.stubEnv("CLAUDE_MODEL", "");
    expect(defaultCompilerModelId()).toBe(CLAUDE_HAIKU_4_5.id);
    vi.stubEnv("CLAUDE_MODEL", "not-a-real-model");
    expect(defaultCompilerModelId()).toBe(CLAUDE_HAIKU_4_5.id);
  });

  // Once a project HAS chosen, CLAUDE_MODEL no longer applies — an
  // explicit compileModel key wins over the env var every time.
  it("an explicit compileModel choice overrides CLAUDE_MODEL", () => {
    vi.stubEnv("CLAUDE_MODEL", CLAUDE_SONNET_5.id);
    expect(parseCompilerModel({ compileModel: CLAUDE_HAIKU_4_5.id })).toBe(CLAUDE_HAIKU_4_5);
  });

  it("getCompilerModel falls back to Haiku for null/undefined/unknown ids", () => {
    expect(getCompilerModel(null)).toBe(CLAUDE_HAIKU_4_5);
    expect(getCompilerModel(undefined)).toBe(CLAUDE_HAIKU_4_5);
    expect(getCompilerModel("not-a-real-model")).toBe(CLAUDE_HAIKU_4_5);
  });
});

describe("CompilerModelIdSchema", () => {
  it("accepts every enabled model", () => {
    expect(CompilerModelIdSchema.safeParse(CLAUDE_HAIKU_4_5.id).success).toBe(true);
    expect(CompilerModelIdSchema.safeParse(CLAUDE_SONNET_5.id).success).toBe(true);
  });

  it("rejects every disabled model, each with a message naming the reason", () => {
    for (const model of COMPILER_MODELS) {
      if (model.enabled) continue;
      const result = CompilerModelIdSchema.safeParse(model.id);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(model.disabledReason);
      }
    }
  });

  it("rejects an unknown id", () => {
    expect(CompilerModelIdSchema.safeParse("some-removed-model").success).toBe(false);
  });
});

describe("COMPILER_MODELS invariants", () => {
  it("every disabled model carries a non-null disabledReason", () => {
    for (const model of COMPILER_MODELS) {
      if (!model.enabled) {
        expect(model.disabledReason).not.toBeNull();
      }
    }
  });

  it("every enabled model carries a null disabledReason", () => {
    for (const model of COMPILER_MODELS) {
      if (model.enabled) {
        expect(model.disabledReason).toBeNull();
      }
    }
  });

  it("every model carries a positive real price", () => {
    for (const model of COMPILER_MODELS) {
      expect(model.costUsd).toBeGreaterThan(0);
    }
  });
});

// mergeRenderSettings is the TypeScript half of a merge that also exists in
// SQL (0045_scene_render_settings_override.sql runs
// `p.render_settings || coalesce(s.render_settings_override, '{}'::jsonb)` in
// all three worker queries). The two halves have no codegen between them, so
// these pin the semantics both must share: shallow, right-wins, absent keys
// inherited live rather than snapshotted.
describe("mergeRenderSettings", () => {
  const project = { model: SEEDANCE_2_5.id, resolution: "1080p", fps: 24 };

  it("returns the project's settings unchanged when there is no override", () => {
    expect(mergeRenderSettings(project, null)).toEqual(parseRenderSettings(project));
    expect(mergeRenderSettings(project, undefined)).toEqual(parseRenderSettings(project));
    expect(mergeRenderSettings(project, {})).toEqual(parseRenderSettings(project));
  });

  it("lets a partial override win per key while absent keys fall through", () => {
    // The whole point of storing a PARTIAL object: the override names only
    // fps, and resolution keeps inheriting the project's live value instead
    // of being frozen at whatever it was when the override was written.
    expect(mergeRenderSettings(project, { fps: 24 })).toEqual({
      model: SEEDANCE_2_5.id,
      resolution: "1080p",
      fps: 24,
    });
  });

  it("resolves the inherited keys against the OVERRIDE's model, not the project's", () => {
    // This is why the merge happens on the raw blobs and is parsed once,
    // rather than parsing each side and merging the results — a mismatched
    // resolution (Hailuo's "768P" carried onto Kling, say) would hand kie a
    // resolution the model rejects if the two sides were parsed separately.
    // Kling itself now offers "1080p" too (kie spells it lowercase, same as
    // this project's own value), so this particular case carries over
    // validly; the assertions below still confirm parseRenderSettings
    // settled on a resolution and fps Kling actually allows, which is the
    // rule the render gate applies when the operator switches models by
    // hand, and the rule the worker's ParseRenderSettings applies to the
    // merged blob.
    const merged = mergeRenderSettings(project, { model: KLING_3_PRO.id });
    expect(merged.model).toBe(KLING_3_PRO.id);
    expect(KLING_3_PRO.allowedResolutions).toContain(merged.resolution);
    expect(KLING_3_PRO.allowedFps).toContain(merged.fps);
  });

  // A model-only override on a 720p project now inherits the std tier
  // rather than falling back to pro/1080p — decided, and consistent on
  // both sides (this file's billingResolution, worker's nativeAudioModel)
  // now that 720p is a real Kling tier priced both silent and with sound.
  it("inherits the project's 720p onto a model-only Kling override, since Kling now offers std/720p too", () => {
    const project720 = { model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 };
    const merged = mergeRenderSettings(project720, { model: KLING_3_PRO.id });
    expect(merged.model).toBe(KLING_3_PRO.id);
    expect(merged.resolution).toBe("720p");
  });

  it("degrades to the defaults rather than throwing on junk on either side", () => {
    // Both columns are unconstrained jsonb (0012, 0045) — a hand-written SQL
    // update can put anything in them, and a malformed blob must never take
    // down a render.
    expect(mergeRenderSettings("nonsense", 42)).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(mergeRenderSettings(project, "nonsense")).toEqual(parseRenderSettings(project));
  });
});

// The compiler generates against UNIVERSAL_DURATIONS_S, so this list is what
// decides whether a freshly compiled brief survives the operator picking a
// model at the render gate. A hand-written literal is what z.literal() needs
// to steer Claude's structured output (see the constant's own comment); this
// is the guard that keeps the hand-written version honest.
describe("UNIVERSAL_DURATIONS_S", () => {
  it("matches computeUniversalDurationsS exactly", () => {
    expect([...UNIVERSAL_DURATIONS_S]).toEqual(computeUniversalDurationsS());
  });

  it("is accepted by both default routes, which is the whole point", () => {
    // Seedance and Kling specifically, not every model in VIDEO_MODELS —
    // see UNIVERSAL_DURATIONS_S's own doc comment. Hailuo accepts 6 or 10
    // seconds only; holding it to this list would have cut the compiler's
    // vocabulary to {6, 10} for every scene in every project because one
    // narrow, explicitly-opt-in model exists. A scene later moved onto it
    // is caught by the settings panel and by assertSettingsAllowedForDurations.
    for (const model of [SEEDANCE_2_5, KLING_3_PRO]) {
      for (const duration of UNIVERSAL_DURATIONS_S) {
        expect(
          model.allowedDurationsS.includes(duration),
          `${model.label} rejects ${duration}s, so a compiled brief could not render on it`,
        ).toBe(true);
      }
    }
  });

  it("is not empty — an empty set would leave the compiler no legal duration", () => {
    expect(UNIVERSAL_DURATIONS_S.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE GENERIC AND UGC MODEL LISTS MUST STAY EXPLICIT.
//
// VIDEO_MODELS (this file's table, which getModel resolves against) and
// KIE_MODELS (lib/kie/models.ts, which offerable() resolves against) are two
// lists maintained by hand. Gemini Omni Video is intentionally UGC-only,
// while the other entries must resolve through the generic descriptor table.
//
// Nothing failed. offerable() accepted the operator's choice of 2.0, then
// getModel("seedance-2") found nothing here and returned SEEDANCE_2_5 --
// its documented fallback -- so the scene was written as seedance-2.5 and
// billed at 28 credits/s under a button that had quoted 19. A silent
// substitution, which is worse than a refusal: a refusal is visible.
//
// Ids and order both, because both are load-bearing -- the picker renders
// KIE_MODELS in list order and this table is meant to mirror it.
// ---------------------------------------------------------------------------
describe("getModel against KIE_MODELS", () => {
  it("resolves every offerable model to itself, never to the fallback", () => {
    // The failure this pins is precisely getModel returning SEEDANCE_2_5 for
    // an id it does not carry, which reads as success everywhere downstream.
    for (const model of KIE_MODELS) {
      expect(getModel(model.id).id, `getModel(${model.id}) fell back`).toBe(model.id);
    }
  });
});

// ---------------------------------------------------------------------------
// IMAGE_MODELS — what each image model may be asked to do (0088).
//
// These three rules were all bought with a real paid measurement, and each one
// costs money if it silently flips:
//
//   * Seedream 5.0 Pro runs on BytePlus only, one id for both paths.
//   * Nano Banana takes references through a SEPARATE -edit endpoint.
//   * Nano Banana 2 takes them through the SAME id — `nano-banana-2-edit` is
//     rejected by kie, which is not the same thing as having no reference path.
//
// kieIdForImageModel returning null is the refusal, and it is load-bearing: a
// base text-to-image endpoint handed reference images accepts them, ignores
// them, returns 200 and bills, so "send it anyway" is the expensive branch.
// ---------------------------------------------------------------------------
describe("IMAGE_MODELS reference rules", () => {
  const imageModel = (id: string) => {
    const found = IMAGE_MODELS.find((model) => model.id === id);
    if (!found) throw new Error(`IMAGE_MODELS no longer carries ${id}`);
    return found;
  };

  it("sends Seedream 5.0 Pro to BytePlus on both paths, never a kie id", () => {
    // Owner's rule (2026-11-09): BytePlus generations never fall back to kie.
    const seedream = imageModel("seedream-5.0-pro");
    expect(kieIdForImageModel(seedream, false)).toBe(SEEDREAM_PRO_ID);
    expect(kieIdForImageModel(seedream, true)).toBe(SEEDREAM_PRO_ID);
    expect(seedream.costUsd).not.toBeNull();
  });

  it("refuses references on any model whose editId is null", () => {
    // The rule that actually protects money, independent of which models are
    // configured today: a base text-to-image endpoint handed reference images
    // accepts them, ignores them, returns 200 and bills. Null must mean refuse,
    // never "send it anyway".
    const refusing = { ...imageModel("nano-banana"), editId: null };
    expect(kieIdForImageModel(refusing, true)).toBeNull();
  });

  it("keeps Nano Banana on its separate edit endpoint", () => {
    const nanoBanana = imageModel("nano-banana");
    expect(kieIdForImageModel(nanoBanana, false)).toBe("google/nano-banana");
    expect(kieIdForImageModel(nanoBanana, true)).toBe("google/nano-banana-edit");
  });

  it("does not offer Nano Banana 2", () => {
    expect(IMAGE_MODELS.map((m) => m.id)).not.toContain("nano-banana-2");
  });

  it("gives every model at least one supported aspect ratio", () => {
    // The form falls back to aspectRatios[0] when the picked ratio is not
    // supported, so an empty list would render undefined into the request.
    for (const model of IMAGE_MODELS) {
      expect(model.aspectRatios.length, `${model.id} offers no aspect ratio`).toBeGreaterThan(0);
    }
  });

  it("offers 9:16, 1:1 and 16:9 on every image model, and nothing else", () => {
    for (const model of IMAGE_MODELS) {
      expect([...model.aspectRatios], model.id).toEqual(["9:16", "1:1", "16:9"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Which calls are allowed to block.
//
// This is the gate that was missing when seedream-5.0-pro's reference path was
// offered: `observedSeconds` recorded only the text path (91.9s), the
// image-to-image path actually runs 131-149s, and every @tagged generation
// therefore timed out at 100s, held as billing-unknown, and charged $0.0375 for
// an image nobody collected. IMAGE_MODELS' own header already stated the rule
// (it is why Nano Banana Pro at 162.9s is withheld); nothing enforced it.
// ---------------------------------------------------------------------------
describe("blocksInline", () => {
  const model = (over: Partial<ImageModelDescriptor>): ImageModelDescriptor => ({
    id: "m",
    label: "M",
    textToImageId: "t",
    editId: "e",
    costUsd: 0.01,
    observedSeconds: 20,
    aspectRatios: IMAGE_ASPECT_RATIOS,
    ...over,
  });

  it("blocks a fast path", () => {
    expect(blocksInline(model({ observedSeconds: 22 }), false)).toBe(true);
  });

  it("hands off a path measured beyond the budget", () => {
    // 149s against a 100s budget: the timeout is certain, so waiting for it
    // only costs a held server worker and the operator's 100 seconds.
    expect(blocksInline(model({ observedSeconds: 91.9, editObservedSeconds: 149 }), true)).toBe(
      false,
    );
  });

  it("judges each path on its OWN measurement, not the model's", () => {
    // The exact bug, in its general form: one descriptor, opposite answers.
    // Reading a single number for both paths is what shipped a model whose
    // @tagged calls could never land inside the budget.
    const split = model({ observedSeconds: 22, editObservedSeconds: 149 });
    expect(blocksInline(split, false)).toBe(true);
    expect(blocksInline(split, true)).toBe(false);
  });

  it("blocks both seedream paths — BytePlus is synchronous, with no task id to hand off", () => {
    const seedream = IMAGE_MODELS.find((m) => m.id === "seedream-5.0-pro")!;
    expect(blocksInline(seedream, false)).toBe(true);
    expect(blocksInline(seedream, true)).toBe(true);
  });

  it("falls back to the text measurement when the edit path has none", () => {
    expect(blocksInline(model({ observedSeconds: 22, editObservedSeconds: null }), true)).toBe(
      true,
    );
  });

  it("still blocks an UNMEASURED model — waiting is how the number is found", () => {
    expect(blocksInline(model({ observedSeconds: null }), false)).toBe(true);
  });

  it("hands off a path close enough to the budget that variance crosses it", () => {
    // The three seedream receipts span 131-149s. A path measured just under the
    // ceiling lands just over it often enough to matter, so the margin is real.
    expect(blocksInline(model({ observedSeconds: 91.9 }), false)).toBe(false);
  });
});
