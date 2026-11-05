// Single source of truth for "is this project title acceptable to save" —
// enforced once at project creation (actions/project.ts's createProject) and
// again on every edit from the Settings page (actions/settings.ts's
// saveTitle, where the title is editable — and, unlike every other field on
// that page, stays editable even once the project is locked; see saveTitle's
// doc comment). Mirrors lib/script-guard.ts exactly,
// for the same reason: if creation and edit checked this in their own
// words, they could drift — creation refusing an empty title the edit path
// would silently accept, or the reverse.
//
// The maximum-length check exists because a user once pasted an entire ad
// script into this field, producing a 1,444-character title that stretched
// the /projects table and forced a horizontal scrollbar across every row.
// Do not remove the cap thinking it is arbitrary — it isn't.

/** Same message both call sites return — one wording, so neither can drift from the other. */
export const EMPTY_TITLE_MESSAGE = "Title is required.";

/** Longest title accepted, in characters, measured after trimming. */
export const MAX_TITLE_LENGTH = 120;

/** Same message both call sites return — one wording, so neither can drift from the other. */
export const TITLE_TOO_LONG_MESSAGE = (length: number) =>
  `Title must be ${MAX_TITLE_LENGTH} characters or fewer (yours is ${length}).`;

/**
 * Trims a submitted title and refuses it if nothing is left, or if what's
 * left exceeds MAX_TITLE_LENGTH. Takes the raw FormData value (not a
 * pre-extracted string) so both call sites run the exact same
 * type-narrowing, not just the exact same length check. Never truncates —
 * a silent truncation would destroy text someone typed, so an over-length
 * title is refused and the caller must fix it themselves.
 */
export function requireTitle(
  value: FormDataEntryValue | null,
): { error: string } | { title: string } {
  const title = typeof value === "string" ? value.trim() : "";
  if (title.length === 0) {
    return { error: EMPTY_TITLE_MESSAGE };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { error: TITLE_TOO_LONG_MESSAGE(title.length) };
  }
  return { title };
}
