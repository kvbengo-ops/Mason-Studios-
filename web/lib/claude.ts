// The prompt compiler (see docs/architecture.md § "The prompt compiler").
//
// Splits a raw ad script into a structured shot brief via Claude structured
// outputs. This is the highest-value, only-thinking component of the
// pipeline — everything downstream is CRUD.
//
// MODE=development short-circuits the real API call with a deterministic
// fixture brief, the same switch that keeps image and video generation
// testable without spending real money (lib/mode.ts). This is what makes
// `pnpm test` and UI work free.
//
// Pure cost estimation (estimateCost/EstimatableBrief/CostEstimate) used to
// live in this file too, but it was the one thing here Client Components
// legitimately needed — and because estimateCost was reachable from this
// module's exports, importing it dragged `@anthropic-ai/sdk` and zod into
// the browser bundle right along with it (an ES module's top-level imports
// all load whenever anything in the file is imported, used or not). That
// surface now lives in lib/estimate.ts, which imports nothing server-only.
// See that file's header for the full story.

// Guards the mistake above from regressing: any attempt to import this file
// from a Client Component (directly, or transitively through one) now fails
// the build instead of silently shipping the Anthropic SDK to the browser.
// Must be the first import — see https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns#keeping-server-only-code-out-of-the-client-environment.
import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { describeRoleLine } from "./describe-role-line";
import { isDev } from "./mode";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { UNIVERSAL_DURATIONS_S, defaultCompilerModelId } from "./models";
import {
  DEFAULT_DIRECTION,
  type ProjectDirection,
  type ShootingMode,
  type UgcStyle,
} from "./direction";
import type { ScriptRow } from "./script-columns";

/** The constant `runs.vendor` value for every compile this module performs. */
export const CLAUDE_VENDOR = "anthropic";

/**
 * The model compileBrief/compileScene use when no `model` argument is
 * passed — every actions/brief.ts (Apply/Split) call today, and every
 * scripts/compile.ts CLI invocation. actions/compile.ts's full-script
 * compile no longer falls through to this: it reads the project's own
 * chosen compiler model (lib/models.ts's parseCompilerModel) and always
 * passes `model` explicitly, so this function's CLAUDE_MODEL default never
 * applies there.
 *
 * Delegates to lib/models.ts's defaultCompilerModelId() rather than reading
 * process.env.CLAUDE_MODEL directly — that function is what stops an env
 * var naming a disabled descriptor (or a typo, or nothing at all) from
 * becoming a hard override; see its own doc comment for the exact rule
 * (mirrors pickModel's "settings.model is authoritative, disabled never
 * sneaks through" for the video side). Exported under this name still, so a
 * caller recording a `runs.model` value (actions/brief.ts) names the model
 * that actually ran instead of a second, separately-maintained guess.
 */
export function defaultClaudeModel(): string {
  return defaultCompilerModelId();
}

export const Brief = z.object({
  character: z
    .string()
    .describe("One sentence: face, age, clothing, setting. Identical across all scenes."),
  scenes: z.array(
    z.object({
      script_line: z.string(),
      video_prompt: z.string(),
      is_talking_head: z.boolean(),
      // The intersection of every ENABLED model's allowedDurationsS
      // (models.ts's UNIVERSAL_DURATIONS_S), not the default model's own
      // set. The observation the old comment here got right is that
      // compilation happens before the operator reaches the render gate, so
      // there is no per-project model choice to read yet. The conclusion it
      // drew from that — pin to the default model — is what broke: a brief
      // compiled against LTX's 6-20 becomes unrenderable the instant anyone
      // picks Kling or Seedance Mini, which both stop at 15s, and an editor
      // hit exactly that on a Seedance test render fal refused. Generating
      // what every selectable model accepts makes the brief survive any
      // choice made later, which is the only thing that can be true at a
      // point where the choice hasn't been made. See UNIVERSAL_DURATIONS_S
      // for what this gives up (LTX's 16, 18, 20).
      //
      // Enforcing it as a literal enum, not a range check, matters here:
      // this schema feeds zodOutputFormat() for Claude's structured-output
      // mode, so a tighter schema actually steers what the model generates
      // instead of just validating it after the fact. That is also why the
      // descriptor is declared `as const satisfies` — the literals have to
      // survive into the type for this to work.
      duration_s: z
        .literal(UNIVERSAL_DURATIONS_S)
        .describe(
          `Clip length in seconds. Must be exactly one of ${UNIVERSAL_DURATIONS_S.join(", ")} ` +
            "— fal's video models reject any other value. Prefer fewer, longer scenes over " +
            "many short ones to fit this constraint.",
        ),
      // SMN-feature-spec.md §3.3's per-scene visual idea (see
      // buildVisualIdeaRowsBlock below). Optional/nullable, not required
      // like the other four fields: most compiles never send an
      // "Operator-authored visual ideas" section at all (single-column
      // script, or Include Visual Idea unchecked), and the field must stay
      // absent-safe for every hand-built fixture (mockBrief, and every
      // Brief literal in claude.test.ts) that predates this feature and
      // never set it.
      //
      // This is Claude ECHOING BACK which operator-authored idea (if any)
      // shaped this scene, not something we ask it to invent — the compiler
      // is the one place that knows how script lines merged into this
      // scene, so it is also the only place that can say which of possibly
      // several source rows' visual ideas actually applies. Apply/Split
      // (actions/brief.ts) must NOT trust this echo as authoritative for a
      // scene that already has a stored visual_idea, for the same reason
      // preserveTalkingHead (lib/talking-head.ts) overrides is_talking_head
      // after every regenerate rather than trusting the model to reproduce
      // an operator's existing choice — see that file's doc comment.
      visual_idea: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Only set when the user message's 'Operator-authored visual ideas' section " +
            "includes a row whose visual idea shaped THIS scene's video_prompt. Echo that " +
            "row's visual idea back here, verbatim. If this scene merges multiple rows with " +
            "different visual ideas, echo the one that most shaped this scene's shot. Leave " +
            "null when no such section was present, or no row in it applies to this scene.",
        ),
    }),
  ),
});

export type Brief = z.infer<typeof Brief>;

export interface CompileBriefArgs {
  script: string;
  characterDesc?: string;
  /**
   * projects.product_name (spec §3.2, e.g. "NeuroBlast SMN16-18"). Passed
   * through so scenes can refer to the product by name instead of a
   * generic "the product" — same treatment as characterDesc just above.
   */
  productName?: string;
  /**
   * Whether the project has a product to sell on screen at all — true when
   * either productName is set OR a product_ref/composite_ref asset has
   * been uploaded (see actions/compile.ts's projectHasProduct). A project
   * can have a product photo with no name typed in yet, so this can't be
   * derived from productName alone, and it must be passed explicitly
   * rather than left for the compiler to infer from the script text: the
   * incident that added this field was a three-scene coffee ad that came
   * back all talking-head with the product never shown, because nothing
   * told Claude a product image even existed to put on screen. Defaults to
   * false so scripts/compile.ts (the CLI, which has no project row to
   * check assets against) keeps working unchanged.
   */
  hasProduct?: boolean;
  /**
   * projects.product_appearance — the operator's own free-text description
   * of what the product physically looks like (form/material, colour,
   * label treatment). The compiler never sees a reference image, only
   * `product_name`, so a scene that needs to show the product has nothing
   * to render it from and invents packaging — the incident that added this
   * field was Kinoko coffee's green pouch coming back as a generic jar or
   * bottle, typed in by hand after the fact, twice, in two different
   * projects, because nothing upstream told Claude what the product looked
   * like. Threaded through as its own section (see buildProductAppearanceSection)
   * rather than folded into productName, since the two answer different
   * questions: productName is a name to say, this is a constraint on what
   * to draw. Omitted entirely when unset or blank — see
   * buildProductAppearanceSection's own doc comment for why an empty
   * description must not become an empty or placeholder line.
   */
  productAppearance?: string;
  /** The system prompt body, from prompt_templates — caller fetches it. */
  templateBody: string;
  model?: string;
  /**
   * The seven directorial inputs from projects.{shooting_mode,...}
   * (0013_project_direction.sql / SMN-feature-spec.md §3.1, §3.3).
   * Defaults to DEFAULT_DIRECTION so scripts/compile.ts (the CLI, which
   * has no project row to read these from) keeps working unchanged.
   */
  direction?: ProjectDirection;
  /**
   * The operator's two-column Script | Visual Idea input, parsed by
   * lib/script-columns.ts's parseTwoColumnScript (spec §3.3's `Include
   * Visual Idea` control: "keep your own visual directions and have Claude
   * EXPAND each into a full prompt instead of inventing its own").
   *
   * Deliberately NOT gated by the caller — pass the full parse result
   * whenever one exists, whether or not direction.include_visual_idea is
   * true. compileBrief itself checks that flag (see finalize/the
   * `Operator-authored visual ideas` section below) before using it, the
   * same way it — not the caller — already decides whether ugc_style or
   * voice_profile are "set." A single place deciding "does this project's
   * visual-idea data actually apply right now" means a caller can never
   * forget to check the toggle and leak per-line ideas into a compile that
   * asked to have them ignored.
   *
   * `script` above stays the plain script text sent to Claude regardless —
   * see actions/compile.ts's own responsibility to rebuild a clean,
   * delimiter-free `script` from these same rows via
   * lib/script-columns.ts's scriptTextFromRows before calling this
   * function. compileBrief does not do that rebuild itself: `script` and
   * `scriptRows` are independent inputs on purpose, so a caller with no
   * two-column data (every project before this feature, and every
   * scripts/compile.ts CLI invocation) is byte-for-byte unaffected by this
   * field's mere existence.
   */
  scriptRows?: ScriptRow[];
}

/**
 * Renders the operator's own per-line visual ideas as a numbered block
 * appended to compileBrief's user message — the per-scene counterpart to
 * buildDirectionBlock's project-wide `visual_idea` line just above. Only
 * rows that actually carry a visual idea are listed: a row with none gets
 * no line here, so the compiler falls back to writing that row's contribution
 * to a scene exactly the way §3 of the template already does without this
 * feature.
 *
 * Returns "" when there is nothing to say (no row has a visual idea) so the
 * caller can omit the section entirely rather than send an empty header —
 * same convention as buildDirectionBlock's per-field omission.
 */
export function buildVisualIdeaRowsBlock(rows: readonly ScriptRow[]): string {
  const withIdeas = rows.filter((row) => row.visualIdea !== null);
  if (withIdeas.length === 0) {
    return "";
  }
  return withIdeas
    .map(
      (row, i) =>
        `${i + 1}. SCRIPT: ${row.script.length > 0 ? row.script : "(no dialogue — visual-only beat)"}\n` +
        `   VISUAL IDEA: ${row.visualIdea}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Directorial inputs — prompt assembly
// ---------------------------------------------------------------------------

const SHOOTING_MODE_HINTS: Record<ShootingMode, string> = {
  selfie: "front camera, handheld with natural shake, direct eye contact with the lens",
  static: "propped phone, both hands free, stable/locked-off framing unless overridden below",
  mirror:
    "handheld rear camera pointed at a mirror, the phone and the hand holding it visible in " +
    "frame, shake always present",
};

const UGC_STYLE_HINTS: Record<Exclude<UgcStyle, "auto">, string> = {
  talking_head: "every talking scene should read as a direct-to-camera creator monologue",
  voiceover: "prefer narration over B-roll/product footage rather than direct-to-camera delivery",
  b_roll: "prefer cutaway, product, and hands-only footage over direct-to-camera delivery",
  testimonial: "structure scenes as a first-person testimonial recounting a personal result",
  unboxing: "structure scenes around opening and revealing the product for the first time",
};

/**
 * Renders the operator's directorial choices as labeled lines appended to
 * the compiler's user message (see compileBrief). These are creative
 * instructions that need Claude to actually write prose around them
 * (camera language, tone, scene structure), which is why they travel as
 * user content rather than being spliced into scenes after the fact — see
 * applyCameraMovementOverride and applyPronunciationGuide below for the
 * two directives handled the opposite way, and why.
 *
 * `camera_movement` is deliberately NOT rendered here: it is a
 * deterministic text patch applied to the compiled output in
 * applyCameraMovementOverride, not a request for Claude to remember to
 * mention shake. Same for `pronunciation_guide` — see
 * applyPronunciationGuide. Both need to be correct every time, and
 * "correct every time" is not a property an LLM instruction can promise.
 *
 * Fields left at their default (empty string / 'auto') are omitted rather
 * than sent as empty/placeholder lines, so a project with no direction set
 * compiles against the same prompt shape v3 already used.
 */
export function buildDirectionBlock(direction: ProjectDirection): string {
  const lines: string[] = [
    `Shooting mode: ${direction.shooting_mode} — ${SHOOTING_MODE_HINTS[direction.shooting_mode]}.`,
  ];

  if (direction.visual_idea.trim().length > 0) {
    lines.push(
      "Visual idea (global override — apply to every scene; this takes precedence over the " +
        `default camera guidance for the shooting mode above): ${direction.visual_idea.trim()}`,
    );
  }

  if (direction.voice_profile.trim().length > 0) {
    lines.push(`Voice profile: ${direction.voice_profile.trim()}`);
  }

  if (direction.ugc_style !== "auto") {
    lines.push(`UGC style: ${direction.ugc_style} — ${UGC_STYLE_HINTS[direction.ugc_style]}.`);
  }

  return lines.join("\n");
}

// The exact, greppable Camera phrase prompt_templates v7+ (§3, §5) requires
// Claude to write for `static` shooting mode. It exists purely so the
// replacement branch below has something deterministic to find — see that
// branch's doc comment for why this had to become an exact string instead
// of v6's free-form "static tripod, slow push-in, handheld, slight pan,
// locked-off" menu.
const STATIC_CAMERA_PHRASE = "static tripod, locked-off framing";

// Handheld replacement clause: same content as the old prepended OVERRIDE
// (organic sway, micro-jitter, breathing wobble, handheld, never mounted or
// locked-off), but phrased to drop into the sentence in place of
// STATIC_CAMERA_PHRASE rather than argue with it from the front of the
// prompt.
const HANDHELD_CAMERA_CLAUSE =
  "deliberate handheld camera movement: organic sway, micro-jitter, breathing wobble, as if " +
  "held by hand, never mounted or locked-off";

const CAMERA_MOVEMENT_OVERRIDE =
  "OVERRIDE: ignore any static/propped-phone framing language elsewhere in this description — " +
  "this shot uses deliberate handheld camera movement: organic sway, micro-jitter, breathing " +
  "wobble, as if held by hand, never mounted or locked-off. ";

/**
 * Patches camera_movement into every scene's video_prompt, rather than
 * asking Claude to honor it. Per the spec (§3.1): "Forces handheld
 * camera-shake... on every static-mode veo3_prompt." That is a description
 * of a deterministic string operation, not a generation instruction — the
 * whole reason to do it in code is that a static-mode compile already
 * teaches Claude to write locked-off camera language (see prompt_templates
 * v3+), and a request buried among many others in the system prompt is not
 * guaranteed to overrule language the same prompt just told Claude to
 * write. A deterministic patch on every scene is.
 *
 * Two branches, in order of preference:
 *
 * 1. REPLACE (v7+ compiles): prompt_templates v7 (§3, §5) requires Claude
 *    to write the static-mode Camera attribute as the exact phrase
 *    STATIC_CAMERA_PHRASE. When a scene's video_prompt contains it, every
 *    occurrence is replaced with HANDHELD_CAMERA_CLAUSE. This produces one
 *    camera directive in the final prompt instead of two disagreeing ones
 *    — the bug this function used to cause: v6 and earlier told Claude to
 *    defer to "a camera-movement override clause already present at the
 *    start of a scene's context," which cannot exist at generation time
 *    (this function only ever runs AFTER Claude responds), so Claude's own
 *    locked-off language and this function's prepended OVERRIDE ended up
 *    contradicting each other in the same prompt.
 * 2. PREPEND (fallback): when the exact phrase is absent — a scene
 *    compiled against prompt_templates v6 or earlier still sitting in the
 *    database (recompiling refuses once a project leaves draft/frame_ready,
 *    see lib/recompile-guard.ts, so old briefs persist indefinitely), or
 *    Claude deviating from §3's instruction on a v7+ compile — fall back to
 *    the original prepend behavior unchanged. This keeps a pre-v7 brief
 *    exactly as correct as it is today; it never regresses.
 * 3. REPLACE **and** PREPEND: replacement only governs the phrase it
 *    replaces, and v7 pins the Camera attribute alone. §5 still teaches
 *    Claude that `static` means "propped phone, both hands free,
 *    stable/locked-off framing", so that wording can appear in a scene's
 *    Subject or Action prose too. When it survives there, the OVERRIDE
 *    sentence goes back on the front to arbitrate — see applyHandheldPatch
 *    and RESIDUAL_STATIC_LANGUAGE. Dropping it in that case would leave a
 *    quieter version of the contradiction this whole change removes.
 *
 * No-op unless shooting_mode is 'static' and camera_movement is true —
 * which DirectionSchema already guarantees for any value that reached the
 * database (see lib/direction.ts), but this function does not trust that
 * and re-checks shooting_mode itself so a caller that builds a
 * ProjectDirection by hand (e.g. a test) can't accidentally apply a
 * static-only override under selfie/mirror.
 */
// Static-framing words that, if they survive OUTSIDE the pinned Camera
// phrase, still contradict a handheld replacement. Template v7 only pins the
// **Camera** attribute; §5 still describes `static` mode to Claude as "propped
// phone, both hands free, stable/locked-off framing", so that language can
// legitimately turn up in a scene's Subject or Action prose — "she props her
// phone against the kettle" — where replacing the Camera attribute alone
// leaves nothing to arbitrate between the two.
const RESIDUAL_STATIC_LANGUAGE = /\b(propped|props|tripod|locked[- ]off|mounted|stationary)\b/i;

/**
 * Applies the handheld patch to one scene's video_prompt.
 *
 * Replacement is preferred (one camera directive, no contradiction), but it
 * only governs the phrase it replaces. When static-framing language survives
 * elsewhere in the prompt, the OVERRIDE sentence goes back on the front — it
 * exists precisely to arbitrate, and a prompt saying "handheld" in one clause
 * and "propped phone" in another needs an arbiter more than it needs brevity.
 *
 * The residual check runs against the ORIGINAL prompt with the pinned phrase
 * stripped out, never against the replaced text: HANDHELD_CAMERA_CLAUSE itself
 * ends "never mounted or locked-off", so scanning the output would match every
 * single time and silently turn this back into an unconditional prepend.
 */
function applyHandheldPatch(videoPrompt: string): string {
  if (!videoPrompt.includes(STATIC_CAMERA_PHRASE)) {
    // Pre-v7 brief, or Claude deviating from §3 — fall back to the original
    // prepend, unchanged.
    return `${CAMERA_MOVEMENT_OVERRIDE}${videoPrompt}`;
  }

  const replaced = videoPrompt.split(STATIC_CAMERA_PHRASE).join(HANDHELD_CAMERA_CLAUSE);
  const outsideThePinnedPhrase = videoPrompt.split(STATIC_CAMERA_PHRASE).join(" ");

  return RESIDUAL_STATIC_LANGUAGE.test(outsideThePinnedPhrase)
    ? `${CAMERA_MOVEMENT_OVERRIDE}${replaced}`
    : replaced;
}

export function applyCameraMovementOverride(brief: Brief, direction: ProjectDirection): Brief {
  if (direction.shooting_mode !== "static" || !direction.camera_movement) {
    return brief;
  }
  return {
    ...brief,
    scenes: brief.scenes.map((scene) => ({
      ...scene,
      video_prompt: applyHandheldPatch(scene.video_prompt),
    })),
  };
}

/** One `Word → phonetic` line from a pronunciation_guide. */
interface PronunciationEntry {
  word: string;
  phonetic: string;
}

/**
 * Parses pronunciation_guide's "one word per line, Word → phonetic"
 * format (spec §3.3). Tolerant of a plain "->" as well as "→", and of
 * blank lines, since this is operator-typed free text — see the UI
 * placeholder in components/character-setup-form.tsx's DirectionDetailFields
 * for the format shown to the operator.
 */
function parsePronunciationGuide(guide: string): PronunciationEntry[] {
  const entries: PronunciationEntry[] = [];
  for (const line of guide.split("\n")) {
    const match = line.match(/^\s*(.+?)\s*(?:→|->)\s*(.+?)\s*$/);
    if (!match) continue;
    const [, word, phonetic] = match;
    if (word && phonetic) {
      entries.push({ word, phonetic });
    }
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Appends each guided word's phonetic in brackets after the word's FIRST
 * occurrence in that scene's `script_line` (spec §3.3). Applied to
 * `script_line`, not `video_prompt`: `script_line` is the scene's actual
 * dialogue, while `video_prompt` must never quote spoken lines at all —
 * prompt_templates v3's "Never put words on screen" rule exists because a
 * quoted line rendered as a burned-in on-screen caption, so splicing
 * pronunciation text into video_prompt would risk the exact same failure.
 *
 * Done as a deterministic string operation for the same reason as
 * applyCameraMovementOverride: "after the first occurrence, every time"
 * is not a property worth trusting to model compliance when a regex can
 * guarantee it.
 *
 * Case-insensitive, whole-word match (`\b`) so "sera" inside "Seranova"
 * doesn't collide with a shorter guided word, and only the first match
 * per scene is annotated even if the word repeats within that scene's
 * line.
 */
export function applyPronunciationGuide(brief: Brief, guide: string): Brief {
  const entries = parsePronunciationGuide(guide);
  if (entries.length === 0) {
    return brief;
  }

  return {
    ...brief,
    scenes: brief.scenes.map((scene) => {
      let line = scene.script_line;
      for (const entry of entries) {
        const pattern = new RegExp(`\\b${escapeRegExp(entry.word)}\\b`, "i");
        const match = pattern.exec(line);
        if (!match) continue;
        const insertAt = match.index + match[0].length;
        line = `${line.slice(0, insertAt)} [${entry.phonetic}]${line.slice(insertAt)}`;
      }
      return { ...scene, script_line: line };
    }),
  };
}

/**
 * Fixture brief for MOCK_CLAUDE=1. Rewritten to fold the original 8
 * short (2-5s) scenes down to 6 scenes that each land on a clip length
 * every enabled model accepts (UNIVERSAL_DURATIONS_S) — adjacent lines that share a
 * setting are merged into one shot, per the "fewer, longer scenes" rule
 * the v2 prompt template now teaches the real compiler. Kept in sync with
 * the fixture-shape assertions in claude.test.ts.
 */
function mockBrief(): Brief {
  const character =
    "A woman in her late 20s with shoulder-length dark hair, wearing a cream linen shirt, standing in a sunlit minimalist kitchen.";

  const scenes: Brief["scenes"] = [
    {
      script_line:
        "Ever feel like your mornings are a race against the clock? That's why we built a routine that takes five minutes, not fifty.",
      video_prompt:
        "Medium shot of a woman in her late 20s with shoulder-length dark hair, wearing a cream linen shirt, leaning on the counter of a sunlit minimalist kitchen, speaking directly to camera with an empathetic expression that warms into a confident smile, soft natural window light, slow push-in on a static tripod, shot for 9:16 vertical delivery.",
      is_talking_head: true,
      duration_s: 8,
    },
    {
      script_line: "One scoop, cold water, done. No blender, no mess, no excuses.",
      video_prompt:
        "Overhead close-up of hands scooping powder into a glass and pouring cold water in a sunlit minimalist kitchen, cutting to a wide shot of the product jar rotating slowly on the counter as a woman's hand enters frame to pick it up, soft natural window light with a single practical warm lamp catching the splash, static tripod with a slight pan following the motion, 9:16 vertical framing.",
      is_talking_head: false,
      duration_s: 8,
    },
    {
      script_line: "I started seeing the difference in under two weeks.",
      video_prompt:
        "Medium shot of a woman in her late 20s with shoulder-length dark hair, wearing a cream linen shirt, standing in a sunlit minimalist kitchen, gesturing lightly with one hand as she speaks to camera, soft natural window light, handheld with subtle drift, 9:16 vertical delivery.",
      is_talking_head: true,
      duration_s: 6,
    },
    {
      script_line: "More energy through the afternoon slump.",
      video_prompt:
        "Close-up of a condensation-beaded glass being lifted off the kitchen counter and tilted toward the light, studio softbox lighting, slow push-in, 9:16 vertical framing.",
      is_talking_head: false,
      duration_s: 6,
    },
    {
      script_line: "So if mornings have been feeling like a fight, try this instead.",
      video_prompt:
        "Medium shot of a woman in her late 20s with shoulder-length dark hair, wearing a cream linen shirt, standing in a sunlit minimalist kitchen, speaking to camera with a reassuring, direct tone, soft natural window light, static tripod, shot for 9:16 vertical delivery.",
      is_talking_head: true,
      duration_s: 8,
    },
    {
      script_line: "Your first order ships free this week.",
      video_prompt:
        "Close-up of the product jar centered on the sunlit minimalist kitchen counter with soft rim light, a woman's hand taps the lid twice and she smiles off to the side, studio softbox lighting, locked-off camera, 9:16 vertical.",
      is_talking_head: false,
      duration_s: 6,
    },
  ];

  return { character, scenes };
}

// Belt-and-suspenders against the exact bug that motivated this file's
// duration_s literal-union type: even though the Zod schema already rejects
// any duration_s outside the descriptor's allowed set at parse time for real
// (non-mock) calls, both mockBrief() and mockScene() below build their
// fixtures by hand and never round-trip through Brief.parse/SceneBrief.parse,
// so a future edit that drifts a fixture off the allowed set would otherwise
// ship undetected. Shared by validateBrief (whole-compile) and compileScene
// (single-scene Apply/Split) so the two paths can't drift on what counts as
// a valid duration.
function assertAllowedDurations(durations: readonly number[]): void {
  const allowed = UNIVERSAL_DURATIONS_S as readonly number[];
  const disallowed = [...new Set(durations)].filter((d) => !allowed.includes(d));
  if (disallowed.length > 0) {
    throw new Error(
      `compileBrief: got ${disallowed.length} scene(s) with a duration_s outside the ` +
        `fal-allowed set (${allowed.join(", ")}): ${disallowed.join(", ")}.`,
    );
  }
}

/**
 * Renders CompileBriefArgs.productAppearance / CompileSceneArgs.productAppearance
 * as its own prompt section, or "" when the operator hasn't written one —
 * same "omit rather than send empty/placeholder" convention as
 * buildDirectionBlock and buildVisualIdeaRowsBlock above, so a project with
 * no appearance set compiles exactly as it did before this field existed
 * rather than sending Claude a line with nothing after the colon (which
 * would invite it to fill the gap itself, the opposite of the point).
 *
 * Worded as a visual constraint, not as material for the compiler to work
 * into dialogue: this describes what the product LOOKS like on screen
 * (form/material, colour, label treatment — see the field's help text in
 * character-setup-form.tsx), not something a character would plausibly say
 * out loud. Placed next to productName in both compileBrief and
 * compileScene's section lists, but kept as a separate line from it —
 * productName is a name to say, this is a constraint on what to draw.
 */
export function buildProductAppearanceSection(productAppearance?: string): string {
  const trimmed = productAppearance?.trim();
  if (!trimmed) {
    return "";
  }
  return (
    `Product appearance (visual constraint, not dialogue — this is exactly what the product ` +
    `looks like on screen; render it faithfully, do not have any character speak these details ` +
    `aloud): ${trimmed}`
  );
}

function validateBrief(brief: Brief): void {
  if (!brief.character || brief.character.trim().length === 0) {
    throw new Error("compileBrief: model returned an empty character description.");
  }
  if (brief.scenes.length === 0) {
    throw new Error("compileBrief: model returned zero scenes.");
  }
  assertAllowedDurations(brief.scenes.map((scene) => scene.duration_s));
}

export async function compileBrief(args: CompileBriefArgs): Promise<Brief> {
  const {
    script,
    characterDesc,
    productName,
    productAppearance,
    hasProduct = false,
    templateBody,
    model,
  } = args;
  const direction = args.direction ?? DEFAULT_DIRECTION;

  // Both post-processing steps run unconditionally — mock and real alike —
  // so MODE=development (used by every test and by local UI work) exercises
  // the exact same direction-application path a real compile does. Both
  // are no-ops when their trigger isn't set (see each function's own
  // guard), so this changes nothing for a project with no direction set.
  function finalize(brief: Brief): Brief {
    validateBrief(brief);
    const withCameraOverride = applyCameraMovementOverride(brief, direction);
    return applyPronunciationGuide(withCameraOverride, direction.pronunciation_guide);
  }

  if (isDev()) {
    return finalize(mockBrief());
  }

  const client = new Anthropic();

  // Volatile per-project text goes LAST, after the script, per the spec's
  // own caching note (SMN-feature-spec.md §12): the stable system prompt
  // (templateBody) is the `system` param already; putting the directorial
  // block after the script here — rather than at the top of `system`,
  // which is what the reference tool's `Extra infos` field does — keeps
  // prompt-cache prefix matching intact across compiles that share a
  // template version.
  const directionBlock = buildDirectionBlock(direction);
  const sections = [script];
  if (characterDesc) {
    sections.push(
      `Character reference (persona description supplied by the operator): ${characterDesc}`,
    );
  }
  if (productName) {
    // Lets Claude write "reach for your NeuroBlast SMN16-18" instead of the
    // generic "the product" in scenes that mention it by name — the same
    // reason character_desc is threaded through above rather than left
    // implicit in the reference image alone.
    sections.push(`Product name (refer to it by this name where natural): ${productName}`);
  }
  const productAppearanceSection = buildProductAppearanceSection(productAppearance);
  if (productAppearanceSection) {
    sections.push(productAppearanceSection);
  }
  // Always sent, true or false — never omitted the way productName is when
  // absent. Omitting a false value here would put the compiler back to
  // guessing "is there a product" from the script text alone, which is
  // the exact gap that let a coffee ad compile all-talking-head even
  // though a product image existed. The prompt's product-shot rule (v5)
  // reads this line, not productName, to decide whether it applies at all.
  sections.push(`Has product to show on screen: ${hasProduct ? "yes" : "no"}`);
  sections.push(`Direction:\n${directionBlock}`);

  // Gated here, not by the caller — see CompileBriefArgs.scriptRows' doc
  // comment for why this is the one place "should the operator's per-line
  // visual ideas actually apply right now" gets decided. Skipped entirely,
  // not sent as an empty section, when the toggle is off or nothing has a
  // visual idea to report — matching every other optional section above.
  if (direction.include_visual_idea && args.scriptRows) {
    const visualIdeaBlock = buildVisualIdeaRowsBlock(args.scriptRows);
    if (visualIdeaBlock) {
      sections.push(
        `Operator-authored visual ideas (see system prompt for how to use this):\n${visualIdeaBlock}`,
      );
    }
  }

  const userContent = sections.join("\n\n---\n");

  const response = await client.messages.parse({
    model: model ?? defaultClaudeModel(),
    max_tokens: 8000,
    system: templateBody,
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(Brief) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `compileBrief: model did not return parseable structured output (stop_reason: ${response.stop_reason}).`,
    );
  }

  return finalize(response.parsed_output);
}

// ---------------------------------------------------------------------------
// Description quality — "Improve with AI" and "Describe from photo"
// (character-setup-form.tsx). Two real incidents motivate these:
//
//   1. A character description was just "an athletic woman" — everything
//      else (hair, clothing, earrings, lighting) was invented fresh by the
//      compiler for every scene, so the same person looked different in
//      every clip.
//   2. A product photo showed a bright lime-green pouch while the product's
//      TEXT description said a matte kraft-paper pouch with a forest-green
//      label. The compiler never sees the photo, only the text, so every
//      scene rendered the wrong product — the operator's own hint on that
//      field says exactly this.
//
// Both are the same shape: text and image can disagree, and the text
// silently wins. improveDescriptionText fixes the first by filling gaps in
// whatever text already exists (never rewriting what's already there);
// describePhotoAppearance fixes the second by reading the ALREADY-UPLOADED
// photo and writing the text from it, instead of leaving a human to
// transcribe (and mis-transcribe) it by eye. Neither writes to the
// database — see actions/character.ts's improveDescription/
// describeProductFromPhoto, which return the suggestion for the operator to
// accept or discard, mirroring Apply/Split's own "generate, don't silently
// overwrite" shape at the Server Action boundary.
// ---------------------------------------------------------------------------

export const ImprovedDescription = z.object({
  description: z
    .string()
    .describe(
      "The description with gaps filled in. Preserve every detail the operator already wrote, " +
        "verbatim where possible — this is not a rewrite. Only ADD what's missing.",
    ),
});
export type ImprovedDescription = z.infer<typeof ImprovedDescription>;

export interface ImproveDescriptionArgs {
  description: string;
  subject: "character" | "product";
  model?: string;
}

/**
 * The one difference between improving a character description and a
 * product-appearance one: which attributes to fill gaps in. Both share the
 * same "fill gaps, don't rewrite" instruction, worded once below and reused
 * — see the FILL_GAPS_INSTRUCTION constant for why that has to stay
 * identical prose across both subjects.
 */
const SUBJECT_ATTRIBUTES: Record<ImproveDescriptionArgs["subject"], string> = {
  character:
    "clothing, hair, distinguishing features (age, build, notable features), and " +
    "lighting/setting — the details that keep the SAME person recognisable across every scene " +
    "the compiler generates from this text",
  product:
    "form and material, colour, and label treatment — the details that keep the SAME product " +
    "recognisable across every scene the compiler generates from this text",
};

// Said once, reused for both subjects below, rather than two independently
// worded prompts that could drift apart on the one rule that actually
// matters here: this call must never silently replace what an operator
// wrote (the exact defect this same repo shipped once already — Apply
// silently overwrote a hand-edited scene prompt with no warning). "Improve"
// is not "regenerate."
const FILL_GAPS_INSTRUCTION =
  "Fill gaps, do not rewrite. Keep every detail already written, worded as close to verbatim as " +
  "natural, and do not contradict or replace anything already there. Only ADD the specific " +
  "missing details named below. If the description already covers all of them, return it " +
  "essentially unchanged. Return one or two sentences, not a list, and never invent a different " +
  "subject than the one described.";

function improveDescriptionSystemPrompt(subject: ImproveDescriptionArgs["subject"]): string {
  const noun = subject === "character" ? "a character" : "a product's physical appearance";
  return (
    `You improve a short, already-started description of ${noun} for a video ad compiler. The ` +
    "compiler generates a fresh scene from this text every time and invents anything left " +
    `unspecified — differently each time. Cover, if missing: ${SUBJECT_ATTRIBUTES[subject]}.\n\n` +
    FILL_GAPS_INSTRUCTION
  );
}

/**
 * MOCK_CLAUDE=1 fixture. Deliberately keeps the operator's own text intact
 * and only appends a fixed, obviously-fake addition — same "never fabricate
 * what a real compile would say, but exercise the exact same shape" role
 * mockScene() plays for compileScene, and the same reason this must not
 * just echo the input back unchanged: a test asserting "the suggestion
 * differs from the input" (the whole point of an Improve call) needs a
 * fixture that actually adds something.
 */
function mockImprovedDescription(args: ImproveDescriptionArgs): ImprovedDescription {
  const addition =
    args.subject === "character"
      ? "shoulder-length dark hair, wearing a plain cream top, soft natural window light"
      : "matte kraft-paper texture, forest-green label centered near the top";
  const base = args.description.trim();
  return {
    description: `${base}${base.endsWith(".") ? "" : ","} ${addition} (MOCK_CLAUDE fixture).`,
  };
}

/**
 * Suggests a filled-in version of a character or product description — see
 * this section's header for the incident this fixes. Never called with an
 * empty description (actions/character.ts's improveDescription refuses that
 * before this is reached — there is nothing to fill gaps IN).
 */
export async function improveDescriptionText(
  args: ImproveDescriptionArgs,
): Promise<ImprovedDescription> {
  if (isDev()) {
    return mockImprovedDescription(args);
  }

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: args.model ?? defaultClaudeModel(),
    max_tokens: 500,
    system: improveDescriptionSystemPrompt(args.subject),
    messages: [{ role: "user", content: `Description to improve:\n${args.description}` }],
    output_config: { format: zodOutputFormat(ImprovedDescription) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `improveDescriptionText: model did not return parseable structured output (stop_reason: ${response.stop_reason}).`,
    );
  }
  return response.parsed_output;
}

// ---------------------------------------------------------------------------
// Refining a /ugc clip prompt.
//
// The scripted pipeline compiles a brief into video prompts. The /ugc route
// deliberately does not: the operator writes the whole instruction, and it
// reaches kie verbatim. That is the right default — it is the only route
// where what you typed is what the model got — but it means a rushed prompt
// renders as a rushed prompt, and every render is billed.
//
// So this is an EXPLICIT step, never automatic. The operator presses Refine,
// reads the result, and edits it before pressing Generate. Doing it silently
// inside Generate would mean paying for a render of words nobody saw, which
// is the same class of surprise as Apply silently overwriting a hand-edited
// scene prompt — a defect this repo has already shipped once.
// ---------------------------------------------------------------------------

export const ReferenceDescription = z.object({
  description: z
    .string()
    .describe(
      "One or two sentences describing what is visibly in the picture, written so a video " +
        "model that will never see it can render the same subject.",
    ),
});
export type ReferenceDescription = z.infer<typeof ReferenceDescription>;

export interface DescribeReferenceArgs {
  /**
   * Signed URL Claude fetches directly — the same "hand the vendor a URL"
   * shape describePhotoAppearance uses. Used when the element already exists
   * and its asset is in storage.
   */
  imageUrl?: string;
  /**
   * The image itself, base64-encoded, for a file that has NOT been uploaded
   * yet. That is the case in the reference picker: the operator chooses a
   * file and presses "Generate AI description" before pressing Save, so
   * there is no asset and no URL to sign — describing it means carrying the
   * bytes. Ignored when imageUrl is set.
   */
  imageBase64?: string;
  /** Required with imageBase64: "image/jpeg", "image/png" or "image/webp". */
  mediaType?: string;
  /** The element's own name, for context only. Never quoted back. */
  name?: string;
  /**
   * The element's category, when it carries one: 'image' or 'audio' since
   * 0081, or one of the older 'character' | 'product' | 'voice' | 'location'
   * on a row that predates it.
   *
   * NOTHING BRANCHES ON IT, AND THAT IS NOT THE SAME AS "IT DOES NOT MATTER".
   * This used to say "context for the description only", which reads as
   * harmless and is why a trace was needed to find otherwise: the value is
   * string-interpolated into the prompt below (see describeRoleLine), and the
   * system prompt branches three ways on the subject — person, product,
   * place — with this sentence as the only thing selecting one. Control flow
   * ignores it; the model does not.
   */
  category?: string | null;
  model?: string;
}

/**
 * Describes one saved reference, once.
 *
 * THIS IS THE REFERENCE, on the /ugc route. Nothing else about the picture
 * reaches the video model: the route sends no reference_image_urls, so what
 * the model knows about the operator's character is whatever this function
 * wrote down. A vague description here is a vague clip, and there is no
 * second channel to make up for it.
 *
 * Cached by the caller on elements.ai_description (0072), keyed to the asset
 * it was written from. That is not only for cost: a seven-clip ad calling this
 * per press would get seven slightly different accounts of one photograph, and
 * the whole reason to save an element is that the same person appears in every
 * clip.
 *
 * WHAT IT MAY NOT SAY. Never the words printed on anything — a label, a sign,
 * a garment. A video model draws what it is told, so "a pouch reading KINOKO"
 * comes back with letters painted into the frame. This codebase has paid for
 * that twice, and a vision pass makes it likelier rather than less: the model
 * is now looking straight at a photograph that may have text all over it.
 * Colour, shape, material, layout — never the reading.
 */
/**
 * The one image block, from whichever source the caller supplied.
 *
 * A URL when the asset is already in storage, raw bytes when it is not. The
 * throw is not defensive noise: both fields are optional on the interface so
 * either call site can compile, which means "neither was set" is a shape TS
 * cannot rule out and a silent request with no picture would come back
 * describing nothing at all.
 */
function imageBlock(args: DescribeReferenceArgs): Anthropic.ImageBlockParam {
  if (args.imageUrl) {
    return { type: "image", source: { type: "url", url: args.imageUrl } };
  }
  if (args.imageBase64 && args.mediaType) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: args.mediaType as Anthropic.Base64ImageSource["media_type"],
        data: args.imageBase64,
      },
    };
  }
  throw new Error("describeReferenceImage: needs either imageUrl, or imageBase64 with mediaType.");
}

export async function describeReferenceImage(
  args: DescribeReferenceArgs,
): Promise<ReferenceDescription> {
  if (isDev()) {
    return {
      description:
        `a ${args.category ?? "reference"} subject, described from the attached photograph ` +
        "(MOCK_CLAUDE fixture)",
    };
  }

  const roleLine = describeRoleLine(args.category);

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: args.model ?? defaultClaudeModel(),
    // Short on purpose. This text is spliced into a prompt that has its own
    // work to do, and a paragraph about a photograph crowds out the scene.
    max_tokens: 300,
    system:
      "You describe the SUBJECT of a reference photograph, for a video model that will never " +
      "see the photograph itself — only the words you write here. Your words are the whole " +
      "reference, and they will be spliced into a prompt that puts this subject somewhere " +
      "else entirely.\n\n" +
      "DESCRIBE THE SUBJECT, NEVER THE PICTURE. A reference is very often a contact sheet or " +
      "turnaround — the same person or product repeated in several views, on a plain studio " +
      "backdrop. That layout is how the reference was PHOTOGRAPHED and has nothing to do with " +
      "the scene being generated. Never write that the subject is shown in multiple views, " +
      "never number or name the views, and never mention the backdrop or the studio. Write " +
      "one description of one subject, as if you had seen them once.\n\n" +
      "A description that says 'shown in three views against a neutral grey background' gets " +
      "pasted into a prompt about a kitchen, and then the prompt contradicts itself.\n\n" +
      "SPEND THE WORDS ON IDENTITY. What matters is recognising this exact person or object " +
      "again in a different shot. For a person: apparent age in years, face shape, skin, eye " +
      "colour, and hair — its length, colour, texture and how it falls — then build, then " +
      "clothing. Age and hair are what a video model most often gets wrong, so be decisive " +
      "about both rather than hedging. For a product: form, material, colour and the layout " +
      "of its packaging. For a place: surfaces, light and character.\n\n" +
      "Describe ONLY what is in the picture. Do not invent, do not write marketing copy, and " +
      "do not describe the photograph as a photograph — no mention of framing, background " +
      "blur, lighting setup or camera. Those come from the prompt this will be spliced into, " +
      "and repeating them here would fight it.\n\n" +
      "NEVER transcribe text. If the subject carries printed words — a logo, a wordmark, a " +
      "sign, a label — describe their colour, size and placement and stop there. A video model " +
      "draws what you describe, so a quoted word comes back painted into the frame.\n\n" +
      "One or two sentences. No preamble.",
    messages: [
      {
        role: "user",
        content: [
          imageBlock(args),
          { type: "text", text: `${roleLine}Describe what is in this picture.` },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(ReferenceDescription) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `describeReferenceImage: model did not return parseable structured output (stop_reason: ${response.stop_reason}).`,
    );
  }
  return response.parsed_output;
}

// NO REFINE. refineClipPromptText lived here, with RefinedPrompt,
// RefineReference, its system prompt, and the tag assertions that policed
// its output. It sent a whole clip prompt to Sonnet and asked for a
// rewritten copy.
//
// Deleted with its UI. A tag now resolves to a description written once,
// when the element is saved, and actions/ugc.ts pastes it in at render
// time — so the work Refine did at press time happens anyway, for free,
// and deterministically. What was left was a slower, dearer rewrite whose
// output had to restate its entire input to say anything, which is exactly
// how it failed on the first real prompt: max_tokens, nothing parsed,
// after the vision call had already been paid for.

export const PhotoAppearance = z.object({
  description: z
    .string()
    .describe(
      "What the product looks like, exactly as shown in the photo: form/material, colour, and " +
        "label treatment. A visual constraint for a video compiler that will never see this " +
        "photo, not marketing copy — do not invent details the photo doesn't actually show.",
    ),
});
export type PhotoAppearance = z.infer<typeof PhotoAppearance>;

export interface DescribePhotoAppearanceArgs {
  /** A URL Anthropic's servers can fetch — a Supabase signed URL, same as every other reference image this codebase hands to a vendor (lib/fal.ts's refImageUrls, actions/character.ts's regenerateComposite). */
  imageUrl: string;
  /** projects.product_name, when set — gives the model one more anchor for which object in frame is "the product", same reason compileBrief threads it through. */
  productName?: string;
  /**
   * The appearance text the operator has already written, when there is any.
   *
   * Passed so ONE call can do the job two buttons used to split between it
   * and improveDescriptionText. The split forced the operator to choose
   * which input wins: "describe from photo" silently discarded whatever
   * they had typed, and "improve" never looked at the photo — while the
   * failure this screen exists to catch is precisely the two DISAGREEING.
   * A model holding both can reconcile them; a model holding one can only
   * overwrite.
   *
   * Absent or blank is the ordinary first-use case and the prompt handles
   * it: with nothing written, this is a plain description of the photo.
   */
  currentText?: string;
  model?: string;
}

/**
 * MOCK_CLAUDE=1 fixture — deliberately does NOT depend on imageUrl (this
 * mock never actually looks at an image, same as mockScene() never looks at
 * scriptLine), and is worded to obviously read as a fixture rather than a
 * real vendor-billed description.
 */
/**
 * MOCK_CLAUDE fixture. Takes `currentText` so the mock exercises the branch
 * the real call now has: with nothing written this is a plain description,
 * with something written it is a correction OF that text.
 *
 * Without this the mock returned the same sentence either way, and the one
 * behaviour worth checking by hand — that pressing the button no longer
 * discards what you typed — was invisible in local testing, which is where
 * it will actually be looked at. The fixture text is deliberately the
 * green-pouch wording this feature exists because of.
 */
function mockPhotoAppearance(currentText?: string): PhotoAppearance {
  const written = currentText?.trim() ?? "";
  if (written.length === 0) {
    return {
      description:
        "Matte kraft-paper stand-up pouch, forest-green label centered near the top, resealable " +
        "zip strip (MOCK_CLAUDE fixture).",
    };
  }
  return {
    description: `${written} — checked against the photo, colour and material corrected (MOCK_CLAUDE fixture).`,
  };
}

/**
 * Reads an already-uploaded product reference photo and writes the
 * appearance text from it — the direct fix for the green-pouch incident
 * this section's header describes: the right answer was already in the
 * app, in an uploaded photo, while a human typed a wrong one. This is the
 * first vision call in this codebase (every other Claude call here is
 * text-only) — Anthropic's `image` content block with a `url` source lets
 * the model fetch the reference directly rather than this app downloading
 * and base64-encoding it first, the same "hand the vendor a URL" shape
 * lib/fal.ts and regenerateComposite already use for image inputs.
 */
export async function describePhotoAppearance(
  args: DescribePhotoAppearanceArgs,
): Promise<PhotoAppearance> {
  if (isDev()) {
    return mockPhotoAppearance(args.currentText);
  }

  const client = new Anthropic();
  const productLine = args.productName ? `The product is called "${args.productName}". ` : "";
  const written = args.currentText?.trim() ?? "";

  // The photo is the authority, and the prompt says so outright.
  //
  // When the two inputs disagree, one of them has to lose, and it cannot be
  // decided per-call by whichever reads better: the incident this whole
  // screen was built around was a fluent, detailed, entirely wrong
  // description — "matte kraft-paper pouch with a forest-green label" —
  // written about a bright lime-green pouch sitting in the upload. Prose
  // quality is exactly what a model would weigh if left to choose, and it
  // is the signal that was wrong. So: keep the operator's wording and
  // anything the photo cannot show (flavour, scent, claims), correct
  // anything it contradicts.
  const reconcileLine = written
    ? "\n\nThe operator has already written this description:\n" +
      `"""${written}"""\n\n` +
      "Rewrite it against the photo. Keep their voice, their level of detail, and any fact " +
      "the photo cannot show. CORRECT anything the photo contradicts — colour, material, " +
      "shape, label treatment — and drop anything that is not there. If it is already " +
      "accurate, return it close to unchanged rather than rewriting for its own sake."
    : "";

  const response = await client.messages.parse({
    model: args.model ?? defaultClaudeModel(),
    max_tokens: 500,
    system:
      "You describe exactly what a product looks like from a reference photo, for a video ad " +
      "compiler that will never see the photo itself — only the text you write here. Describe " +
      "form and material, colour, and label treatment, faithfully and specifically. Do not " +
      "invent details the photo doesn't show, and do not write marketing copy.",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: args.imageUrl } },
          {
            type: "text",
            text: `${productLine}Describe exactly what this product looks like.${reconcileLine}`,
          },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(PhotoAppearance) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `describePhotoAppearance: model did not return parseable structured output (stop_reason: ${response.stop_reason}).`,
    );
  }
  return response.parsed_output;
}

// ---------------------------------------------------------------------------
// Single-scene compile — Apply and Split (spec §3.5)
// ---------------------------------------------------------------------------

// Same fields compileBrief generates per scene, minus script_line AND
// visual_idea: Apply and Split both supply the script line as *input*
// ("Generates fitting Veo 3 + Nano Banana prompts from the script line
// above") rather than asking Claude to (re)write it, so there is nothing
// for the model to fill into that field and no risk of it drifting from
// what the operator actually typed. visual_idea is dropped for a related
// but distinct reason: a single-scene compile already KNOWS which visual
// idea (if any) applies — it's whatever the caller passes in as
// CompileSceneArgs.visualIdea, sourced from the scene's own stored
// scenes.visual_idea — so there is nothing for Claude to echo back that the
// caller doesn't already have. See CompileSceneArgs.visualIdea below, and
// this file's Brief.scenes[].visual_idea doc comment for why compileBrief's
// echo can't be trusted as a write-back for an existing scene in the first
// place.
export const SceneBrief = Brief.shape.scenes.element.omit({
  script_line: true,
  visual_idea: true,
});
export type SceneBrief = z.infer<typeof SceneBrief>;

export interface CompileSceneArgs {
  /** The one script line this scene's prompt is generated from. */
  scriptLine: string;
  characterDesc?: string;
  /** See CompileBriefArgs.productName — same reason to thread it through here. */
  productName?: string;
  /** See CompileBriefArgs.productAppearance — same reason to thread it through here. */
  productAppearance?: string;
  /** Same system prompt a full compile uses — see CompileBriefArgs.templateBody. */
  templateBody: string;
  model?: string;
  direction?: ProjectDirection;
  /**
   * This scene's own operator-authored visual idea, when it has one — the
   * Apply/Split counterpart to compileBrief's `scriptRows`. Unlike
   * `scriptRows` (a whole parsed script Claude has to match against
   * scenes), a single scene's visual idea is already known before this
   * call: it's whatever is stored on scenes.visual_idea from the last
   * (re)compile. The caller (actions/brief.ts) is responsible for reading
   * it off the scene row and passing it through here — see this file's
   * report for the exact call-site patch. Gated the same way as
   * compileBrief's scriptRows: pass it whenever the scene has one, and let
   * this function check direction.include_visual_idea before using it, so
   * an operator who has since unchecked the toggle gets it ignored on the
   * next Apply without the caller having to remember to check first.
   */
  visualIdea?: string;
}

/**
 * Deterministic MOCK_CLAUDE=1 fixture, mirroring mockBrief()'s role for the
 * whole-brief path. Content is intentionally generic rather than derived
 * from scriptLine — quoting the operator's dialogue back into video_prompt
 * is exactly the "Never put words on screen" bug applyPronunciationGuide's
 * doc comment describes (a quoted line rendered as a burned-in caption).
 */
function mockScene(): SceneBrief {
  return {
    video_prompt:
      "Medium shot, direct to camera, warm and confident delivery, soft natural light, static tripod, 9:16 vertical framing (MOCK_CLAUDE fixture).",
    is_talking_head: true,
    duration_s: 8,
  };
}

/**
 * Generates one scene's video_prompt (+ is_talking_head, duration_s) from
 * its script line and the project's direction fields — Apply and Split's
 * shared engine. Deliberately reuses, rather than re-implements, everything
 * a full compileBrief() applies per scene: buildDirectionBlock for the
 * shooting-mode/visual-idea/voice/UGC-style lines, the same `templateBody`
 * system prompt (so the "never put words on screen" rule and every other
 * instruction in it apply identically), the same duration literal schema
 * (via SceneBrief, sliced from Brief itself), and applyCameraMovementOverride
 * for the deterministic handheld-shake patch. The only compileBrief
 * post-processing step intentionally skipped is applyPronunciationGuide:
 * that operates on script_line, which this call never touches, and running
 * it here on an already-annotated line (e.g. one a full compile already
 * inserted a `[phonetic]` after) would double-annotate it. Per-scene
 * pronunciation is spec'd as its own separate "+ Add phonetic" control, not
 * something Apply re-derives.
 *
 * A single scene, not the whole script, is sent as user content — the
 * entire point of Apply/Split being cheap (see APPLY_SCENE_COST_USD) is that
 * this call is O(1) in project size, not O(scenes).
 */
export async function compileScene(args: CompileSceneArgs): Promise<SceneBrief> {
  const {
    scriptLine,
    characterDesc,
    productName,
    productAppearance,
    templateBody,
    model,
    visualIdea,
  } = args;
  const direction = args.direction ?? DEFAULT_DIRECTION;

  function finalize(scene: SceneBrief): SceneBrief {
    assertAllowedDurations([scene.duration_s]);
    // applyCameraMovementOverride only reads/writes video_prompt and only
    // acts under static+camera_movement, so wrapping this one scene in a
    // throwaway single-scene Brief is a safe way to reuse it verbatim
    // rather than forking its prepend logic into a scene-shaped duplicate.
    const wrapped: Brief = {
      character: characterDesc ?? "",
      scenes: [{ ...scene, script_line: "" }],
    };
    // Drop the placeholder script_line back off before returning — it only
    // exists to satisfy Brief's shape for the wrap/unwrap above and must
    // never leak into SceneBrief's output.
    const { script_line: _placeholder, ...rest } = applyCameraMovementOverride(wrapped, direction)
      .scenes[0]!;
    return rest;
  }

  if (isDev()) {
    return finalize(mockScene());
  }

  const client = new Anthropic();

  const directionBlock = buildDirectionBlock(direction);
  const sections = [`Script line for this single scene only:\n${scriptLine}`];
  if (characterDesc) {
    sections.push(
      `Character reference (persona description supplied by the operator): ${characterDesc}`,
    );
  }
  if (productName) {
    sections.push(`Product name (refer to it by this name where natural): ${productName}`);
  }
  const productAppearanceSection = buildProductAppearanceSection(productAppearance);
  if (productAppearanceSection) {
    sections.push(productAppearanceSection);
  }
  sections.push(`Direction:\n${directionBlock}`);

  // Same gate as compileBrief's scriptRows section — see
  // CompileSceneArgs.visualIdea's doc comment for why the caller passes
  // this through unconditionally and this function decides whether it
  // actually applies.
  if (direction.include_visual_idea && visualIdea && visualIdea.trim().length > 0) {
    sections.push(
      `Operator-authored visual idea for this exact line — EXPAND it into the video_prompt ` +
        `rather than inventing your own (see system prompt for how to use this): ${visualIdea.trim()}`,
    );
  }

  const userContent = sections.join("\n\n---\n");

  const response = await client.messages.parse({
    model: model ?? defaultClaudeModel(),
    max_tokens: 2000,
    system: templateBody,
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(SceneBrief) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `compileScene: model did not return parseable structured output (stop_reason: ${response.stop_reason}).`,
    );
  }

  return finalize(response.parsed_output);
}

// --- Image sequence -------------------------------------------------------

/**
 * The most beats one compile may return.
 *
 * A GUARD AGAINST A TYPO, NOT A CAP ON INTENT. The count comes from what the
 * operator asked for: "8 images" means eight, and a ceiling that quietly
 * returned six would be answering a different question than the one typed.
 *
 * It exists only because "100 images" is a slip that would otherwise cost real
 * money and leave the browser looping for hours. Nothing between one and this
 * is second-guessed, and the total is priced on screen before any image draws,
 * so a large-but-deliberate number is confirmed rather than refused.
 */
export const MAX_SEQUENCE_BEATS = 24;

export const ImageSequence = z.object({
  beats: z
    .array(
      z.object({
        prompt: z
          .string()
          .describe(
            "A complete, standalone image prompt for this beat. Describes the whole frame — " +
              "subject, action, framing, setting, light — as if nothing else in the sequence " +
              "existed.",
          ),
      }),
    )
    .min(1)
    .max(MAX_SEQUENCE_BEATS)
    .describe("The beats, in the order they should be generated."),
});
export type ImageSequence = z.infer<typeof ImageSequence>;

export const IMAGE_SEQUENCE_SYSTEM_PROMPT =
  "You turn one request into an ordered sequence of still images that read as one moment " +
  "unfolding — a storyboard, not a gallery.\n\n" +
  "HOW MANY. THE REQUEST DECIDES. If it names a number — 'three images', '5 shots', 'a " +
  "four-part sequence' — return exactly that many beats. Not one more, not one fewer, even " +
  "where you think the moment would be told better differently. The operator is paying per " +
  "beat and has already been quoted for the number they asked for.\n\n" +
  "Only when the request names NO number do you choose, and then pick the smallest that " +
  `tells the moment — usually three. Never exceed ${MAX_SEQUENCE_BEATS} in either case. ` +
  "Each beat is a separate paid image, so an extra beat is real money spent on a picture " +
  "nobody asked for.\n\n" +
  "EACH PROMPT MUST STAND ALONE. The image model generating beat three has never seen beat " +
  "one and cannot read your other prompts. Never write 'the same man', 'as before', " +
  "'continuing from the previous shot' or 'he now'. Describe the whole frame every time, " +
  "even where that repeats the subject word for word. Repetition here is what makes the " +
  "sequence hold together; a back-reference is what breaks it.\n\n" +
  "WHAT SHOULD CHANGE BETWEEN BEATS is the moment — position, action, distance, framing, " +
  "the light if time is passing. What should NOT change is who and what is in the frame. " +
  "Keep the subject's description identical across every beat.\n\n" +
  "CARRY @TAGS THROUGH EXACTLY AS WRITTEN. A word starting with '@' names a saved reference " +
  "and is resolved later against the operator's own library. Copy '@man' as '@man'. Never " +
  "rename, expand, pluralise, describe or drop one — a changed tag resolves to nothing and " +
  "silently loses the reference it was standing in for. If a beat features that subject, " +
  "the tag belongs in that beat's prompt.\n\n" +
  "Write prompts, not prose. No preamble, no titles, no numbering.";

/**
 * Turns one free-text request into an ordered list of image prompts.
 *
 * WHY THIS IS NOT A REGEX. "Make me 3 images of a man walking towards the
 * street" carries a count AND a progression: he starts, he crosses, he
 * arrives. A number pulled out with a pattern gets the count and then sends
 * the same prompt three times, which returns three variations of one shot —
 * not a sequence. The beats are the whole point; the count falls out of them.
 *
 * WHAT IT MUST NOT DO. It does not resolve @tags and must not rewrite them:
 * actions/image-generator.ts resolves those against the operator's own library
 * at generate time, and a tag this rewrote to "@the man" would resolve to
 * nothing and silently drop the reference. The system prompt says to carry
 * them through verbatim.
 *
 * The returned prompts are shown to the operator BEFORE anything is charged
 * for an image — the compile itself is the only spend at this point.
 */
export async function compileImageSequence(args: {
  request: string;
  model?: string;
}): Promise<ImageSequence> {
  if (isDev()) {
    // Mirrors the shape without the spend, same as every other isDev() branch
    // in this file — but it must also mirror the BEHAVIOUR that matters here.
    //
    // This returned three beats flat, whatever was typed. That made the mock
    // lie about the one thing a sequence compile decides: how many pictures
    // the operator is about to buy. Anyone testing "make me 5 images" saw three
    // and would reasonably conclude the count was being ignored.
    //
    // A crude digit match is right for a fixture. The real compile reads "a
    // four-part sequence" too; this only has to stop the mock contradicting it
    // on the plain case.
    const asked = Number(/\b(\d{1,3})\b/.exec(args.request)?.[1] ?? 0);
    const count = asked >= 1 ? Math.min(asked, MAX_SEQUENCE_BEATS) : 3;
    return {
      beats: Array.from({ length: count }, (_, index) => ({
        prompt: `${args.request} — beat ${index + 1} of ${count} (MOCK_CLAUDE fixture)`,
      })),
    };
  }

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: args.model ?? defaultClaudeModel(),
    // Enough for six beats of a few sentences each. Brief's own call runs far
    // larger; this one returns prompts, not a script.
    max_tokens: 1500,
    system: IMAGE_SEQUENCE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: args.request }],
    output_config: { format: zodOutputFormat(ImageSequence) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `compileImageSequence: model did not return parseable structured output (stop_reason: ${response.stop_reason}).`,
    );
  }
  return response.parsed_output;
}
