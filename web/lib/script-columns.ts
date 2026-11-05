// New pure module — not pulled out of an existing "use server" file, but
// following the same idiom as lib/recompile-guard.ts, lib/scene-split.ts and
// lib/talking-head.ts: the one genuinely interesting decision in "how do we
// turn an operator's pasted or uploaded script into per-line data" belongs
// in a plain, synchronous, unit-testable function, not inline in a Server
// Action or a form component where it can't be exercised without a browser
// or a database.
//
// SMN-feature-spec.md §3.3 describes the reference product's script input
// as two columns, `Script | Visual Idea`, with an `Include Visual Idea`
// toggle that lets the operator hand-author each shot's visual direction
// instead of leaving Claude to invent one. lib/claude.ts's buildDirectionBlock
// already does the equivalent thing at whole-project granularity (the
// `visual_idea` column, one override for the entire ad) — this is the same
// idea at one-row-per-scene granularity. See lib/claude.ts's
// buildVisualIdeaRowsBlock for where a parsed row actually reaches the
// compiler.
//
// ## Delimiter choice
//
// Two real input paths, two different natural delimiters:
//
//   * Pasting two columns out of Google Sheets/Excel/a doc table into a
//     plain <textarea> lands as TAB-separated values, one row per line —
//     that is what the clipboard actually contains for a copied range, not
//     a formatting choice we get to make. Detecting a literal tab is
//     therefore the zero-training-required path: an operator working from a
//     spreadsheet never has to know a delimiter convention exists at all.
//   * An operator typing a script by hand has no reliable way to produce a
//     literal tab inside a <textarea> (Tab moves focus in a plain textarea
//     unless the component intercepts the keystroke, which
//     character-setup-form.tsx's ScriptField deliberately does not —
//     hijacking Tab would break normal keyboard navigation and
//     paste-then-edit for every other field on the page). A hand-typed
//     script needs a delimiter the operator can actually type. We use `|`,
//     matching the spec's own "Script | Visual Idea" notation, which
//     doubles as the on-screen hint for what to type.
//
// Both are tried per LINE, not chosen once for the whole document — a real
// paste is ragged (some lines two-column, some one), and picking a single
// delimiter for the entire input would misparse the instant one line
// doesn't match it. Tab is tried first because it can never collide with
// typed content (nobody hand-types a literal tab into dialogue); `|` is
// tried second and CAN collide with dialogue that legitimately contains a
// pipe character. That is an accepted trade-off, not a bug: the preview
// table in character-setup-form.tsx exists specifically so a wrong split
// like that is obvious before it costs money, and an operator who needs a
// literal pipe in a line can fall back to the tab-separated spreadsheet-paste
// path instead, where no such collision is possible.
//
// ## Ragged-input policy
//
// Real pastes are never clean. Every case below is asserted in
// script-columns.test.ts, and none of them throw — a parser that can't
// finish because of one odd line is worse than one that makes a defensible
// call on every line and lets the preview surface anything that looks wrong:
//
//   * A line with no delimiter at all -> one column: { script: line,
//     visualIdea: null }. This is also what keeps a single-column paste —
//     every existing project, before this feature existed — parsing
//     identically to today: zero delimiters anywhere means every row comes
//     back visualIdea: null, which is exactly the shape
//     scriptRowsHaveVisualIdea reads as "nothing to expand," so
//     compileBrief (lib/claude.ts) and actions/compile.ts fall straight
//     back to sending the script exactly as before.
//   * A fully blank line -> dropped, not returned as an empty row. Scripts
//     routinely have blank lines between paragraphs; turning each into a
//     phantom row would inflate the parsed-line count the preview shows and
//     could hand the compiler a zero-content scene.
//   * A visual idea with an empty script cell (`\tsome cutaway shot` or
//     `|some cutaway shot`) -> KEPT, as { script: "", visualIdea: "some
//     cutaway shot" }, not dropped. This is a real, meaningful row — a
//     B-roll/product beat with no spoken line, which
//     0019_seed_template_v5.sql §1 already tells the compiler to give its
//     own scene ("B-roll or product-only beats with no spoken line still
//     get their own scene"). Only a row that is empty on BOTH sides is
//     noise.
//   * Trailing whitespace on either cell -> trimmed.
//   * `\r\n` (Windows line endings, common from a .txt export) -> normalized
//     before splitting into lines, so a CRLF file doesn't leave a stray
//     `\r` stuck to the last cell of every line.
//   * The split happens on the FIRST delimiter occurrence only, so a
//     visual-idea cell that itself contains a tab or pipe doesn't fragment
//     into extra columns — only the script/visual-idea boundary matters,
//     not anything after it.
//   * A delimiter present but nothing after it (a spreadsheet's trailing
//     empty cell, e.g. `line one\t`) collapses to the same visualIdea: null
//     as no delimiter at all, rather than an empty string — "no visual
//     idea for this row" should look identical downstream regardless of
//     which of those two things actually produced it.
//
// No header-row detection: a pasted "Script<TAB>Visual Idea" title row
// parses as an ordinary (obviously wrong-looking) row rather than being
// silently guessed at and stripped. Guessing which row is a header is
// exactly the kind of silent misinterpretation the preview panel exists to
// catch — better to show the operator an obviously-off first row they can
// delete than to have the parser guess and occasionally guess wrong with
// nothing on screen to catch it.

/** One row of the parsed script — a script line paired with the operator's
 *  own visual direction for it, when they gave one. */
export interface ScriptRow {
  /** The dialogue/action line — the same text a one-column script has
   *  always carried. Can be empty for a visual-only (B-roll/product) beat
   *  — see the ragged-case note above. */
  script: string;
  /** The operator's hand-authored visual direction for this row, or null
   *  when this row has no second column: plain single-column input, or a
   *  two-column paste where this particular line carries no delimiter (or
   *  an empty one). */
  visualIdea: string | null;
}

// Tried in this order — see the header comment for why tab comes first.
const DELIMITERS = ["\t", "|"] as const;

function splitRow(line: string): ScriptRow {
  for (const delimiter of DELIMITERS) {
    const at = line.indexOf(delimiter);
    if (at === -1) continue;
    const script = line.slice(0, at).trim();
    const visualIdeaCell = line.slice(at + delimiter.length).trim();
    return { script, visualIdea: visualIdeaCell.length > 0 ? visualIdeaCell : null };
  }
  return { script: line.trim(), visualIdea: null };
}

/**
 * Parses a raw pasted or uploaded script into one row per line. See this
 * file's header comment for the delimiter choice and the full ragged-input
 * policy — every case there is exercised in script-columns.test.ts.
 *
 * Never throws: a script is operator-typed free text with no schema to
 * validate against, and a parser that can fail on odd input would block
 * the one workflow this feature exists to make safer (see
 * character-setup-form.tsx's preview panel, which is the actual backstop
 * against a bad parse).
 */
export function parseTwoColumnScript(raw: string): ScriptRow[] {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const rows: ScriptRow[] = [];

  for (const line of normalized.split("\n")) {
    if (line.trim().length === 0) continue;

    const row = splitRow(line);
    if (row.script.length === 0 && row.visualIdea === null) continue;

    rows.push(row);
  }

  return rows;
}

/**
 * Whether any row actually carries a visual idea — the signal both
 * actions/compile.ts (should the script sent to Claude be rebuilt from
 * `.script` cells instead of the raw paste?) and lib/claude.ts's
 * compileBrief (is there anything for the "Operator-authored visual ideas"
 * section to say?) use to decide whether this project's script is really
 * two-column, as opposed to a plain script that happens to contain a
 * stray tab or pipe with nothing meaningful after it.
 */
export function scriptRowsHaveVisualIdea(rows: readonly ScriptRow[]): boolean {
  return rows.some((row) => row.visualIdea !== null);
}

/**
 * Rebuilds a plain, single-column script string from parsed rows — the
 * `.script` cells only, one per line, in order. Used by actions/compile.ts
 * to give Claude a clean script (no stray delimiter characters, no
 * visual-idea text mixed into what's supposed to be spoken dialogue) once
 * scriptRowsHaveVisualIdea has confirmed the paste really is two-column;
 * the per-line visual ideas travel to the model separately (see
 * lib/claude.ts's buildVisualIdeaRowsBlock), not inline in this string.
 *
 * Rows with an empty `.script` cell (a visual-only beat — see this file's
 * header) are skipped here: they have nothing to contribute to a plain
 * script line, and their visual idea is still carried through the
 * "Operator-authored visual ideas" section on its own.
 */
export function scriptTextFromRows(rows: readonly ScriptRow[]): string {
  return rows
    .map((row) => row.script)
    .filter((script) => script.length > 0)
    .join("\n");
}

// ---------------------------------------------------------------------------
// .txt upload validation — same idiom as lib/file-type.ts's predicates for
// the reference-image dropzone (isAcceptedReferenceImage /
// isAcceptedReferenceImageSize), scoped to a script file instead of an
// image. Kept here rather than added to file-type.ts: that file's own
// header ties it specifically to components/reference-dropzone.tsx's image
// upload, and a script file has a different accepted-type set and a much
// smaller size ceiling — this module is the script-specific home for it.
// character-setup-form.tsx's script upload control imports
// lib/file-type.ts's formatFileSizeMB directly for the shared "human
// readable size" formatting rather than duplicating it here.
// ---------------------------------------------------------------------------

const ACCEPTED_SCRIPT_MIME_TYPES: ReadonlySet<string> = new Set(["text/plain"]);
const ACCEPTED_SCRIPT_EXTENSIONS: readonly string[] = [".txt"];

/**
 * Spec §3.3's Ad Script upload accepts `.txt`. Same MIME-miss fallback to
 * extension as isAcceptedReferenceImage (lib/file-type.ts) — some OS file
 * pickers hand a blank or generic MIME type to the browser for a plain text
 * file, so a MIME miss falls back to the filename rather than rejecting a
 * genuine .txt outright.
 */
export function isAcceptedScriptFile(file: { type: string; name: string }): boolean {
  if (ACCEPTED_SCRIPT_MIME_TYPES.has(file.type)) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return ACCEPTED_SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// A script is plain text, not a photo — even a genuinely long ad script
// (thousands of lines) is a few hundred KB at most. 1MB is generous
// headroom over that while staying two orders of magnitude below
// lib/file-type.ts's 10MB reference-image ceiling, on purpose: a .txt file
// anywhere near that size is far more likely to be the wrong file picked by
// mistake than a real script.
export const MAX_SCRIPT_FILE_BYTES = 1 * 1024 * 1024;

/** True when a file is under the script-upload size ceiling (see `MAX_SCRIPT_FILE_BYTES`). */
export function isAcceptedScriptFileSize(file: { size: number }): boolean {
  return file.size <= MAX_SCRIPT_FILE_BYTES;
}

// ---------------------------------------------------------------------------
// Mis-paste detection
// ---------------------------------------------------------------------------

// A whole ad crammed onto one line, because the source lost its newlines on
// the way to the clipboard (a PDF, a chat message, a doc where the "lines"
// were wrapped rather than separate paragraphs). This is the exact failure
// character-setup-form.tsx's ScriptPreview says it exists to catch — and
// until now it only ever reported it as a flat, unremarkable "1 line
// parsed", in the same grey as every other count. A correct one-line script
// and an entire mis-pasted ad rendered identically.
//
// Two signals together, because neither alone is honest:
//
//   * Length. A short single line is just a short script — plenty of real
//     ads are one sentence, and flagging those would train the operator to
//     ignore the warning.
//   * Sentence count. A single LONG sentence is still plausibly one beat
//     ("...and that's why I've been reaching for this every single morning
//     before I even think about leaving the house"). Several sentences with
//     no line break between them is the thing that is almost never
//     deliberate.
//
// Deliberately scoped to a single parsed row. A mis-paste that still
// produced a handful of ragged rows is not reliably distinguishable from a
// legitimately dense script, and a warning that fires on real input is
// worse than no warning at all.

/** Minimum characters before a single-row script is even considered suspicious. */
const UNSPLIT_MIN_CHARS = 180;

/** Minimum sentence terminators before a long single row reads as several beats run together. */
const UNSPLIT_MIN_SENTENCES = 3;

/** `.`, `!`, `?` or `…` that actually ends a sentence — i.e. followed by whitespace or the end of the text. */
const SENTENCE_END_RE = /[.!?…](\s|$)/g;

/**
 * True when the parsed script is one row that looks like a whole ad with its
 * line breaks lost. Advisory only — nothing gates on this, and the operator
 * can compile straight through it, because the heuristic above is a guess
 * about intent and a script genuinely can be one long line.
 */
export function looksLikeUnsplitParagraph(rows: readonly ScriptRow[]): boolean {
  if (rows.length !== 1) {
    return false;
  }
  const [row] = rows as [ScriptRow];
  const text = row.script;
  if (text.length < UNSPLIT_MIN_CHARS) {
    return false;
  }
  return (text.match(SENTENCE_END_RE) ?? []).length >= UNSPLIT_MIN_SENTENCES;
}
