// Video model descriptors, pricing, and per-project render settings.
//
// kie.ai is the only vendor. fal.ai was decommissioned outright — not
// deprecated, removed: worker/internal/fal is gone, and so is every fal
// rate, endpoint and fallback that used to live in this file. What remains
// is the KEEP-IN-SYNC pair this file has always been, now with a partner
// that actually exists: worker/internal/kie/models.go describes the same
// render-capable models in Go, and lib/kie/rates.ts is the one place their credit
// prices are recorded — this file's VideoModelDescriptor table reads
// through that module rather than duplicating its numbers a third time
// (see priceForSecond below). There is still no codegen between the two
// languages, so a model, a duration, or a resolution added on one side and
// not the other is a silent drift until someone notices the price on a
// button doesn't match the bill.
//
// FIVE GENERIC MODELS, always selectable. Before fal was decommissioned
// this table carried thirteen descriptors — most of them permanently
// disabled, priced (if at all) from a vendor page nobody had ever been
// billed by. There is no "disabled pending verification" tier any more:
// worker/internal/kie/models.go dropped its Enabled/DisabledReason/
// Substituted machinery the same day for the same reason (see that file's
// own header) — a descriptor with nowhere to route is not a model, it's a
// wish. Gemini Omni Video is the explicit UGC-only exception: its job
// pricing and 4/6/8/10s contract do not fit the scripted per-second controls.
//
// Everything a model can do still lives in one descriptor per model. Before
// that shape existed, "which durations does the vendor accept" was a global
// constant, "what does a second cost" was a different one, and the two
// could silently drift out of step with each other. Adding a model is still
// one entry in VIDEO_MODELS plus, when its request body differs, one
// adapter in the worker.

import { z } from "zod";
import { IMAGE_ASPECT_RATIOS, type ImageAspectRatio } from "./image-aspect-ratios";
import { BASE_IMAGE_RESOLUTION, type ImageResolutionId } from "./image-resolutions";
import { SEEDREAM_PRO_ID, SEEDREAM_PRO_ASPECT_RATIOS } from "./seedream";
import {
  NANO_BANANA_2_1_ID,
  GPT_IMAGE_2_6_ECONOMY_EDIT,
  GPT_IMAGE_2_6_ECONOMY_TEXT,
} from "./kie/image-input";
import { GPT_IMAGE_2_5_ASPECT_RATIOS, GPT_IMAGE_2_5_IDS } from "./kie/gpt-image-2-5";
import { KIE_POLL_BUDGET_MS } from "./kie/poll-budget";
import {
  CREDITS_PER_USD,
  geminiOmniCredits,
  isPromotionExpired,
  isUnpaidRate,
  rateFor,
  VIDEO_INPUT_PRICING,
  videoRateFor,
  type Resolution,
} from "./kie/rates";

/**
 * AUDIO_ENABLED gate — mirrors worker/internal/config/config.go's
 * AudioEnabled (AUDIO_ENABLED env var) exactly: "1" turns audio on,
 * anything else (including unset) keeps every scene routed to the cheap
 * silent model regardless of is_talking_head. Default is audio-OFF, same
 * as the worker's default, since during this testing phase there is no
 * reason to pay for lip-synced audio.
 *
 * Deliberately a plain (non-NEXT_PUBLIC_) env var read server-side only —
 * see estimateCost's callers, all of which are server components/actions
 * that compute this once and pass it down as a prop to any client
 * component that needs it (e.g. CostBadge). Reading process.env.AUDIO_ENABLED
 * directly from a client component would see `undefined`, not the real
 * server-side value, and silently show the wrong estimate.
 */
export function isAudioEnabled(): boolean {
  return process.env.AUDIO_ENABLED === "1";
}

/**
 * ASSEMBLE_ENABLED gate — mirrors worker/internal/config/config.go's
 * AssembleEnabled (ASSEMBLE_ENABLED env var) exactly: "1" turns on the
 * worker's ffmpeg concat of a project's clips into a single `final` asset.
 * The Deliver page reads this to decide whether an "assembling…"
 * placeholder is warranted while it waits for that asset — if the flag is
 * off, no `final` asset is ever coming and the page must show nothing, as
 * it always has.
 *
 * Same reasoning as isAudioEnabled above: deliberately a plain
 * (non-NEXT_PUBLIC_) env var, read server-side only, in
 * app/(app)/projects/[id]/deliver/page.tsx (a Server Component) and passed
 * down as a prop — never inlined into the client bundle.
 */
export function isAssembleEnabled(): boolean {
  return process.env.ASSEMBLE_ENABLED === "1";
}

/**
 * ~$0.60 / 30 scenes from docs/architecture.md § "Cost model" — the
 * per-frame cost shown next to Gate 2's regenerate button so the operator
 * sees exactly what one click costs before clicking it. Lives here (not in
 * actions/frames.ts) because a "use server" file may only export async
 * functions — a plain constant export breaks the whole module.
 *
 * This is the ONE price for every image generation the web app makes, not
 * just reference frames — lib/kie.ts's generateImage hits the same
 * nano-banana (text-to-image) / nano-banana-edit (reference-conditioned)
 * pair regardless of caller, so a per-scene reference frame
 * (actions/frames.ts), a character reference photo, and a character+product
 * composite (both actions/character.ts, and actions/character-library.ts's
 * own composite regen) all cost the same thing to generate and are all
 * priced from this one constant — never a second hand-copied literal at the
 * call site or in UI copy. If kie's rate for either model changes, or the
 * two ever need different prices, this is the only place that has to know.
 *
 * MEASURED against kie's live API on 2026-08-28, not estimated: both
 * `google/nano-banana` (text-to-image) and `google/nano-banana-edit`
 * (reference-conditioned) billed 4 credits at kie's published $0.005/credit
 * rate, i.e. exactly $0.02 on real paid calls, for either model.
 *
 * The actual charge on a successful call is known exactly from
 * recordInfo's creditsConsumed (lib/kie.ts's generateImage) and is what
 * gets written to `runs.cost_usd` — this constant is only ever the
 * pre-flight spend-cap estimate for a call that hasn't happened yet.
 */
export const REF_FRAME_COST_USD = 0.02;

/**
 * The reference-image cost estimate for a not-yet-made generateImage()
 * call — spend-cap pre-checks, and the fallback when a call's result
 * somehow carries no per-call actual cost. A function rather than callers
 * reading REF_FRAME_COST_USD directly so every call site reads the price
 * through one name — same "quoted price and enforced price come from the
 * same source" rule this file applies to video pricing. No-arg: there used
 * to be a vendor parameter here, back when IMAGE_VENDOR could route this
 * same call to fal at a different rate; kie is the only vendor left to ask
 * about.
 */
export function estimatedRefFrameCostUsd(): number {
  return REF_FRAME_COST_USD;
}

/**
 * Rough ceiling for one lib/claude.ts compileScene() call — what Apply and
 * Split (spec §3.5) each spend per scene touched: a single Haiku
 * structured-output call over one script line plus the direction block, an
 * order of magnitude cheaper than REF_FRAME_COST_USD's image generation.
 * Deliberately a round, generous number rather than a metered per-call
 * price — same reasoning as REF_FRAME_COST_USD above, and lives here for
 * the same '"use server" can't export a plain constant' reason.
 *
 * Apply/Split (actions/brief.ts) now DO compile on the project's own
 * COMPILER_MODELS selection (parseCompilerModel(project.render_settings)),
 * same as the Compile Script picker on the Character page
 * (character-setup-form.tsx) — see applySceneCostUsd below for the
 * per-model price that decision is cap-checked and recorded at. This flat
 * constant remains as the value scene-table.tsx's Apply/Split buttons show
 * BEFORE a project's model is known/available to that component, and it is
 * deliberately equal to applySceneCostUsd(CLAUDE_HAIKU_4_5) — Haiku being
 * both the default compiler model and the model this number always priced
 * when Apply/Split ignored the project's choice.
 */
export const APPLY_SCENE_COST_USD = 0.01;

// ---------------------------------------------------------------------------
// Compiler (Claude) model descriptors — same pattern as VideoModelDescriptor
// above, one table per kind of model the operator can pick. See that type's
// doc comment for why "one descriptor per model" beats a scattered set of
// globals: adding GPT-5 here (disabled) is a data row, not a new code path.
// ---------------------------------------------------------------------------

/**
 * Everything the app needs to know about one script-compiling model —
 * i.e. what CLAUDE_MODEL (render.yaml) and lib/claude.ts's
 * compileBrief/compileScene used to hard-code as a single global string.
 * Mirrors VideoModelDescriptor's shape and reasoning, not its domain: this
 * is a text model billed per compile, not a video model billed per second,
 * so there is one flat `costUsd` instead of a per-resolution rate table.
 */
export interface CompilerModelDescriptor {
  /** Stable id — the literal string sent as `model` to the Anthropic SDK, and persisted in projects.render_settings.compileModel. Never a display string. */
  readonly id: string;
  /** Shown to the operator next to the Compile Script button. */
  readonly label: string;
  /**
   * Flat USD ceiling for one compileBrief() call on this model, same
   * "generous flat number, not a metered per-token price" reasoning as
   * APPLY_SCENE_COST_USD and the old COMPILE_SCRIPT_COST_USD it replaces —
   * see compileCostUsd's own doc comment for how this number was derived
   * per model.
   */
  readonly costUsd: number;
  /**
   * False keeps the model visible but unselectable — same reasoning as
   * VideoModelDescriptor.enabled: an operator who can see Opus exists and
   * why it's off does not file a bug asking for it.
   */
  readonly enabled: boolean;
  /** Required whenever enabled is false — shown next to the greyed option. */
  readonly disabledReason: string | null;
}

/**
 * The current behaviour and the default — every compile in this codebase
 * ran on this model before this file's picker existed (lib/claude.ts's
 * `process.env.CLAUDE_MODEL ?? "claude-haiku-4-5"`).
 */
export const CLAUDE_HAIKU_4_5 = {
  id: "claude-haiku-4-5",
  label: "Claude Haiku 4.5",
  // The flat ceiling COMPILE_SCRIPT_COST_USD used to be, unchanged — see
  // that constant's old doc comment (removed with this file's rewrite):
  // generous rather than metered, sized for a whole-script compile
  // (max_tokens: 8000), roughly 4x APPLY_SCENE_COST_USD's single-scene call.
  costUsd: 0.04,
  enabled: true,
  disabledReason: null,
} as const satisfies CompilerModelDescriptor;

/**
 * Roughly 3x Haiku's cost, matching Anthropic's published per-token rates
 * for the two models ($3/$15 per MTok for Sonnet vs. $1/$5 for Haiku —
 * claude-api skill's model table, 2026-06-24 cache) applied to the same
 * flat-ceiling shape CLAUDE_HAIKU_4_5.costUsd already uses.
 */
export const CLAUDE_SONNET_5 = {
  id: "claude-sonnet-5",
  label: "Claude Sonnet 5",
  costUsd: 0.12,
  enabled: true,
  disabledReason: null,
} as const satisfies CompilerModelDescriptor;

/**
 * Disabled, but for an honest reason: this model actually works with
 * lib/claude.ts's Anthropic structured-output call today (nothing about
 * the SDK integration blocks it) — it just costs several times Haiku's
 * price and nobody has measured whether the extra intelligence produces a
 * meaningfully better brief. That measurement, not an engineering gap, is
 * what's missing before this flips to enabled.
 */
export const CLAUDE_OPUS_5 = {
  id: "claude-opus-5",
  label: "Claude Opus 5",
  // $5/$25 per MTok vs. Haiku's $1/$5 — same claude-api skill table.
  costUsd: 0.2,
  enabled: false,
  disabledReason:
    "Works, but costs ~5x Haiku and nobody has measured whether it compiles a better brief.",
} as const satisfies CompilerModelDescriptor;

/**
 * Disabled, and not a flag away from working: this codebase has no OpenAI
 * SDK, no OPENAI_API_KEY, and lib/claude.ts's compileBrief/compileScene are
 * built around Anthropic's structured-output tool calling
 * (@anthropic-ai/sdk's `messages.parse` + `zodOutputFormat`) — nothing here
 * knows how to send a request to OpenAI at all. Enabling this needs a
 * second SDK, a second credential, and a second compile path, not a
 * descriptor edit.
 */
export const GPT_5 = {
  id: "gpt-5",
  label: "GPT-5",
  // OpenAI's published per-token launch pricing ($1.25/$10 per MTok),
  // scaled onto this file's flat-ceiling shape the same way the Claude
  // rows above are — an approximation from a vendor pricing page, same
  // caveat VEO_3_FAST's doc comment gives for its own unverified numbers.
  costUsd: 0.07,
  enabled: false,
  disabledReason: "No OpenAI SDK, no OPENAI_API_KEY, and no OpenAI compile path in lib/claude.ts.",
} as const satisfies CompilerModelDescriptor;

/** Same missing integration as GPT_5 above — see that descriptor's doc comment. */
export const GPT_5_MINI = {
  id: "gpt-5-mini",
  label: "GPT-5 mini",
  // OpenAI's published per-token launch pricing ($0.25/$2 per MTok).
  costUsd: 0.02,
  enabled: false,
  disabledReason: "No OpenAI SDK, no OPENAI_API_KEY, and no OpenAI compile path in lib/claude.ts.",
} as const satisfies CompilerModelDescriptor;

/** Every compiler model the picker knows about, enabled or not. Order is display order. */
export const COMPILER_MODELS: readonly CompilerModelDescriptor[] = [
  CLAUDE_HAIKU_4_5,
  CLAUDE_SONNET_5,
  CLAUDE_OPUS_5,
  GPT_5,
  GPT_5_MINI,
];

/** The model a project gets when it has never chosen one — see defaultCompilerModelId for the CLAUDE_MODEL-aware version actually used at compile time. */
export const DEFAULT_COMPILER_MODEL_ID = CLAUDE_HAIKU_4_5.id;

/**
 * Looks a compiler descriptor up by id, falling back to Haiku rather than
 * throwing — same reasoning as getModel above: render_settings.compileModel
 * is a jsonb field a hand-written SQL update could put anything into, and a
 * page load must degrade to the default rather than 500.
 */
export function getCompilerModel(id: string | null | undefined): CompilerModelDescriptor {
  return COMPILER_MODELS.find((model) => model.id === id) ?? CLAUDE_HAIKU_4_5;
}

/**
 * What one compileBrief() call on this descriptor is priced at — the
 * per-model replacement for the old flat COMPILE_SCRIPT_COST_USD constant.
 * A one-line function rather than callers reading `.costUsd` directly so
 * every call site (the spend-cap check and the `runs` row in
 * actions/compile.ts) reads the price through the same name, the same
 * "quoted price and enforced price must come from the same source" rule
 * this file's header already states for video pricing.
 */
export function compileCostUsd(model: CompilerModelDescriptor): number {
  return model.costUsd;
}

/**
 * What one Apply/Split compileScene() call costs on the given compiler
 * model — the per-model replacement for the flat APPLY_SCENE_COST_USD this
 * codebase used regardless of which model actually ran.
 *
 * Derived from compileCostUsd(model), not a second hand-picked number per
 * model: CLAUDE_HAIKU_4_5.costUsd's own doc comment already states the
 * relationship a full compileBrief() call has to one compileScene() call —
 * "roughly 4x APPLY_SCENE_COST_USD's single-scene call" — so this divides
 * by that same 4 rather than letting a second ratio drift in from
 * somewhere else. For Haiku that reproduces the old flat constant exactly
 * (0.04 / 4 = 0.01); for every other model it scales with that model's own
 * compileCostUsd, so an operator on Sonnet is cap-checked and billed at
 * Sonnet's rate, not Haiku's.
 */
export function applySceneCostUsd(model: CompilerModelDescriptor): number {
  return compileCostUsd(model) / 4;
}

/**
 * The compiler model a project gets when render_settings.compileModel has
 * never been set — CLAUDE_MODEL (render.yaml) read here, and ONLY here, so
 * it can never become a hard override. Mirrors pickModel's own "settings.model
 * is authoritative, a disabled id never sneaks through" rule: an operator
 * env var naming a disabled descriptor (or a typo, or an unset var) falls
 * back to Haiku instead of quietly compiling on it.
 *
 * Once a project HAS chosen (render_settings.compileModel is set),
 * parseCompilerModel below never calls this — CLAUDE_MODEL only supplies
 * the starting point for a project that has not decided yet, same as
 * DEFAULT_MODEL_ID does for the video model.
 */
export function defaultCompilerModelId(): string {
  const model = getCompilerModel(process.env.CLAUDE_MODEL);
  return model.enabled ? model.id : CLAUDE_HAIKU_4_5.id;
}

/**
 * Field-level validation for a write of one compiler model id to
 * projects.render_settings.compileModel — the compile-side counterpart of
 * RenderSettingsSchema's `model` check below. Strict about which model may
 * be SELECTED: only enabled descriptors pass, for the same reason Opus/GPT-5
 * exist in COMPILER_MODELS at all — so the picker can show them greyed out
 * with a reason, not so a write can ever persist one.
 */
export const CompilerModelIdSchema = z.string().superRefine((value, ctx) => {
  const model = COMPILER_MODELS.find((candidate) => candidate.id === value);
  if (!model) {
    ctx.addIssue({
      code: "custom",
      message: `Unknown compiler model "${value}". Known: ${COMPILER_MODELS.map((m) => m.id).join(", ")}.`,
    });
    return;
  }
  if (!model.enabled) {
    ctx.addIssue({
      code: "custom",
      message: `${model.label} cannot be selected: ${model.disabledReason ?? "disabled"}.`,
    });
  }
});

/**
 * Reads projects.render_settings.compileModel into a resolved, enabled-safe
 * descriptor. Lives in the same jsonb blob RenderSettings/parseRenderSettings
 * already use for the video model (0012_render_settings.sql's `{}`-default
 * column) — no migration needed, since jsonb has no schema to alter and
 * `{}` already reads as "nothing chosen yet" for both concerns. Deliberately
 * NOT folded into the RenderSettings interface/RenderSettingsSchema pair
 * above: those are validated and written as one flat {model,resolution,fps}
 * object by actions/render-settings.ts's updateRenderSettings, and a video
 * settings write already has to happen without knowing or caring what the
 * compiler field currently holds. Keeping this a sibling key read by its own
 * function means a video-settings save and a compiler-model save each only
 * have to preserve the OTHER key on write (see both actions' own comments),
 * rather than one schema owning fields two different actions each mutate.
 *
 * Same leniency as parseRenderSettings for the same reason: this runs on
 * every page load against a column a direct SQL write can put anything
 * into, so a malformed or absent value degrades to the default instead of
 * throwing. Writes go through CompilerModelIdSchema above; reads go through
 * here.
 */
export function parseCompilerModel(raw: unknown): CompilerModelDescriptor {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof record.compileModel !== "string") {
    // Never chosen — CLAUDE_MODEL is the default for exactly this case.
    return getCompilerModel(defaultCompilerModelId());
  }
  const model = getCompilerModel(record.compileModel);
  // A disabled descriptor can only reach this column via a hand-written SQL
  // update (no CHECK constraint on jsonb) — never let it become selectable
  // through the back door; fall back to Haiku the same way pickModel does.
  return model.enabled ? model : CLAUDE_HAIKU_4_5;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Video model descriptors
// ---------------------------------------------------------------------------

/**
 * Everything the app needs to know about one kie.ai video model, short of
 * its price — price is looked up live from lib/kie/rates.ts (see
 * priceForSecond below), not carried as a field here, so a rate measured
 * once has exactly one place to live. Carrying a second, hand-typed dollar
 * table on this descriptor was tried and is what produced $0.1125/s for
 * Kling — a number reverse-engineered to reproduce a receipt rather than
 * read off one (see lib/kie/rates.ts's own header for the full story).
 *
 * `maxDurationSByFps` and `maxDurationSByResolution` carry cross-field
 * constraints — combinations that are each individually legal but illegal
 * together. Every current model has none (LTX's old "50fps only under 10s"
 * rule and Hailuo's old "no 10s at 1080P" rule both left with the
 * descriptors that carried them), but the shape stays: a model that ships
 * with a real cross-field limit tomorrow is a data change here, not a new
 * `if` scattered across the render gate, the server action and the tests
 * that all have to agree on it.
 */
export interface VideoModelDescriptor {
  /** Stable id persisted in projects.render_settings.model, and lib/kie/rates.ts's own rate-table key. Never a display string. */
  readonly id: string;
  /** Shown to the operator on the render gate. */
  readonly label: string;
  readonly allowedResolutions: readonly Resolution[];
  readonly defaultResolution: Resolution;
  readonly allowedDurationsS: readonly number[];
  /**
   * Longest `prompt` this vendor's endpoint will accept, in characters, or
   * absent when it has no known limit.
   *
   * MEASURED BY BEING REFUSED. kie answered a real /ugc render with
   * code=422 "The length of 'prompt' must not exceed 2500 characters" on
   * 2026-09-11, after the operator had approved the spend — the prompt was
   * 4,740 characters. Nothing anywhere knew the limit existed, so the only
   * place it could be discovered was the vendor, after the press.
   *
   * THE NUMBER TO CHECK IS THE SUBMITTED ONE, not what was typed. That
   * render's authored prompt was 2,310 characters and passed under the cap;
   * substituting each @tag for its saved description added 2,430 more. A
   * check against the box's own text would have cleared it.
   */
  readonly maxPromptChars?: number;
  /**
   * Kept for the render gate's UI and RenderSettingsSchema's validation,
   * even though no kie model actually takes an fps input on the wire today
   * — mirrors worker/internal/kie/models.go's own AllowedFPS/DefaultFPS,
   * and that file's comment on why: render_settings.fps stays a meaningful
   * column even though every current descriptor delivers at a fixed 24fps
   * regardless of what's sent.
   */
  readonly allowedFps: readonly number[];
  readonly defaultFps: number;
  /** fps -> longest clip that fps is legal for. An fps absent here has no limit. Empty on every current model. */
  readonly maxDurationSByFps: Readonly<Record<number, number>>;
  /** resolution -> longest clip that resolution is legal for. A resolution absent here has no limit. Empty on every current model. */
  readonly maxDurationSByResolution: Readonly<Record<string, number>>;
  /**
   * True only for Kling: pickModel reads this as "route through the
   * native-audio path, and only ever for a project that explicitly
   * selected this model" — see pickModel's own doc comment. Every other
   * model renders silent, or (Seedance) takes a plain generate-audio
   * boolean that isn't a talking-head route at all.
   */
  readonly nativeAudio: boolean;
}

/**
 * Seedance 2.5 — the general-purpose default. No longer the only model
 * priced at more than one resolution: Kling now has two priced tiers, and
 * Seedance 2 / 2 Fast list several each.
 *
 * 480P is the default resolution, not 720P: it is the tier the workflow
 * /ugc was built for actually uses, and it is priced from kie's own
 * publish page rather than a receipt (see lib/kie/rates.ts's "seedance-2.5"
 * entry) — "unpaid" until a render at that tier retires the label. 1080P
 * carries a time-limited promotional rate; see rateFor/isPromotionExpired
 * in lib/kie/rates.ts for what happens the day it lapses.
 */
export const SEEDANCE_2_5: VideoModelDescriptor = {
  id: "seedance-2.5",
  label: "Seedance 2.5",
  allowedResolutions: ["480p", "720p", "1080p"],
  defaultResolution: "480p",
  allowedDurationsS: [
    4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    29, 30,
  ],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
};

export const SEEDANCE_2_5_BYTEPLUS: VideoModelDescriptor = {
  ...SEEDANCE_2_5,
  id: "seedance-2.5-byteplus",
  label: "Seedance 2.5 · BytePlus ModelArk",
};

/**
 * Kling 3.0 — the only model that can produce sound, and the only
 * route to a lip-synced talking-head clip.
 *
 * kie prices silent and sound-on renders as two genuinely different
 * numbers (18 cr/s against 27, both read off real receipts — see
 * lib/kie/rates.ts) rather than a base rate plus an audio surcharge
 * multiplier, so silent Kling is also, at $0.09/s, cheaper per second than
 * Seedance at any tier above 480P — and at a higher resolution.
 *
 * TWO RESOLUTIONS as of 2026-09-10: kie's `std` mode (720p, 20 cr/s with
 * sound, also a receipt) joined `pro` (1080p, 27) once /ugc needed it —
 * see lib/kie/rates.ts's "kling-3.0-pro" entry. defaultResolution stays
 * pro/1080p; that default is this descriptor's, for the scripted pipeline
 * render-gate.tsx and render-settings-form.tsx build from it. /ugc's own
 * default is std/720p, chosen in lib/ugc-options.ts by the cheapest
 * offerable tier, not by this field. "Pro" left the LABEL the same day,
 * for the same reason lib/kie/models.ts's KLING_3_PRO dropped it — std is
 * not pro. The id stays "kling-3.0-pro" regardless: it is persisted in
 * render_settings and in every run already on record, and renaming it
 * would strand both.
 */
export const KLING_3_PRO: VideoModelDescriptor = {
  id: "kling-3.0-pro",
  label: "Kling 3.0",
  allowedResolutions: ["720p", "1080p"],
  defaultResolution: "1080p",
  allowedDurationsS: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: true,
  // kie refused a 4,740-character /ugc prompt with code=422 naming this
  // number exactly (task-less failure on scene a7968209, 2026-09-11). No
  // Seedance render has ever been refused for length, and several have gone
  // out well past 4,000 characters, so the cap is Kling's and not kie's.
  maxPromptChars: 2500,
};

/**
 * Hailuo 2.3 Pro — the cheapest second available on this account ($0.045/s,
 * a receipt, see lib/kie/rates.ts), and unusable for the four-second
 * workflow /ugc is built around: kie takes 6 or 10 seconds for this model,
 * not a range. Silent only, and only ever at 768P — kie has never been
 * billed for this model at any other resolution, so none is offered.
 */
export const HAILUO_2_3_PRO: VideoModelDescriptor = {
  id: "hailuo-2.3-pro",
  label: "Hailuo 2.3 Pro",
  allowedResolutions: ["768P"],
  defaultResolution: "768P",
  allowedDurationsS: [6, 10],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
};

export const GEMINI_OMNI_VIDEO: VideoModelDescriptor = {
  id: "gemini-omni-video",
  label: "Gemini Omni Video",
  allowedResolutions: ["720p", "1080p", "4k"],
  defaultResolution: "720p",
  allowedDurationsS: [4, 6, 8, 10],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
};

export const GEMINI_OMNI_1_2: VideoModelDescriptor = {
  id: "gemini-omni-1.2",
  label: "Gemini Omni 1.2 Flash",
  allowedResolutions: ["360p", "720p", "1080p", "4k"],
  defaultResolution: "720p",
  allowedDurationsS: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
  maxPromptChars: 20_000,
};

/**
 * Seedance 2.0 — ByteDance's 2.0 proper, cheaper than 2.5 at every tier.
 *
 * PRESENT HERE BECAUSE getModel() FALLS BACK SILENTLY. This table and
 * lib/kie/models.ts's KIE_MODELS are two lists of the same models, and this
 * one was left at three when 2.0 and 2.0 Fast were added to that one. The
 * cost was not a missing feature — it was a wrong charge. generateClip
 * validates the operator's choice against offerable() (which reads
 * KIE_MODELS, so 2.0 passed), then resolved it through getModel(), which
 * finds nothing here and returns SEEDANCE_2_5 rather than failing. The scene
 * was written as seedance-2.5 and rendered at 28 cr/s under a button that
 * had quoted 19.
 *
 * 4k is deliberately absent, as in KIE_MODELS: 208 cr/s is $8.32 for a 4s
 * clip, which is a decision rather than a picker option.
 */
export const SEEDANCE_2: VideoModelDescriptor = {
  id: "seedance-2",
  label: "Seedance 2.0",
  allowedResolutions: ["480p", "720p", "1080p"],
  defaultResolution: "480p",
  allowedDurationsS: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
};

/**
 * Seedance 2.0 Fast — the cheapest clip on the account at 11.7 cr/s (a
 * receipt), and the same wire shape as the other two Seedances.
 *
 * Stops at 720p: kie serves no 1080p and no 4k for this model.
 */
export const SEEDANCE_2_FAST: VideoModelDescriptor = {
  id: "seedance-2-fast",
  label: "Seedance 2.0 Fast",
  allowedResolutions: ["480p", "720p"],
  defaultResolution: "480p",
  allowedDurationsS: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
};

/**
 * Every model the generic render gate knows about. Gemini Omni Video is
 * intentionally UGC-only: its exact job pricing and 4/6/8/10s contract do
 * not fit the scripted pipeline's per-second, 4-15s controls. It remains in
 * KIE_MODELS and resolves through getModel() for UGC scenes.
 *
 * The count is stated because it was wrong: this said "the same three" while
 * the other lists had grown independently, and getModel()'s silent fallback
 * turned that into a mispriced render rather than an error. The UGC-only
 * exception is explicit and covered by the model drift tests.
 */
export const SEEDANCE_2_MINI: VideoModelDescriptor = {
  id: "seedance-2-mini",
  label: "Seedance 2.0 Mini",
  allowedResolutions: ["480p", "720p"],
  defaultResolution: "480p",
  allowedDurationsS: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
};

/**
 * Kling 4.0 keyframe-to-video. nativeAudio is true for the Kling-family
 * behaviour it shares with KLING_3_PRO — start/end frames, @tags refused,
 * PNG/JPG frames — not because kie takes a sound flag: it takes none, and
 * prices both tiers the same (lib/kie/rates.ts).
 */
export const KLING_4: VideoModelDescriptor = {
  id: "kling-4.0",
  label: "Kling 4.0",
  allowedResolutions: ["720p", "1080p"],
  defaultResolution: "720p",
  allowedDurationsS: [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    29, 30,
  ],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: true,
  maxPromptChars: 8000,
};

/**
 * Kling 4.0 reference-to-video. nativeAudio false, unlike KLING_4: it takes
 * @tags through the References box like Seedance, not start/end frames.
 */
export const KLING_4_REFERENCE: VideoModelDescriptor = {
  id: "kling-4.0-reference",
  label: "Kling 4.0 Reference",
  allowedResolutions: ["720p", "1080p"],
  defaultResolution: "720p",
  allowedDurationsS: [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    29, 30,
  ],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
  maxPromptChars: 8000,
};

export const WAN_3: VideoModelDescriptor = {
  id: "wan-3.0",
  label: "Wan 3.0",
  allowedResolutions: ["480P", "720P", "1080P"],
  defaultResolution: "480P",
  allowedDurationsS: [
    4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    29, 30,
  ],
  allowedFps: [24],
  defaultFps: 24,
  maxDurationSByFps: {},
  maxDurationSByResolution: {},
  nativeAudio: false,
};

export const VIDEO_MODELS: readonly VideoModelDescriptor[] = [
  SEEDANCE_2_5,
  SEEDANCE_2_5_BYTEPLUS,
  SEEDANCE_2,
  SEEDANCE_2_FAST,
  SEEDANCE_2_MINI,
  KLING_3_PRO,
  KLING_4,
  KLING_4_REFERENCE,
  HAILUO_2_3_PRO,
  WAN_3,
];

/**
 * The model a project gets when render_settings says nothing. Mirrors
 * worker/internal/kie/models.go's DefaultModelID.
 */
export const DEFAULT_MODEL_ID = SEEDANCE_2_5.id;

/**
 * The clip lengths EVERY project can compile against, regardless of which
 * model the operator later picks at the render gate — the intersection of
 * SEEDANCE_2_5 and KLING_3_PRO's own allowedDurationsS, deliberately NOT
 * including HAILUO_2_3_PRO's.
 *
 * This is what the compiler generates against (lib/claude.ts), and the
 * reason is ordering: a brief is written before the operator has chosen a
 * model, at Review Brief, and updateRenderSettings is only reachable later,
 * at the render gate. Compiling against a set every enabled model accepts
 * would therefore have to intersect all of them — and Hailuo accepts
 * exactly two lengths, 6 and 10, so a blanket intersection would cut the
 * compiler's whole vocabulary down to those two for every project, on
 * every model, because one narrow, explicitly-opt-in model happens to
 * exist. Hailuo is reached only by an operator naming it directly at the
 * render gate, same as Kling always has been — this list exists to cover
 * the durations a project can compile against BEFORE that choice is made,
 * and Seedance/Kling between them already accept every length from 4 to 15.
 *
 * Written out as a literal rather than computed at module scope because
 * lib/claude.ts feeds it to z.literal() for Claude's structured-output
 * mode, which needs the literals to survive into the TYPE to steer
 * generation (see the duration_s field's own comment). computeUniversal
 * DurationsS below is the executable version of this list, and
 * models.test.ts fails the moment the two disagree.
 */
export const UNIVERSAL_DURATIONS_S = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

/**
 * UNIVERSAL_DURATIONS_S, derived rather than declared — the drift guard for
 * the hand-written literal above. See that constant's own doc comment for
 * why this is SEEDANCE_2_5 and KLING_3_PRO specifically, not every model in
 * VIDEO_MODELS.
 */
export function computeUniversalDurationsS(): number[] {
  const models: VideoModelDescriptor[] = [SEEDANCE_2_5, KLING_3_PRO];
  const [first, ...rest] = models;
  if (!first) return [];
  return first.allowedDurationsS
    .filter((duration) => rest.every((model) => model.allowedDurationsS.includes(duration)))
    .slice()
    .sort((a, b) => a - b);
}

/**
 * Looks a descriptor up by id, falling back to the default model rather
 * than throwing. Callers are overwhelmingly rendering a page from a jsonb
 * blob that a hand-written SQL update could have put anything into; a
 * project whose settings name a model we removed must still load and still
 * quote a price, not 500. The Zod schema is what rejects an unknown id on
 * the way *in*.
 */
export function getModel(id: string | null | undefined): VideoModelDescriptor {
  return id === GEMINI_OMNI_VIDEO.id
    ? GEMINI_OMNI_VIDEO
    : id === GEMINI_OMNI_1_2.id
      ? GEMINI_OMNI_1_2
      : (VIDEO_MODELS.find((model) => model.id === id) ?? SEEDANCE_2_5);
}

/**
 * True when this price rests on a rate nobody here has actually been
 * billed for — kie's own page says so (lib/kie/rates.ts's
 * `provenance: "published"`), and the UI owes the operator a visible label
 * before it lets them spend against it. False for a resolution/sound pair
 * nobody has priced at all: priceForSecond already refuses those outright
 * (returns +Infinity, see below), which is a much louder signal than a
 * label — there's nothing for this function to add.
 */
export function isPriceEstimated(
  model: VideoModelDescriptor,
  resolution: string,
  audioOn = false,
): boolean {
  const rate = rateFor(model.id, resolution, audioOn);
  return rate !== null && isUnpaidRate(rate);
}

/** Whether a model may be selected for a new render at this resolution. */
export function isModelAvailableForSelection(modelId: string, resolution: string): boolean {
  if (modelId !== "gemini-omni-video") return true;
  const rate = rateFor(modelId, resolution, false);
  // Same rule as offerable(): a published rate is sold, a lapsed promotion is not.
  return rate !== null && !isPromotionExpired(rate, new Date());
}

/**
 * USD per second of output for a model at a given resolution — reads
 * straight through to lib/kie/rates.ts's rateFor and converts credits to
 * dollars, so this file and that one can never quote two different numbers
 * for the same render.
 *
 * `audioOn` selects kie's SOUND table, not a multiplier applied to the
 * silent rate: kie prices a talking-head second and a silent second as two
 * different measured numbers (Kling: 18 cr/s silent, 27 with sound), not
 * one rate times a surcharge — see lib/kie/rates.ts's own header for what
 * modelling it as a multiplier cost this product once already.
 *
 * Returns +Infinity for a resolution/sound combination nobody has priced.
 * Unknown is not free: an empty answer here must refuse every cap check
 * and total built on it, never read as cheap. Every nativeAudio model is
 * priced BOTH silent and with sound at every resolution it allows (pinned
 * by models.test.ts's "every allowed resolution on a nativeAudio model is
 * priced BOTH silent and with sound"); a standard model can still be
 * unpriced in one tier — Seedance 2.0 and 2.0 Fast have no silent rate at
 * all, which is why the scripted gate's model row shows them as $∞ silent
 * already, on main. +Infinity is the belt to that braces, for a settings
 * blob reached some other way — a hand-written SQL update, or a resolution
 * combination this file's own validation should have already refused.
 */
export function priceForSecond(
  model: VideoModelDescriptor,
  resolution: string,
  audioOn = false,
): number {
  // Gemini Omni Video has fixed job prices keyed by duration. Returning the
  // provenance marker from KIE_RATES here would manufacture a linear price;
  // callers that know a duration must use clipCostUsd instead.
  if (model.id === GEMINI_OMNI_VIDEO.id) return Number.POSITIVE_INFINITY;
  const rate = rateFor(model.id, resolution, audioOn);
  if (!rate) return Number.POSITIVE_INFINITY;
  return rate.creditsPerSecond / CREDITS_PER_USD;
}

/**
 * FALSE since 2026-09-10, when two video-conditioned renders were read off
 * real bills (136 credits at 4s out, 204 at 8s). It answered true for every
 * quote before that. Kept rather than deleted: it is the same
 * published-versus-paid question every rate in this product has to answer,
 * and a third input mode arriving tomorrow would need it again. Mirrors
 * isPriceEstimated above, but over lib/kie/rates.ts's VIDEO_INPUT_PRICING
 * rather than a per-resolution RatePoint — see that constant's own comment
 * for what "published, not measured" means here. A caller pricing a scene
 * with one or more attached video references (referenceVideoInputSecondsS
 * on clipCostUsd below) owes the operator the same "estimated" label
 * isPriceEstimated already puts on a published per-second rate.
 */
export function isVideoInputPricingEstimated(): boolean {
  return VIDEO_INPUT_PRICING.provenance === "published";
}

/**
 * What one clip costs, end to end — the only function callers should use.
 *
 * kie bills exactly the seconds requested. There is no billed-seconds
 * multiplier here the way fal's Kling needed one (a 6s request there was
 * billed for 7.2 seconds) — every kie render measured so far has come back
 * billed, in credits, for precisely what was asked. So this is priceForSecond
 * times durationS, nothing more; the multiplication used to be spread
 * across three call sites that each had to agree with the other two about
 * the audio flag, which is exactly the kind of thing that drifts, so it
 * lives in one place instead.
 *
 * referenceVideoInputSecondsS ADDS TO durationS RATHER THAN REPLACING IT —
 * 0 for the overwhelming majority of clips, which carry no video reference
 * at all, so priceForSecond(...) * durationS is exactly what this returned
 * before this parameter existed. kie's own page states a video-conditioned
 * render is billed Price x (Input + Output), not Price x Output alone
 * (lib/kie/rates.ts's VIDEO_INPUT_PRICING carries the provenance for that
 * fact — PUBLISHED, not MEASURED, until a real one bills) — the SAME
 * per-second rate priceForSecond already returns, just multiplied by more
 * seconds, which is why this stays one multiplication rather than growing a
 * second rate lookup.
 *
 * Pass Number.POSITIVE_INFINITY here (never a guessed finite number) when
 * any attached video's own duration is unknown — lib/estimate.ts's
 * estimateCost does exactly that for a null assets.duration_s (an upload
 * whose browser could not decode its metadata; see
 * components/ugc-reference-picker.tsx's videoDurationSeconds), so a scene
 * priced with an unmeasured reference OVER-quotes without limit rather than
 * silently under-quoting the spend cap it is about to be checked against —
 * the same "unknown is not free" idiom priceForSecond already uses above for
 * a resolution/sound pair nobody has priced.
 */
export function clipCostUsd(
  model: VideoModelDescriptor,
  {
    resolution,
    durationS,
    audioOn = false,
    referenceVideoInputSecondsS = 0,
  }: {
    resolution: string;
    durationS: number;
    audioOn?: boolean;
    referenceVideoInputSecondsS?: number;
  },
): number {
  if (model.id === "gemini-omni-video") {
    if (!Number.isFinite(referenceVideoInputSecondsS)) return Number.POSITIVE_INFINITY;
    const credits = geminiOmniCredits(resolution, durationS, referenceVideoInputSecondsS > 0);
    return credits === null ? Number.POSITIVE_INFINITY : credits / CREDITS_PER_USD;
  }
  if (referenceVideoInputSecondsS > 0) {
    // A DIFFERENT TABLE, NOT THE SAME RATE OVER MORE SECONDS. This line used
    // to be one multiplication for both cases, on kie's published claim that
    // a video-conditioned render is simply Price x (Input + Output). The
    // structure was right and the price was not: seedance-2.5 480p bills 17
    // cr/s with a video attached against 28 without, measured 2026-09-10 (see
    // lib/kie/rates.ts's `video` table for the two receipts and the
    // isolation). Reusing the sound rate here overquotes by 65%.
    const rate = videoRateFor(model.id, resolution);
    // No fallback to the sound rate, deliberately — same refusal rateFor
    // gives, and for a sharper reason: the two rates are far enough apart
    // that a plausible wrong number here would block affordable renders at
    // the cap while looking like it worked.
    if (!rate) return Number.POSITIVE_INFINITY;
    return (
      (rate.creditsPerSecond / CREDITS_PER_USD) *
      (durationS + billedVideoInputSeconds(referenceVideoInputSecondsS))
    );
  }
  return priceForSecond(model, resolution, audioOn) * durationS;
}

/**
 * The input seconds kie actually bills for, from the seconds we measured.
 *
 * WHOLE SECONDS, ROUNDED DOWN. Both receipts carried a 4.064s video and both
 * land exactly on an input of 4: 17 x (4 + 4) = 136 and 17 x (4 + 8) = 204,
 * where 4.064 would have given 137.1 and 205.1. Credits are billed
 * fractionally elsewhere in this file (seedance-2-fast's 175.5), so this is
 * not a rounding artefact of the ledger — the input really is counted whole.
 *
 * WHAT THIS CANNOT TELL YOU is whether kie floors the duration or simply
 * decoded the file as 4.0 seconds where the browser read 4.064. Both produce
 * every number observed. Flooring is the conservative of the two only for
 * the bill; if kie in fact rounds, a 4.6s video would be quoted 4 and billed
 * 5. One video whose duration sits above .5 settles it.
 *
 * Infinity survives untouched: an unmeasurable duration must stay infinite
 * all the way into the cap check rather than collapsing to a finite guess.
 */
function billedVideoInputSeconds(measuredSecondsS: number): number {
  return Number.isFinite(measuredSecondsS) ? Math.floor(measuredSecondsS) : measuredSecondsS;
}

/**
 * Longest clip length (seconds) this fps is legal for, or null when the fps
 * carries no duration limit. Single source of any future fps/duration
 * cross-constraint for the UI, the server action and the tests — empty on
 * every current model (LTX's old 50fps/<=10s rule left with LTX).
 */
export function maxDurationForFps(model: VideoModelDescriptor, fps: number): number | null {
  return model.maxDurationSByFps[fps] ?? null;
}

/** True when `fps` may be used for a clip of `durationS` seconds on this model. */
export function isFpsAllowedForDuration(
  model: VideoModelDescriptor,
  fps: number,
  durationS: number,
): boolean {
  const max = maxDurationForFps(model, fps);
  return max === null || durationS <= max;
}

/**
 * Longest clip length (seconds) this resolution is legal for, or null when
 * the resolution carries no duration limit. The maxDurationForFps of the
 * resolution axis — empty on every current model (Hailuo's old "no 10s at
 * 1080P" rule left with the 1080P option it constrained).
 */
export function maxDurationForResolution(
  model: VideoModelDescriptor,
  resolution: string,
): number | null {
  return model.maxDurationSByResolution[resolution] ?? null;
}

/** True when `resolution` may be used for a clip of `durationS` seconds on this model. */
export function isResolutionAllowedForDuration(
  model: VideoModelDescriptor,
  resolution: string,
  durationS: number,
): boolean {
  const max = maxDurationForResolution(model, resolution);
  return max === null || durationS <= max;
}

// ---------------------------------------------------------------------------
// Per-project render settings (projects.render_settings jsonb)
// ---------------------------------------------------------------------------

export interface RenderSettings {
  model: string;
  resolution: string;
  fps: number;
}

/**
 * What an empty `{}` means. Kept as one object so the "absent key falls back
 * to the default" rule has exactly one implementation — 0012_render_settings.sql
 * deliberately stores `{}` as the column default rather than a populated
 * object so that new and existing rows both read through here.
 */
export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  model: DEFAULT_MODEL_ID,
  resolution: SEEDANCE_2_5.defaultResolution,
  fps: SEEDANCE_2_5.defaultFps,
};

/**
 * Field-level validation for a write to projects.render_settings.
 *
 * `resolution` and `fps` are validated against the selected model's own
 * allowed sets rather than a global list, which is the entire point of the
 * descriptor: adding a model with different fps options must not require
 * editing this schema. There is no "model must be enabled" check any more
 * — every entry in VIDEO_MODELS is selectable, full stop.
 *
 * The 50fps/<=10s cross-constraint LTX used to need is NOT here, because
 * that constraint left with LTX; see renderSettingsSchemaFor() for the
 * general mechanism it used to exercise.
 */
export const RenderSettingsSchema = z
  .object({
    model: z.string().default(DEFAULT_MODEL_ID),
    resolution: z.string().default(SEEDANCE_2_5.defaultResolution),
    fps: z.number().int().default(SEEDANCE_2_5.defaultFps),
  })
  .superRefine((value, ctx) => {
    const model = VIDEO_MODELS.find((candidate) => candidate.id === value.model);
    if (!model) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: `Unknown model "${value.model}". Known: ${VIDEO_MODELS.map((m) => m.id).join(", ")}.`,
      });
      return;
    }
    if (!model.allowedResolutions.includes(value.resolution)) {
      ctx.addIssue({
        code: "custom",
        path: ["resolution"],
        message: `${model.label} does not support ${value.resolution}. Allowed: ${model.allowedResolutions.join(", ")}.`,
      });
    }
    if (!model.allowedFps.includes(value.fps)) {
      ctx.addIssue({
        code: "custom",
        path: ["fps"],
        message: `${model.label} does not support ${value.fps} fps. Allowed: ${model.allowedFps.join(", ")}.`,
      });
    }
  });

/**
 * RenderSettingsSchema plus the cross-field constraints that need to know
 * how long this project's clips are. Every current model's
 * maxDurationSByFps/maxDurationSByResolution is empty, so this is
 * presently a no-op beyond RenderSettingsSchema's own checks — kept as the
 * general mechanism (rather than folded away) because the constraint is
 * data on the descriptor, so a model that adds one tomorrow is covered by
 * this without a code change here.
 *
 * `longestSceneS` is the project's longest scene duration. 0 (a project with
 * no scenes) makes every fps legal, which is correct: there is nothing to
 * render yet, and enqueueRender refuses an empty project anyway.
 */
export function renderSettingsSchemaFor(longestSceneS: number): z.ZodType<RenderSettings, unknown> {
  return RenderSettingsSchema.superRefine((value, ctx) => {
    const model = getModel(value.model);
    if (!isFpsAllowedForDuration(model, value.fps, longestSceneS)) {
      const max = maxDurationForFps(model, value.fps);
      ctx.addIssue({
        code: "custom",
        path: ["fps"],
        message:
          `${value.fps} fps is only valid for clips of ${max}s or shorter on ${model.label}, ` +
          `and this project's longest scene is ${longestSceneS}s. Shorten the scene or pick a lower fps.`,
      });
    }
    // Reported separately from the fps issue, and on its own path, because
    // they are two different fixes: one asks the operator to drop the frame
    // rate, this one asks them to drop the resolution. A settings object can
    // violate both at once, and collapsing them into a single message would
    // hide half of what has to change.
    if (!isResolutionAllowedForDuration(model, value.resolution, longestSceneS)) {
      const max = maxDurationForResolution(model, value.resolution);
      ctx.addIssue({
        code: "custom",
        path: ["resolution"],
        message:
          `${model.label} only accepts ${value.resolution} for clips of ${max}s or shorter, ` +
          `and this project's longest scene is ${longestSceneS}s. Shorten the scene or pick a lower resolution.`,
      });
    }
  });
}

/**
 * Matches `want` against `allowedResolutions` ignoring case and returns the
 * list's OWN spelling, never the caller's — the spelling every price lookup
 * and wire request expects. Mirrors worker/internal/kie/models.go's
 * canonicalResolution exactly, for the same reason it exists there: a
 * legacy row written before a resolution's current casing was fixed
 * ("480P"/"720P", Seedance's own spelling until commit 4ac10aa) must still
 * resolve to today's lowercase tier, not fall back to the model's default
 * because a byte-for-byte compare stopped matching.
 */
function canonicalResolution(allowedResolutions: readonly string[], want: string): string | null {
  for (const allowed of allowedResolutions) {
    if (allowed.toLowerCase() === want.toLowerCase()) {
      return allowed;
    }
  }
  return null;
}

/**
 * Reads the jsonb column into a fully-populated RenderSettings.
 *
 * Deliberately lenient where RenderSettingsSchema is strict, and for the
 * same reason getModel() falls back instead of throwing: this runs on every
 * page load against a column a direct SQL write can put anything into, and
 * a malformed blob must degrade to the defaults rather than take down the
 * render gate. Writes go through the strict schema; reads go through here.
 */
export function parseRenderSettings(raw: unknown): RenderSettings {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_RENDER_SETTINGS };
  }
  const record = raw as Record<string, unknown>;
  const model = getModel(typeof record.model === "string" ? record.model : undefined);

  // CASE-INSENSITIVE, resolving to the descriptor's own spelling — see
  // canonicalResolution's own doc comment above.
  const canonical =
    typeof record.resolution === "string"
      ? canonicalResolution(model.allowedResolutions, record.resolution)
      : null;
  const resolution = canonical ?? model.defaultResolution;

  const fps =
    typeof record.fps === "number" && model.allowedFps.includes(record.fps)
      ? record.fps
      : model.defaultFps;

  return { model: model.id, resolution, fps };
}

/**
 * THE merge. The TypeScript mirror of the SQL every worker query now runs
 * (0045_scene_render_settings_override.sql):
 *
 *   projects.render_settings || coalesce(scenes.render_settings_override, '{}'::jsonb)
 *
 * `projectRaw` is projects.render_settings; `overrideRaw` is that ONE
 * scene's scenes.render_settings_override — a partial object (typically
 * just {model}), or null when the scene has no override and inherits the
 * project's settings wholesale.
 *
 * This is the only place the merge is written on the web side, and every
 * pricing and spend-cap site in actions/enqueue.ts goes through it. That is
 * not tidiness: a scene overridden onto a model several times the project's
 * rate, priced at the project's rate, walks straight past
 * assertWithinSpendCaps and then spends real money above the ceiling the
 * operator set. A second, hand-rolled copy of this merge that drifts by one
 * key is that bug.
 *
 * Merges RAW and parses ONCE, rather than parsing each side and merging the
 * results — the order is load-bearing and matches SQL + the worker exactly.
 * parseRenderSettings resolves resolution/fps against the model it ends up
 * with, so merging first means an override that names only a model picks up
 * THAT model's defaults for any key the project's value is illegal for,
 * instead of carrying an unsupported resolution across. Parsing first would
 * bake the project's model's defaults into concrete values before the
 * override could redirect them, and the two languages would disagree about
 * a paid render's inputs.
 *
 * Shallow, same as jsonb's `||`. There are no nested keys in this object
 * and adding one would need this and the SQL changed together.
 */
export function mergeRenderSettings(projectRaw: unknown, overrideRaw: unknown): RenderSettings {
  const project =
    typeof projectRaw === "object" && projectRaw !== null && !Array.isArray(projectRaw)
      ? (projectRaw as Record<string, unknown>)
      : {};
  const override =
    typeof overrideRaw === "object" && overrideRaw !== null && !Array.isArray(overrideRaw)
      ? (overrideRaw as Record<string, unknown>)
      : {};

  return parseRenderSettings({ ...project, ...override });
}

/**
 * Field-level validation for a write to scenes.render_settings_override —
 * the partial counterpart of RenderSettingsSchema above.
 *
 * Only `model`. This is the RETRY path's shape: retryScene/retryAllFailed
 * answer "re-render these scenes on a different model" and have no
 * business touching resolution or fps.
 *
 * There is a SECOND writer to that column now, and it is not this schema.
 * actions/render-settings.ts's updateSceneRenderOverride writes the full
 * {model, resolution, fps} triple, because the operator picking a model in
 * a scene's header is choosing that scene's resolution too. So the claim
 * this comment used to make — that the per-scene column can never hold a
 * resolution the merged model does not support — is no longer how the
 * safety is achieved. It is achieved twice over instead: that action
 * validates through renderSettingsSchemaFor, which already refuses a
 * resolution outside the model's allowedResolutions, and parseRenderSettings
 * above falls back to the model's default for a stored value the model does
 * not accept. A bad pair is refused at the write, and survives a read.
 *
 * Reuse of the schema, not of a string: retryScene/retryAllFailed parse
 * with this before writing, so a bad model id is an operator-visible
 * refusal rather than a jsonb blob the worker later falls back out of.
 */
// .strict(), and it is a bug fix rather than tidiness.
//
// This schema describes the RETRY path's shape: model only. /ugc reused it to
// validate `{ model, resolution }`, and zod's default object parsing SILENTLY
// STRIPPED the resolution and still reported success. The clip was then
// written with no resolution at all, fell back to the model's default — the
// 480P tier lib/kie/offerable.ts exists specifically to refuse because nobody
// has been billed for it — and the spend cap checked that tier while the
// operator was quoted a different, receipt-backed one.
//
// A validator that answers "yes" to a shape it does not understand is worse
// than no validator. Unknown keys now fail loudly, so the next caller that
// reaches for the wrong schema finds out at the call site.
export const RenderSettingsOverrideSchema = z.strictObject({
  model: z.string().superRefine((value, ctx) => {
    // Gemini is accepted here only so the action-level receipt guard can
    // return its precise refusal. It is still not a generic picker model,
    // and no retry can persist it until a paid rate exists.
    const model =
      value === GEMINI_OMNI_VIDEO.id
        ? GEMINI_OMNI_VIDEO
        : value === GEMINI_OMNI_1_2.id
          ? GEMINI_OMNI_1_2
          : VIDEO_MODELS.find((candidate) => candidate.id === value);
    if (!model) {
      ctx.addIssue({
        code: "custom",
        message: `Unknown model "${value}". Known: ${VIDEO_MODELS.map((m) => m.id).join(", ")}.`,
      });
    }
  }),
});

export type RenderSettingsOverride = z.infer<typeof RenderSettingsOverrideSchema>;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Whether the render pickModel just resolved will be made with sound on.
 *
 * Split out because pickModel returns a descriptor and nothing else, while
 * separate callers need this same boolean to price a clip (kie's sound
 * table is a different rate, not a silent-rate-plus-surcharge) and to know
 * whether a clip will carry a spoken track at all. Deriving it
 * independently in each of them is how they drift.
 *
 * Only a nativeAudio model can produce sound, and only for a talking-head
 * scene, and only when the account has audio on. Every other combination is
 * silent — including a talking-head scene on Seedance, which has no audio
 * to generate.
 */
/**
 * Which rate table a clip should be PRICED from — a different question from
 * renderAudioOn above, which the estimate had been using for both.
 *
 * renderAudioOn is `model.nativeAudio && ...`, and nativeAudio is true only
 * for Kling. So it answers "does this clip get a lip-synced track", which is
 * a ROUTING fact. Every Seedance render this product makes sets
 * generate_audio true regardless — sound is not optional here — so pricing a
 * Seedance from the silent table described a render nobody has ever made.
 *
 * That was invisible while seedance-2.5 carried 28 cr/s in both tables. It
 * stopped being invisible when Seedance 2.0 and 2.0 Fast arrived priced only
 * under sound: the silent lookup found nothing, priceForSecond returned
 * +Infinity, and an operator picking 2.0 was told the kie account needed
 * funding while it held $89.
 *
 * PREFERS SOUND, FALLS BACK TO SILENT, and the fallback is the reason this
 * is a function rather than a hardcoded `true`. Where a sound rate exists it
 * is the truth about what we send. Where one does not — seedance 2.5 at 720p
 * and 1080p, whose receipts never recorded their audio mode — the silent
 * number is the only measurement that exists, and quoting it is exactly what
 * this product already did. So this changes 480p, which is what /ugc renders,
 * and leaves the higher tiers quoting precisely what they quoted before.
 *
 * It is deliberately NOT a fallback inside rateFor, which must keep answering
 * "has anyone priced this exact pair" with no substitution. This is a caller
 * choosing between two real answers, not a table inventing one.
 */
export function pricingAudioOn(
  model: VideoModelDescriptor,
  resolution: string,
  isTalkingHead: boolean,
  audioEnabled: boolean,
): boolean {
  // KLING IS THE EXCEPTION, and it is the whole reason this is not just
  // `true`. Kling genuinely renders both ways and kie charges two different
  // numbers for it — 18 cr/s silent against 27 with sound — so for a
  // native-audio model the routing answer IS the pricing answer, and a silent
  // cutaway must not be quoted at the spoken rate.
  if (model.nativeAudio) {
    return renderAudioOn(model, isTalkingHead, audioEnabled);
  }
  // Every other model here is a Seedance, and every Seedance render this
  // product makes sets generate_audio true. So the sound rate is the truth
  // wherever one exists; where none does, the silent number is the only
  // measurement there is and is what was already being quoted.
  return rateFor(model.id, resolution, true) !== null;
}

export function renderAudioOn(
  model: VideoModelDescriptor,
  isTalkingHead: boolean,
  audioEnabled: boolean,
): boolean {
  return model.nativeAudio && isTalkingHead && audioEnabled;
}

/**
 * Mirrors worker/internal/kie/models.go's PickModel: settings.model is
 * authoritative, full stop. A project whose render_settings.model has
 * never been touched (or explicitly names the default, SEEDANCE_2_5)
 * renders every scene on that silent default — is_talking_head has no
 * power to override that. Only a project that has explicitly selected
 * Kling can ever reach it, and even then only for the scenes Kling exists
 * for: talking-head scenes, with audioEnabled=true. A scene that doesn't
 * qualify — not talking-head, or audio off — falls back to Kling's own
 * SILENT rate rather than a different model now that kie prices a silent
 * Kling second honestly (see KLING_3_PRO's own doc comment): a Kling
 * project stays in one model family end to end, which is also what
 * template v10's Cross-Frame Rules exist to protect — a face is likeliest
 * to change at the seam between two different models.
 *
 * Deliberately still takes isTalkingHead and audioEnabled as parameters,
 * even though which DESCRIPTOR this returns no longer depends on either —
 * PickModel's Go counterpart still takes both, to decide whether the
 * request it builds carries sound, and every caller here already has both
 * values in hand. Use renderAudioOn above for that half of the same
 * decision; this function answers only "which descriptor."
 *
 * Unknown is not fal any more, so there is no "disabled descriptor, fall
 * back to the safe default" branch left to take either — getModel(id)
 * already resolves an unrecognised or removed id to SEEDANCE_2_5 on its
 * own (a hand-written SQL update is the only way to reach one; see that
 * function's own doc comment), and every id VIDEO_MODELS does recognise is
 * unconditionally selectable. So this is now, honestly, a direct call.
 */
export function pickModel(
  _isTalkingHead: boolean,
  _audioEnabled: boolean,
  settings: Pick<RenderSettings, "model">,
): VideoModelDescriptor {
  return getModel(settings.model);
}

/**
 * The resolution a render at `model` will actually price and submit at,
 * given a `resolution` that may not be one of that model's OWN tiers.
 *
 * Mirrors worker/internal/kie/models.go's standardModel: `containsString`
 * against the descriptor's own list, falling back to its default rather
 * than trusting the caller. Added 2026-09-10 alongside Kling's second
 * resolution tier (std/720p beside pro/1080p) — before that, every model's
 * resolution reaching a pricing call site had already been validated this
 * same way, once, by parseRenderSettings/mergeRenderSettings, so a second
 * check here would have been redundant everywhere it mattered and nowhere
 * it didn't. It stopped being redundant the moment Kling's nativeAudio
 * route (nativeAudioModel's Go counterpart, and this file's own pickModel
 * above) could no longer just hand back its DefaultResolution unconditionally
 * — see worker/internal/kie/models.go's nativeAudioModel doc comment for the
 * bug this closes: a project saved at std/720p would have silently
 * rendered, and billed, at pro/1080p. Caught in review, not in production —
 * it never shipped.
 *
 * Every OTHER model was already safe without this — their resolution is
 * validated at read time the same way — but calling it explicitly at every
 * site that prices a render, rather than trusting each caller to have gone
 * through that path, is the same belt-and-braces the worker's own
 * standardModel keeps for the identical reason.
 */
export function billingResolution(model: VideoModelDescriptor, resolution: string): string {
  return model.allowedResolutions.includes(resolution) ? resolution : model.defaultResolution;
}

// --- Image models the Image Generator may offer ----------------------------

/**
 * One selectable image model, priced from a receipt or a published fixed rate.
 *
 * Most costUsd values below are kie's own creditsConsumed from a real paid call at
 * kie's published $0.005/credit, measured with scripts/measure-image-model.ts
 * (receipt dates are recorded per model). Published fixed rates are also sold
 * under the owner's 2026-10-30 decision. The number here goes straight
 * into the reservation, the spend cap and /spend, so a guess would be wrong in
 * three places at once.
 */
export interface ImageModelDescriptor {
  /** Stable value for the picker and the form field. Not a kie id. */
  id: string;
  label: string;
  /** kie's id for a prompt-only call. */
  textToImageId: string;
  /**
   * kie's id for an offerable reference-conditioned call, or null when
   * unavailable. referenceDisabledReason explains a measured limitation.
   *
   * null is load-bearing, not a gap in the table. The base text-to-image
   * endpoints SILENTLY IGNORE image_urls (see lib/kie.ts's header), so a model
   * with no edit variant cannot carry an @tag or a chained sequence beat at
   * all — the references would vanish and the operator would be told nothing.
   * Callers must refuse that combination rather than send it.
   */
  editId: string | null;
  /** Why references are unavailable when an existing endpoint cannot be offered. */
  referenceDisabledReason?: string;
  /** Null keeps an unpriced model visible but unavailable. */
  costUsd: number | null;
  aspectRatios: readonly ImageAspectRatio[];
  /**
   * The pixel tiers kie offers for this model, from its docs, `1K` first.
   * Absent means kie documents none (google/nano-banana) and the picker shows
   * no control. Seedream's 1K/2K are BytePlus pixel sizes (lib/byteplus-image.ts).
   */
  resolutions?: readonly ImageResolutionId[];
  /**
   * What a tier above 1K costs. `costUsd` is the 1K receipt; these are kie's
   * PUBLISHED per-tier prices (owner's decision 2026-10-30 to trust kie's
   * docs, read from each model's kie.ai pricing card that day — every 1K on
   * those cards matched our receipt). An offered tier with no entry here shows
   * as "pricing pending" and is refused server-side, the same rule a model
   * with `costUsd: null` follows.
   */
  resolutionCostsUsd?: Partial<Record<Exclude<ImageResolutionId, "1K">, number>>;
  /** Observed wall-clock for one TEXT-TO-IMAGE call, against lib/kie.ts's 100s poll budget. */
  observedSeconds: number | null;
  /**
   * Observed wall-clock for the REFERENCE-CONDITIONED call, when it differs
   * enough to change the answer. Falls back to observedSeconds when unset.
   *
   * This field exists because its absence cost real money. `observedSeconds`
   * was read as "how long this model takes", but it only ever recorded the
   * text-to-image path, and one model's image-to-image path ran about
   * 1.6x longer — 91.9s measured one way, 131-149s the other. The model was
   * therefore offered as comfortably inside the 100s budget while its reference
   * path could not fit in it at all, and every @tagged or chained generation
   * timed out, held as billing-unknown, and charged $0.0375 for an image nobody
   * collected. Three in one hour.
   */
  editObservedSeconds?: number | null;
}

/**
 * NANO BANANA PRO IS DELIBERATELY ABSENT, and this is where to read why before
 * adding it back.
 *
 * It exists and it works: `nano-banana-pro`, measured 2026-09-06 at 18 credits
 * = $0.09. It took 162.9 SECONDS. lib/kie.ts's poll budget is 100s, and that
 * number is not arbitrary — its own comment explains it is chosen to beat the
 * platform proxy, which cuts a blocked request somewhere in the 30-100s range.
 * Raising the budget does not help; the proxy kills the request either way.
 *
 * Offered today it would time out EVERY time, hold as billing-unknown, and
 * charge $0.09 for no image — a control that looks like a feature and silently
 * bills. It becomes offerable when generation moves to the background/webhook
 * path lib/kie.ts already names as the real fix, and not before.
 */
export const IMAGE_MODELS: readonly ImageModelDescriptor[] = [
  // Plain Nano Banana is no longer offered here (owner, 2026-11-10). Its kie ids stay in
  // lib/kie.ts: the frame and character flows still call generateImage without a model.
  {
    id: "seedream-5.0-pro",
    label: "Seedream 5.0 Pro",
    // BytePlus ModelArk only (lib/byteplus-image.ts), so its faces pass Seedance 2.5.
    // One id for both paths: references travel in the same request's `image` field.
    textToImageId: SEEDREAM_PRO_ID,
    editId: SEEDREAM_PRO_ID,
    // BytePlus's published price per output image; no receipt, because BytePlus reports
    // an image count, not dollars (owner's 2026-10-30 rule allows the published rate).
    costUsd: 0.045,
    // Largest of three text-to-image calls on 2026-11-09 (33-42s). The reference path is
    // unmeasured and falls back to this; byteplus-image.ts gives up at 90s.
    observedSeconds: 42,
    aspectRatios: SEEDREAM_PRO_ASPECT_RATIOS,
    resolutions: ["1K", "2K"],
    resolutionCostsUsd: { "2K": 0.09 },
  },
  // The three below are MEASURED, 2026-10-25, with scripts/measure-image-model.ts
  // at 9:16 and the 1K tier the builders send: one real call per path, both
  // paths billed the same, and every figure matched kie's published price.
  // One sample per path, so a time is a single reading, not a worst case.
  {
    id: "nano-banana-2-1",
    label: "Nano Banana 2.1",
    textToImageId: NANO_BANANA_2_1_ID,
    editId: NANO_BANANA_2_1_ID,
    // 4 credits both paths (tasks 381e5efe…, 70a2fa71…).
    costUsd: 0.02,
    observedSeconds: 24.3,
    editObservedSeconds: 38.4,
    aspectRatios: IMAGE_ASPECT_RATIOS,
    resolutions: ["1K", "2K", "4K"],
    // kie.ai/nano-banana-2-1: 6 credits at 2K, 9 at 4K.
    resolutionCostsUsd: { "2K": 0.03, "4K": 0.045 },
  },
  {
    id: "gpt-image-2.5-flare",
    label: "ChatGPT 2.5 Flare",
    textToImageId: GPT_IMAGE_2_5_IDS.flare.text,
    editId: GPT_IMAGE_2_5_IDS.flare.edit,
    // 6 credits both paths (tasks 437032f4…, 3dbe6653…).
    costUsd: 0.03,
    observedSeconds: 49.9,
    editObservedSeconds: 30,
    aspectRatios: GPT_IMAGE_2_5_ASPECT_RATIOS,
    resolutions: ["1K", "2K", "4K"],
    // kie.ai/gpt-image-2-5 (Flare and Sunburst share it): 10 credits at 2K, 16 at 4K.
    resolutionCostsUsd: { "2K": 0.05, "4K": 0.08 },
  },
  {
    id: "gpt-image-2.5-sunburst",
    label: "ChatGPT 2.5 Sunburst",
    textToImageId: GPT_IMAGE_2_5_IDS.sunburst.text,
    editId: GPT_IMAGE_2_5_IDS.sunburst.edit,
    // 6 credits both paths (tasks 3bb755ca…, 44b4a492…). 59.2s on the
    // reference path is inside blocksInline's 80s, but with the least margin
    // of any model here.
    costUsd: 0.03,
    observedSeconds: 53.2,
    editObservedSeconds: 59.2,
    aspectRatios: GPT_IMAGE_2_5_ASPECT_RATIOS,
    resolutions: ["1K", "2K", "4K"],
    // kie.ai/gpt-image-2-5 (Flare and Sunburst share it): 10 credits at 2K, 16 at 4K.
    resolutionCostsUsd: { "2K": 0.05, "4K": 0.08 },
  },
  {
    id: "gpt-image-2.6-economy",
    label: "ChatGPT 2.6 Economy",
    textToImageId: GPT_IMAGE_2_6_ECONOMY_TEXT,
    editId: GPT_IMAGE_2_6_ECONOMY_EDIT,
    // Kie's published flat 1K price, 2026-11-10; no paid timing receipt yet.
    costUsd: 0.025,
    observedSeconds: null,
    aspectRatios: IMAGE_ASPECT_RATIOS,
    resolutions: ["1K"],
  },
];

export const DEFAULT_IMAGE_MODEL_ID = "nano-banana-2-1";

/**
 * Resolves a picker value to its descriptor, falling back to the default.
 *
 * Falls back rather than throwing for the same reason parseCompilerModel does:
 * the value arrives from a form, and an unknown one should generate a
 * correctly-priced default image rather than 500 at someone mid-flow.
 */
export function getImageModel(id: unknown): ImageModelDescriptor {
  const found = typeof id === "string" ? IMAGE_MODELS.find((m) => m.id === id) : undefined;
  return found ?? IMAGE_MODELS.find((m) => m.id === DEFAULT_IMAGE_MODEL_ID)!;
}

/**
 * The kie id for this model given whether references are attached, or null if
 * the combination is impossible.
 *
 * null means "refuse", never "send it anyway and hope": a base endpoint handed
 * image_urls drops them without erroring, so the caller would pay for a picture
 * that ignored every reference it was given.
 */
export function kieIdForImageModel(model: ImageModelDescriptor, hasRefs: boolean): string | null {
  if (!hasRefs) return model.textToImageId;
  return model.editId;
}

/** Observed wall-clock for the path this call will actually take. */
export function observedSecondsForPath(
  model: ImageModelDescriptor,
  hasRefs: boolean,
): number | null {
  if (!hasRefs) return model.observedSeconds;
  return model.editObservedSeconds ?? model.observedSeconds;
}

/**
 * Whether a request may BLOCK waiting for this model, or must submit and hand
 * the task off to the recovery panel instead.
 *
 * The rule this encodes is already written down two ways in this codebase and
 * was enforced neither time. IMAGE_MODELS' own header explains that Nano Banana
 * Pro is withheld because 162.9s "would time out EVERY time, hold as
 * billing-unknown, and charge $0.09 for no image — a control that looks like a
 * feature and silently bills", and lib/kie.ts's poll-budget block explains that
 * raising the budget cannot fix that, because the platform cuts the request
 * anyway and the operator then gets a gateway timeout carrying no task id.
 *
 * So a call whose measured duration does not fit the budget does not wait for
 * it. It submits, persists the task id, and returns at once; the attempt panel
 * finishes it by task id (actions/image-generator.ts's recovery section) with no
 * second submission and no second charge. Blocking for 100s to learn what is
 * already known — that this model takes 149 — buys nothing but the wait.
 *
 * A model with NO measured time still blocks: an unmeasured model is the one
 * case where waiting is how the number gets discovered.
 *
 * The 0.8 margin is for variance, not caution theatre. Three receipts of one
 * reference path spanned 131-149s, an 18s spread on a 140s mean, so a path measured just
 * under the budget will sometimes land just over it.
 */
export function blocksInline(model: ImageModelDescriptor, hasRefs: boolean): boolean {
  const seconds = observedSecondsForPath(model, hasRefs);
  if (seconds === null) return true;
  return seconds * 1000 < KIE_POLL_BUDGET_MS * 0.8;
}

/**
 * What one image costs at a tier, or null when no one has been billed at it.
 * The base tier is the model's own `costUsd`; a model with no `resolutions`
 * has only that.
 */
export function imageCostUsd(
  model: ImageModelDescriptor,
  resolution: ImageResolutionId = BASE_IMAGE_RESOLUTION,
): number | null {
  if (resolution === BASE_IMAGE_RESOLUTION) return model.costUsd;
  if (!model.resolutions?.includes(resolution)) return null;
  return model.resolutionCostsUsd?.[resolution as Exclude<ImageResolutionId, "1K">] ?? null;
}
