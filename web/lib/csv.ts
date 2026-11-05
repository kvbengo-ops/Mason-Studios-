// RFC 4180 CSV quoting, as its own small pure module because hand-rolled
// `row.join(",")` corrupts a file silently the moment a field contains a
// comma, a double quote, or a newline — and that is exactly the shape of
// text an operator types into the Brief page's script-line and video-prompt
// fields (free text, no schema — see lib/script-columns.ts's header for the
// same "operator-typed, can contain anything" reasoning on the input side).
// A hand-rolled join doesn't error on that input: the file still opens,
// still looks plausible, and has silently shifted every column after the
// offending cell. That failure mode is the reason this is its own
// unit-tested file rather than inline in a route handler.
//
// No CSV library added for this: RFC 4180 quoting for a write-only,
// two-column-plus-metadata export is ~20 lines, well under the bar for
// pulling in a dependency (and CSV, unlike XLSX, was already decided
// against a library — see the Brief CSV export task).

/**
 * Characters that Excel and Google Sheets treat as "this cell is a
 * formula" when they appear first in a cell — "CSV injection" /
 * "formula injection". An operator can absolutely type a script line or a
 * video-prompt cell starting with a dash ("- cut to product on the
 * counter") or an at-sign, and nothing upstream (parseTwoColumnScript,
 * the Brief page's textareas) validates against it, so it has to be
 * handled at the one point where this data becomes a spreadsheet file.
 */
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

/**
 * Neutralises formula injection by prepending a single leading apostrophe,
 * the standard mitigation: the cell is no longer a formula, so nothing
 * executes when the file is opened.
 *
 * Be honest about the cost. A leading `'` is reliably a "force plain text"
 * marker when a value is TYPED or pasted into a cell, and it is hidden
 * there — but this file is opened via CSV import, and on that path some
 * spreadsheet versions show the apostrophe as an ordinary character
 * instead. So the guarantee this makes is "no formula runs," not "the
 * operator never sees an extra character." If a stray apostrophe in an
 * exported brief ever gets reported, that is this line, working as
 * intended, not a bug to chase.
 *
 * Chosen over stripping the triggering character, which would silently
 * rewrite the operator's actual words — turning "- cut to product" into
 * "cut to product". A visible apostrophe is a smaller harm than altered
 * text nobody was told about, and this export is for reading and review
 * (see lib/brief-csv.ts) rather than a file anything parses back.
 */
function neutralizeFormulaInjection(value: string): string {
  const first = value[0];
  if (first !== undefined && FORMULA_TRIGGER_CHARS.has(first)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Quotes and escapes a single CSV field per RFC 4180. `null` (this
 * project's convention for "no value" on a nullable text column, e.g.
 * scenes.video_prompt) is treated the same as an empty string rather than
 * the literal text "null".
 *
 * Formula-injection neutralisation runs first: a leading apostrophe can
 * never itself introduce a comma, quote, or newline, so it can never change
 * the quoting decision below — the two steps compose safely in either
 * order, but this order keeps the "does this need quoting" check reading
 * the same text a spreadsheet app will actually see.
 *
 * Quoting rule: wrap in double quotes when the field contains a comma, a
 * double quote, or a line break (LF or CR); double any embedded double
 * quote. A field needing no quoting is returned unchanged.
 */
export function csvField(value: string | null): string {
  const neutralized = neutralizeFormulaInjection(value ?? "");
  const needsQuoting = /[",\r\n]/.test(neutralized);
  if (!needsQuoting) return neutralized;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

/** Joins already-escaped fields into one CSV record (no trailing line break). */
export function csvRow(fields: readonly (string | null)[]): string {
  return fields.map(csvField).join(",");
}

/**
 * Builds a complete CSV document from a header row and data rows. CRLF
 * (`\r\n`) line endings throughout, per RFC 4180 §2.2 — Excel on Windows
 * expects them, and both Excel on macOS and Google Sheets accept them
 * without issue, so CRLF is the safer default in both directions. Ends
 * with a trailing CRLF after the last record.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  return [csvRow(header), ...rows.map(csvRow)].map((line) => line + "\r\n").join("");
}
