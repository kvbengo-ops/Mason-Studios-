// Single source of truth for "is this script acceptable to save" — enforced
// once at project creation (actions/project.ts's createProject) and again on
// every edit from the Script step (actions/setup.ts's saveScript, now that
// the script is editable there too). A script
// is what every compiled brief and every rendered scene ultimately traces
// back to; if these two call sites checked it in their own words instead of
// sharing this one, they could silently drift — creation refusing something
// the edit path would accept, or the reverse.

/** Same message both call sites return — one wording, so neither can drift from the other. */
export const EMPTY_SCRIPT_MESSAGE =
  "Script is required — paste the full script before creating the project.";

/**
 * Trims a submitted script and refuses it if nothing is left. Takes the raw
 * FormData value (not a pre-extracted string) so both call sites run the
 * exact same type-narrowing, not just the exact same length check.
 */
export function requireScript(
  value: FormDataEntryValue | null,
): { error: string } | { script: string } {
  const script = typeof value === "string" ? value.trim() : "";
  if (script.length === 0) {
    return { error: EMPTY_SCRIPT_MESSAGE };
  }
  return { script };
}
