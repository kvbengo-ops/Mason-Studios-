// The seven directorial inputs from projects.{shooting_mode,camera_movement,
// visual_idea,voice_profile,pronunciation_guide,ugc_style,include_visual_idea}
// (0013_project_direction.sql, plus include_visual_idea from
// 0024_include_visual_idea_and_scene_visual_idea.sql) — everything the
// prompt compiler needs beyond the raw script and character description.
//
// Schema lives here rather than inline in actions/character.ts (which
// validates and writes it, alongside character_desc/product_name, as part
// of saveCharacterSetup) because web/lib/claude.ts also needs the type (to
// interpolate these fields into the compiler prompt) and
// web/scripts/compile.ts needs the defaults — same split as RenderSettings
// living in models.ts while actions/render-settings.ts only validates and
// writes.
//
// include_visual_idea joined the other six later, for the per-scene visual
// idea feature (SMN-feature-spec.md §3.3's `Include Visual Idea` checkbox,
// checked by default). It is a scalar, project-wide toggle exactly like the
// other six — "should Claude expand the operator's own per-line visual
// ideas, or invent its own the way it already does" — so it belongs in this
// same struct rather than a separate one, even though the per-line data it
// governs (lib/script-columns.ts's ScriptRow[], parsed fresh from
// script_raw on every compile rather than persisted — see 0024's header for
// why) is not itself a ProjectDirection field.

import { z } from "zod";

export const SHOOTING_MODES = ["selfie", "static", "mirror"] as const;
export type ShootingMode = (typeof SHOOTING_MODES)[number];

export const UGC_STYLES = [
  "auto",
  "talking_head",
  "voiceover",
  "b_roll",
  "testimonial",
  "unboxing",
] as const;
export type UgcStyle = (typeof UGC_STYLES)[number];

// Field names are snake_case, matching the DB columns exactly (unlike
// RenderSettings' camelCase, which matches jsonb keys that were free to be
// named anything). These are real columns, not a jsonb blob — see 0013's
// comment for why — so a write is a direct `admin.from("projects").update(
// direction)` with no key-casing translation layer to keep in sync.
export interface ProjectDirection {
  shooting_mode: ShootingMode;
  camera_movement: boolean;
  visual_idea: string;
  voice_profile: string;
  pronunciation_guide: string;
  ugc_style: UgcStyle;
  /**
   * Spec §3.3's `Include Visual Idea` checkbox — "checked by default."
   * When true, lib/claude.ts's compileBrief/compileScene fold the
   * operator's own per-line visual ideas (lib/script-columns.ts) into the
   * scenes they apply to instead of leaving Claude to invent the shot's
   * camera/action direction the way it already does. When false, any
   * two-column data the operator pasted is ignored for this purpose — the
   * script text itself is still cleaned of delimiter noise (see
   * actions/compile.ts), only the EXPAND semantics are switched off.
   */
  include_visual_idea: boolean;
}

/** Matches the column defaults in 0013_project_direction.sql and 0024. */
export const DEFAULT_DIRECTION: ProjectDirection = {
  shooting_mode: "selfie",
  camera_movement: false,
  visual_idea: "",
  voice_profile: "",
  pronunciation_guide: "",
  ugc_style: "auto",
  include_visual_idea: true,
};

/**
 * Validates a write to the seven direction columns.
 *
 * The camera_movement normalization at the end is the one non-obvious
 * piece: per the spec (SMN-feature-spec.md §3.1), `camera_movement` is
 * "conditional on Static mode; not rendered under Selfie" — under
 * selfie/mirror, shake is already inherent to the mode, so the control
 * does not exist in the UI. Normalizing a stray `true` down to `false`
 * here (rather than rejecting it) means the UI's conditional render is
 * the ONLY place this rule has to be enforced correctly — a leftover
 * `true` from switching shooting_mode away from `static` in the browser
 * (radio buttons don't clear an unrelated checkbox for free) can never
 * reach the compiler as a live directive.
 *
 * include_visual_idea defaults to true, unlike every boolean before it
 * (camera_movement defaults false) — matching spec §3.3's "checked by
 * default." That default only matters for DEFAULT_DIRECTION itself (the
 * CLI, and any call with no form behind it) and for the checkbox's own
 * `defaultChecked` in the UI (a brand-new project's column value, per
 * 0024's DB default). A real form submission always reads this key with
 * the exact same `formData.get("include_visual_idea") != null` pattern
 * ShootingModeFields' camera_movement already uses (see
 * actions/character.ts's directionFromFormData) — the checkbox is always
 * rendered (never conditionally unmounted the way camera_movement is), so
 * its presence in FormData always faithfully reflects whatever the
 * operator's checkbox currently shows, checked or not.
 */
export const DirectionSchema = z
  .object({
    shooting_mode: z.enum(SHOOTING_MODES).default(DEFAULT_DIRECTION.shooting_mode),
    camera_movement: z.boolean().default(DEFAULT_DIRECTION.camera_movement),
    visual_idea: z.string().trim().max(4000).default(DEFAULT_DIRECTION.visual_idea),
    voice_profile: z.string().trim().max(500).default(DEFAULT_DIRECTION.voice_profile),
    pronunciation_guide: z.string().trim().max(4000).default(DEFAULT_DIRECTION.pronunciation_guide),
    ugc_style: z.enum(UGC_STYLES).default(DEFAULT_DIRECTION.ugc_style),
    include_visual_idea: z.boolean().default(DEFAULT_DIRECTION.include_visual_idea),
  })
  .transform((value): ProjectDirection => ({
    ...value,
    camera_movement: value.shooting_mode === "static" ? value.camera_movement : false,
  }));

/**
 * Lifts the seven direction columns off a `projects` row into a
 * ProjectDirection. Both actions/compile.ts (full brief compile) and
 * actions/brief.ts (per-scene Apply/Split) need this exact mapping — nullable
 * text columns coalesced to "" so buildDirectionBlock's "omit fields left at
 * default" checks in lib/claude.ts see the same shape a fresh project's
 * DEFAULT_DIRECTION would.
 */
export function projectDirectionFrom(project: {
  shooting_mode: ShootingMode;
  camera_movement: boolean;
  visual_idea: string | null;
  voice_profile: string | null;
  pronunciation_guide: string | null;
  ugc_style: UgcStyle;
  include_visual_idea: boolean;
}): ProjectDirection {
  return {
    shooting_mode: project.shooting_mode,
    camera_movement: project.camera_movement,
    visual_idea: project.visual_idea ?? "",
    voice_profile: project.voice_profile ?? "",
    pronunciation_guide: project.pronunciation_guide ?? "",
    ugc_style: project.ugc_style,
    include_visual_idea: project.include_visual_idea,
  };
}
