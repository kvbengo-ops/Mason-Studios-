// A native <option> must carry its own colours, or it is unreadable in dark mode.
//
// Chrome paints a <select>'s open option list itself. The CLOSED control
// inherits the page's text colour like any other element, which is why the
// collapsed dropdown always looked right and only the open list was broken —
// pale text on a white popup, reported live on /ugc's Length control.
//
// Two things were tried. Declaring `color-scheme` per theme (config/themes/*.css)
// is the broad fix and is still there: it is the only lever that reaches
// scrollbars, date pickers, autofill, and the truly-native popups macOS renders,
// none of which take CSS colours at all. But on Chrome for Windows — what this
// team actually uses — it did NOT fix the dropdown when tested. Explicit
// `bg-popover text-popover-foreground` on each <option> did, because Chrome on
// Windows and Linux honours background-color and color on option elements.
//
// So this sweep pins the fix that was observed to work, on every native select
// in the codebase rather than the one that got reported. It is a source sweep,
// the same shape as lib/spend-seam.test.ts and lib/guard-seam.test.ts, and it
// exists because the failure mode is invisible in review: a new <select> looks
// completely fine in the light theme, and nothing fails until someone in dark
// mode opens it.
//
// WHAT THIS DOES NOT PROVE. It reads source text, so it can only see that the
// classes are present — not that the tokens resolve to a readable pair, and not
// that macOS renders any of it. Those need eyes on a screen. This catches the
// omission, which is the failure that actually happens.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** POSIX-separated path relative to web/, so the assertions read the same on Windows. */
function rel(absolutePath: string): string {
  return relative(WEB_ROOT, absolutePath).split(sep).join("/");
}

function tsxFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      found.push(...tsxFilesUnder(full));
      continue;
    }
    if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) found.push(full);
  }
  return found;
}

/**
 * Source with comments removed.
 *
 * Not optional. This codebase writes long explanatory comments that mention
 * `<select>` in prose — page-size-control.tsx and project-filters.tsx each
 * explain why they are deliberately NOT a select, and app/(app)/layout.tsx
 * describes Radix's hidden native one. Scanning raw source reported all four
 * as violations, which is the sweep accusing its own documentation. Strip
 * comments first, then look for tags.
 *
 * Crude on purpose — a presence check over source text, not a parser. A
 * string containing "//" inside JSX (a URL, say) loses its tail here, which
 * can only make the sweep miss something, never invent a violation.
 */
function withoutComments(source: string): string {
  const blockStripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return blockStripped
    .split("\n")
    .map((line) => {
      const marker = line.indexOf("//");
      if (marker === -1) return line;
      // Leave "https://" and friends alone — only a "//" that is not preceded
      // by ":" is treated as a comment start.
      if (marker > 0 && line[marker - 1] === ":") return line;
      return line.slice(0, marker);
    })
    .join("\n");
}

/**
 * Every opening tag of `name`, from `<name` to its real closing `>`.
 *
 * A `/<select\b[^>]*>/` regex is the obvious version and it is WRONG here, in a
 * way that reported both correct files as violations: an arrow function in an
 * attribute contains a `>`.
 *
 *     <select
 *       onChange={(e) => setDurationS(...)}     <-- the naive regex stops HERE
 *       className="... text-foreground ..."     <-- so it never sees this
 *     >
 *
 * The class it is looking for sits after the handler, so the sweep declared
 * the fix missing on the very lines that carry it. Track `{}` depth instead
 * and take the first `>` at depth zero.
 */
function openingTagsFor(source: string, name: string): string[] {
  const clean = withoutComments(source);
  const tags: string[] = [];
  const opener = `<${name}`;

  for (let i = clean.indexOf(opener); i !== -1; i = clean.indexOf(opener, i + 1)) {
    // `<option` must not match `<options`; the next char ends the tag name.
    const after = clean[i + opener.length];
    if (after !== undefined && /[A-Za-z0-9_-]/.test(after)) continue;

    let depth = 0;
    for (let j = i + opener.length; j < clean.length; j += 1) {
      const ch = clean[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) {
        tags.push(clean.slice(i, j + 1));
        break;
      }
    }
  }
  return tags;
}

function optionTagsIn(source: string): string[] {
  return openingTagsFor(source, "option");
}

function selectTagsIn(source: string): string[] {
  return openingTagsFor(source, "select");
}

describe("native <select> colours survive dark mode", () => {
  const files = tsxFilesUnder(join(WEB_ROOT, "components")).concat(
    tsxFilesUnder(join(WEB_ROOT, "app")),
  );

  it("finds the native selects it is meant to be guarding", () => {
    // A sweep that silently matches nothing is a sweep that has stopped
    // working, and the two assertions below both pass vacuously on an empty
    // list. So count what was actually found.
    //
    // COUNT TAGS, NOT FILES. An earlier version of this asserted two *files*
    // carried a select, which was true only because ugc-reference-picker.tsx
    // had a Category one — and #53 replaced that with a read-only pill, since
    // the category is decided by the file's own kind at upload. The guard went
    // red for a reason that had nothing to do with dropdown colours. A file
    // count measures where the selects happen to live; a tag count measures
    // whether there is anything left to guard, which is the actual question.
    const selects = files.flatMap((f) => selectTagsIn(readFileSync(f, "utf8")));
    const options = files.flatMap((f) => optionTagsIn(readFileSync(f, "utf8")));
    expect(selects.length).toBeGreaterThan(0);
    expect(options.length).toBeGreaterThan(0);
  });

  it("gives every <option> an explicit background and foreground", () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const tag of optionTagsIn(readFileSync(file, "utf8"))) {
        const hasBackground = tag.includes("bg-popover");
        const hasForeground = tag.includes("text-popover-foreground");
        if (!hasBackground || !hasForeground) {
          offenders.push(`${rel(file)}: ${tag.replace(/\s+/g, " ").slice(0, 80)}`);
        }
      }
    }

    expect(
      offenders,
      "An <option> without explicit colours renders as pale text on a white " +
        'popup in dark mode. Add `className="bg-popover text-popover-foreground"`.',
    ).toEqual([]);
  });

  it("gives every native <select> an explicit text colour", () => {
    // The closed control inherits, so this is belt-and-braces rather than the
    // bug itself — but `bg-transparent` on a select whose ancestor colour
    // changes is exactly how the closed state drifts, and both existing
    // selects set bg-transparent.
    const offenders: string[] = [];

    for (const file of files) {
      for (const tag of selectTagsIn(readFileSync(file, "utf8"))) {
        if (!tag.includes("text-foreground")) {
          offenders.push(`${rel(file)}: ${tag.replace(/\s+/g, " ").slice(0, 80)}`);
        }
      }
    }

    expect(
      offenders,
      "A native <select> should set its own `text-foreground` rather than inherit.",
    ).toEqual([]);
  });
});
