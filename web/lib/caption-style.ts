// Per-project caption settings — the three columns 0049 adds to `projects`,
// as a Zod schema. Same file split, and the same reasoning, as lib/direction.ts:
// the shape lives in lib/ rather than inside the "use server" action because
// more than one caller needs the type, and a plain synchronous schema is
// unit-testable in a way an async Server Action is not.
//
// One rule this file owns and nothing else may duplicate: a colour is
// "#RRGGBB", six digits, and nothing else. That exact regex appears in three
// places by design — here, in 0049's CHECK constraints, and in
// worker/internal/captions/color.go — because the three layers fail
// differently and each has to refuse independently. This one produces a
// message the operator reads; the constraint stops a seed script or a manual
// UPDATE; the Go one stops a bypassed constraint from handing libass a token
// it will silently mis-draw.
//
// Three-digit shorthand ("#FFF") is rejected rather than expanded. Expanding
// it would mean implementing the same expansion identically in SQL, in
// TypeScript and in Go, and any drift between the three would show up as a
// wrong colour in a rendered video rather than as an error.
import { z } from "zod";

/** The one spelling of a caption colour: '#' then exactly six hex digits. */
export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Defaults matching 0049's column defaults, which in turn reproduce what
 * worker/internal/captions/ass.go hardcoded before captions became
 * configurable.
 *
 * DEFAULT_CAPTION_BOX_COLOR is the retired `boxColorASS` constant read back
 * into RGB. That constant's own comment recorded its provenance: sampled out
 * of demo/demo1.mp4's highlight boxes by the proof of concept, not chosen as
 * a brand colour. It is preserved so nothing changes appearance on upgrade —
 * it is not a recommendation.
 */
export const DEFAULT_CAPTION_STYLE = {
  captions_enabled: true,
  caption_box_color: "#730BF9",
  caption_text_color: "#FFFFFF",
} as const;

export interface CaptionStyle {
  captions_enabled: boolean;
  caption_box_color: string;
  caption_text_color: string;
}

const colorField = (label: string) =>
  z.string().trim().regex(HEX_COLOR_RE, `${label} must be a 6-digit hex colour like #730BF9.`);

/**
 * Parses the three caption fields out of a form submission.
 *
 * `captions_enabled` is read by the caller as "was the key present" — an
 * unchecked checkbox sends no entry at all — exactly like `camera_movement`
 * and `include_visual_idea` in DirectionSchema. It is a plain boolean here.
 *
 * Colours are `.default()`ed rather than required so that a form which does
 * not render these fields at all (or a future partial save) lands on today's
 * palette instead of failing validation on a field the operator never saw.
 */
export const CaptionStyleSchema = z.object({
  captions_enabled: z.boolean().default(DEFAULT_CAPTION_STYLE.captions_enabled),
  caption_box_color: colorField("Highlight colour").default(
    DEFAULT_CAPTION_STYLE.caption_box_color,
  ),
  caption_text_color: colorField("Text colour").default(DEFAULT_CAPTION_STYLE.caption_text_color),
});

/**
 * Lifts the three columns off a `projects` row, coalescing nulls to the
 * defaults. The columns are NOT NULL in 0049, so the null branches only fire
 * for a row read through a type that predates the migration — cheaper to
 * tolerate than to make every caller assert non-null.
 */
export function captionStyleFrom(project: {
  captions_enabled?: boolean | null;
  caption_box_color?: string | null;
  caption_text_color?: string | null;
}): CaptionStyle {
  return {
    captions_enabled: project.captions_enabled ?? DEFAULT_CAPTION_STYLE.captions_enabled,
    caption_box_color: project.caption_box_color ?? DEFAULT_CAPTION_STYLE.caption_box_color,
    caption_text_color: project.caption_text_color ?? DEFAULT_CAPTION_STYLE.caption_text_color,
  };
}

/**
 * Relative luminance per WCAG 2.x, on a 0..1 scale. Used only for the
 * advisory contrast warning below — never to reject a save.
 */
function relativeLuminance(hex: string): number {
  const channel = (start: number): number => {
    const v = parseInt(hex.slice(start, start + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * True when the text and box colours are close enough that the caption is
 * likely hard to read against its own highlight.
 *
 * Advisory only, and deliberately so. Every other free-form field on the
 * Character page trusts the operator (0013's own migration comment: free-form
 * operator prose "has no enum to check against"), and a hard block here would
 * make this the one field on the page that overrules intent by arithmetic.
 * It is also not a certain failure: the text keeps a near-black outline that
 * no setting exposes, so white-on-white is degraded, not invisible.
 *
 * The 3:1 threshold is the WCAG large-text ratio rather than the 4.5:1 body
 * threshold — burned-in captions at this size are large text, and warning at
 * 4.5:1 would flag legible pairings often enough that operators learn to
 * ignore the warning, which is worse than not having one.
 */
export function isLowContrast(textHex: string, boxHex: string): boolean {
  if (!HEX_COLOR_RE.test(textHex) || !HEX_COLOR_RE.test(boxHex)) return false;
  const a = relativeLuminance(textHex);
  const b = relativeLuminance(boxHex);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05) < 3;
}
