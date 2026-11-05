// Drift guard: adding a theme is supposed to be three edits — a file under
// config/themes/, an `@import` in app/globals.css, and an entry in
// THEME_LIST. Nothing in the type system connects those three, and every way
// of getting them out of step fails SILENTLY rather than loudly:
//
//   - A theme in THEME_LIST with no CSS file: the picker offers it, the
//     cookie accepts it, `<html data-theme="X">` gets stamped, and NOTHING
//     matches — so studio-light.css's bare `:root` arm paints instead and the user
//     picks a theme that appears to do nothing.
//   - A CSS file that globals.css never imports: identical symptom, and this
//     is the easiest of the three edits to forget because the file exists,
//     the id validates, and the picker looks correct.
//   - A theme file missing a token another theme declares: only the widgets
//     that use that token break. That has already shipped here once — the
//     status pills went grey in one theme because two theme files were
//     missing the ten `--status-*` names, and grey is a plausible-looking
//     colour, so nobody noticed from a screenshot.
//
// WHY TEXT, NOT A BROWSER — same reasoning as lib/db-types-drift.test.ts
// beside it: the failures above are all "the repo's own files disagree with
// each other", which is decidable from the files. The one thing that is NOT
// decidable from text is whether `@theme inline` still resolves colours at
// the element, so that one assertion actually compiles Tailwind.
//
// STRIP COMMENTS BEFORE MATCHING ANYTHING. These files document themselves
// heavily: `:root` appears inside studio-dark.css's header comment and
// declaration-shaped strings like `--warning:` appear inside studio-light.css's. A
// naive scan goes red on the repo's own untouched files.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEME_IDS, buildThemeScript } from "./theme";

// Resolve off import.meta.url, not process.cwd(), so this works wherever
// vitest is invoked from — same as lib/db-types-drift.test.ts.
const CONFIG_ROOT = fileURLToPath(new URL(".", import.meta.url));
const THEMES_DIR = join(CONFIG_ROOT, "themes");
const GLOBALS_CSS = join(CONFIG_ROOT, "..", "app", "globals.css");

/**
 * Theme tokens that legitimately have no `--color-*` twin in the `@theme
 * inline` block. `--radius` is a length, consumed by --radius-sm/md/lg/xl
 * rather than by a colour utility.
 */
const NON_COLOR_TOKENS = ["--radius"];

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const readCss = (path: string): string => stripComments(readFileSync(path, "utf8"));

const themeFile = (id: string): string => join(THEMES_DIR, `${id}.css`);

/** Custom-property names DECLARED in `css` (a `--name:` at declaration position). */
function declaredTokens(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(match[1]!);
  return names;
}

/**
 * Every rule prelude in `css`, whitespace-normalised: the text between the
 * previous `}` and the next `{`. Nested blocks (`@keyframes`) fall out of
 * this for free, which is why the selector arms can be compared literally.
 */
function ruleHeaders(css: string): string[] {
  const headers: string[] = [];
  for (const segment of css.split("{").slice(0, -1)) {
    const prelude = segment
      .slice(segment.lastIndexOf("}") + 1)
      .replace(/\s+/g, " ")
      .trim();
    if (prelude) headers.push(prelude);
  }
  return headers;
}

/**
 * The two-arm selector every theme file opens on. The default theme's first
 * arm is a BARE `:root` — that arm is also the fallback palette for an
 * unrecognised data-theme value. Every other theme needs the `:root[...]`
 * prefix at (0,2,0) to beat that bare `:root` at (0,1,0) regardless of
 * @import order.
 */
function expectedHeader(id: string): string {
  const arm = `[data-theme="${id}"]`;
  return id === DEFAULT_THEME ? `:root, ${arm}` : `:root${arm}, ${arm}`;
}

const ids = [...THEME_IDS].sort();

// Driven off the directory, not off THEME_IDS, so that a theme listed with no
// file surfaces as ONE clear failure below rather than an ENOENT that takes
// the whole file down during collection. Filter to .css: a stray .DS_Store or
// a README would otherwise red this with a message about a theme nobody added.
const present = readdirSync(THEMES_DIR)
  .filter((file) => file.endsWith(".css"))
  .map((file) => basename(file, ".css"))
  .sort();

const tokensByTheme = new Map(present.map((id) => [id, declaredTokens(readCss(themeFile(id)))]));

const allTokens = [...new Set(present.flatMap((id) => [...tokensByTheme.get(id)!]))].sort();

const themePairs: Array<[string, string]> = present.flatMap((a) =>
  present.filter((b) => b !== a).map((b): [string, string] => [a, b]),
);

describe("themes against config/theme.ts", () => {
  it("has exactly one CSS file per THEME_IDS entry", () => {
    expect(
      present,
      "config/themes/ and THEME_LIST disagree. A theme listed with no file is " +
        "offered by the picker and paints the default palette instead; a file " +
        "nobody lists is dead weight.",
    ).toEqual(ids);
  });

  it("imports every theme file from globals.css", () => {
    const imported = [
      ...readCss(GLOBALS_CSS).matchAll(/@import\s+"\.\.\/config\/themes\/([a-z0-9-]+)\.css"/g),
    ]
      .map((match) => match[1]!)
      .sort();

    expect(
      imported,
      "app/globals.css's theme @imports disagree with THEME_LIST. This is the " +
        "edit most often forgotten, and it fails silently: an unimported theme " +
        "matches no rule, so studio-light.css's bare `:root` paints and the picker " +
        "looks like it does nothing.",
    ).toEqual(ids);
  });

  it.each(present)("%s.css opens on its expected two-arm selector", (id) => {
    const headers = ruleHeaders(readCss(themeFile(id)));

    expect(
      headers,
      `${id}.css does not open on \`${expectedHeader(id)}\`. Found: ${headers.join(" | ")}`,
    ).toContain(expectedHeader(id));
  });

  it("puts the bare `:root` arm on exactly one theme, the default", () => {
    const withBareRoot = present.filter((id) =>
      ruleHeaders(readCss(themeFile(id))).some((header) =>
        header.split(",").some((arm) => arm.trim() === ":root"),
      ),
    );

    expect(
      withBareRoot,
      "Exactly one theme file may carry a bare `:root` arm — the default's, " +
        "which doubles as the fallback palette. A second one wins or loses by " +
        "@import order, which is not a thing anyone should have to reason about.",
    ).toEqual([DEFAULT_THEME]);
  });

  it.each(themePairs)("%s.css declares every token %s.css declares", (theme, other) => {
    const missing = [...tokensByTheme.get(other)!]
      .filter((token) => !tokensByTheme.get(theme)!.has(token))
      .sort();

    expect(
      missing,
      `${theme}.css is missing ${missing.join(", ")} — ${other}.css declares them. ` +
        "A token only some themes define breaks only the widgets that use it, " +
        "in only those themes. That is how the status pills went grey.",
    ).toEqual([]);
  });

  // The scans above are regexes over a formatting convention, so a reformat
  // could quietly match nothing and leave every assertion passing over empty
  // sets forever. This pins that the parse found real structure — same guard
  // as lib/db-types-drift.test.ts's "parsed a plausible amount".
  it("parsed a plausible number of tokens", () => {
    expect(allTokens.length).toBeGreaterThanOrEqual(40);
    expect(allTokens).toContain("--primary");
    expect(allTokens).toContain("--status-briefed");
    expect(allTokens).toContain("--sidebar-ring");
  });

  it.each(present)("%s.css declares color-scheme", (id) => {
    expect(
      readCss(themeFile(id)),
      `${id}.css does not set color-scheme. Without it the browser paints form ` +
        "controls, scrollbars and caret for the wrong lightness no matter what " +
        "the palette says.",
    ).toMatch(/(^|[\s;{])color-scheme\s*:/);
  });
});

describe("globals.css's @theme inline block against the theme tokens", () => {
  const colorRefs = [
    ...readCss(GLOBALS_CSS).matchAll(/--color-[a-z0-9-]+\s*:\s*hsl\(var\((--[a-z0-9-]+)/g),
  ].map((match) => match[1]!);

  it("references only tokens the themes declare", () => {
    const dangling = [...new Set(colorRefs)].filter((token) => !allTokens.includes(token)).sort();

    expect(
      dangling,
      `globals.css maps --color-* onto ${dangling.join(", ")}, which no theme file ` +
        "declares. Those utilities emit hsl() over an undefined variable — an " +
        "invalid colour, so the property is simply dropped.",
    ).toEqual([]);
  });

  it("gives every theme token a --color-* twin", () => {
    const untwinned = allTokens
      .filter((token) => !colorRefs.includes(token) && !NON_COLOR_TOKENS.includes(token))
      .sort();

    expect(
      untwinned,
      `The themes declare ${untwinned.join(", ")} but globals.css's @theme inline ` +
        "block exposes no --color-* for them, so no utility can reach them. Add " +
        "the mapping, or add the token to NON_COLOR_TOKENS if it is not a colour.",
    ).toEqual([]);
  });

  // The one assertion text cannot make. `@theme inline` is what compiles
  // `bg-primary` to `hsl(var(--primary))` — resolved AT THE ELEMENT, which is
  // what lets a nested `<span data-theme="dracula">` rescope a whole palette
  // and is the entire basis of the picker's swatches. Plain `@theme` instead
  // emits `var(--color-primary)` resolved once at `:root`, and every swatch
  // silently shows the active theme's colours. The block is located by a bare
  // `@theme` on purpose, so dropping the `inline` keyword reaches this compile
  // rather than being caught earlier as a missing string.
  it("resolves @theme colours at the element, not at :root", async () => {
    const css = readCss(GLOBALS_CSS);
    const open = /@theme\b[^{]*\{/.exec(css);
    expect(open, "app/globals.css no longer has an @theme block").not.toBeNull();

    let depth = 0;
    let end = -1;
    for (let i = open!.index + open![0].length - 1; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    expect(end, "app/globals.css's @theme block is unbalanced").toBeGreaterThan(0);

    const compiled = await compile(`@tailwind utilities;\n${css.slice(open!.index, end)}`);

    expect(
      compiled.build(["bg-primary"]),
      "bg-primary no longer compiles to hsl(var(--primary)). globals.css's " +
        "@theme block has lost its `inline` keyword (or Tailwind changed what it " +
        "means), so colours resolve once at :root and every nested " +
        "`data-theme` scope — the picker's swatches — paints the active theme.",
    ).toContain("hsl(var(--primary))");
  });
});

describe("the runtime seam", () => {
  it("teaches the anti-flash script every theme id", () => {
    const script = buildThemeScript();
    const unknown = ids.filter((id) => !script.includes(JSON.stringify(id)));

    expect(
      unknown,
      `The inline <head> script does not accept ${unknown.join(", ")}, so a cookie ` +
        "holding one is ignored before first paint and the user's chosen theme " +
        "loses to the build-time default on every load.",
    ).toEqual([]);
  });

  it("keeps Tailwind's dark variant pointed at a class nothing sets", () => {
    expect(
      readCss(GLOBALS_CSS),
      "app/globals.css lost `@custom-variant dark`. Tailwind's built-in `dark` " +
        "variant is then @media (prefers-color-scheme: dark) again, and every " +
        "`dark:` utility fires on the viewer's OS setting, uncorrelated with " +
        "data-theme.",
    ).toContain("@custom-variant dark");
  });
});
