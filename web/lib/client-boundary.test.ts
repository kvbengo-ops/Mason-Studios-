// The bug this file exists to stop from recurring: PaginationControls
// started calling useLinkStatus, which makes it a Client Component. Six
// Server Components (app/(app)/projects, /users, /allowances, /library,
// /spend, and projects/[id]/character) were still passing it
// `buildHref: (page: number) => string` — a plain closure. React throws
// "Functions cannot be passed directly to Client Components" the moment
// that prop crosses the boundary, and the whole route renders the error
// page instead. Every one of those pages' own tests passed the whole time,
// before and after: a test renders a component directly in jsdom, where
// there is no Server/Client split to cross, so nothing in the suite ever
// exercises the boundary itself. That is the gap this file closes.
//
// The rule was already written down in prose — see
// components/sidebar-shell.tsx's header ("never a function prop across the
// Server/Client boundary") and lib/projects-url.ts's header — but prose
// enforces nothing. This sweeps every Server Component under app/ and
// components/, finds every Client Component it imports and renders as
// JSX, and fails on any prop passed to that JSX whose value is a function.
//
// Same house style as lib/guard-seam.test.ts and lib/models-drift.test.ts:
// source is parsed as text, not with a real AST/TS type-checker (there is
// no cheap way to ask "is this expression's TYPE a function" without one),
// so every classification below is a deliberately readable regex/scan
// rather than a general JS parser. Where a shape can't be told apart
// reliably from text, this errs toward a FALSE NEGATIVE — silently missing
// a real bug — rather than a false positive that would train people to
// ignore this test. The specific gaps are called out inline below.
//
// What this deliberately does NOT flag:
//   - A function imported from a "use server" module (anything under
//     web/actions/ — see actions/*.ts's own "use server" directive and
//     components/action-form.tsx's header). React serialises those as
//     references; passing one is the documented, supported mechanism this
//     app relies on throughout. Excluded by construction: the bare-
//     identifier check only flags a name DECLARED in the same file via
//     `function name(...)` or `const name = (...) => ...` — an imported
//     Server Action is neither, so it never matches.
//   - `identifier.bind(null, ...)` (the exact shape actions/*.ts callers
//     use to pre-bind a Server Action to an id) — its text doesn't match
//     the bare-identifier pattern (dots/parens disqualify it) or the
//     inline-function patterns, so it's never flagged. That's also a
//     latent gap: a plain closure written as `someClosure.bind(...)`
//     would slip through the same way. Nothing in this codebase does that
//     today; if it ever does, this guard will miss it.
//   - Client Component -> Client Component. Only Server Components (a
//     .tsx under app/ or components/ with no "use client") are swept as
//     sources; a Client Component is never treated as a source file here.
//   - Any prop value that isn't a `{...}` expression at all (a string
//     literal, boolean shorthand, `className="..."`) or a `{...}` whose
//     inner text isn't shaped like a function.
//
// Known, accepted gaps in the sweep itself (false negatives, chosen over
// false positives):
//   - Spread props (`<Foo {...rest} />`) are not expanded, so a function
//     hiding inside a spread object is invisible to this check.
//   - A bare identifier prop is only checked against functions declared
//     in the SAME file. An identifier imported from a plain (non-"use
//     server") local module and passed straight through is not resolved
//     transitively — per the task's own spec, only same-file declarations
//     count.
//   - JSX tags are found by literal tag name (`<PaginationControls`), not
//     by resolving `React.createElement` calls, dynamically computed tag
//     names (`<Comp.Sub>`), or components rendered via a variable holding
//     a component reference (`const C = cond ? A : B; <C .../>`).
//   - Default-exported components are supported (a file's `export
//     default` is treated as satisfying `import Name from "..."`), but no
//     Server Component in this repo currently imports one that way — the
//     Next.js special files (page.tsx, layout.tsx, error.tsx,
//     not-found.tsx) are invoked by the framework, not imported and
//     rendered as JSX by another Server Component, so this path is
//     exercised by the resolver logic but not by any real violation today.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Same "resolve off import.meta.url, not process.cwd()" reasoning as
// lib/guard-seam.test.ts and lib/version.test.ts.
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = join(WEB_ROOT, "app");
const COMPONENTS_DIR = join(WEB_ROOT, "components");

/** Recursively collects every .tsx file under `dir`, excluding *.test.tsx
 * (a test renders components directly in jsdom — there is no Server/Client
 * boundary inside a test file, and its mock props/callbacks are not the
 * shape this guard is checking). */
function findTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...findTsxFiles(fullPath));
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      results.push(fullPath);
    }
  }
  return results;
}

/** The first non-comment, non-blank line of `source`, stripped of leading
 * `//` and `/* *\/` comments — this is what "use client" gets checked
 * against, matching how Next.js itself recognises the directive. */
function firstNonCommentLine(source: string): string {
  let rest = source;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("//")) {
      const nl = rest.indexOf("\n");
      rest = nl === -1 ? "" : rest.slice(nl + 1);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end === -1 ? "" : rest.slice(end + 2);
      continue;
    }
    break;
  }
  const nl = rest.indexOf("\n");
  return (nl === -1 ? rest : rest.slice(0, nl)).trim();
}

function isClientComponent(source: string): boolean {
  const first = firstNonCommentLine(source);
  return (
    first === '"use client";' ||
    first === "'use client';" ||
    first === '"use client"' ||
    first === "'use client'"
  );
}

interface ExportInfo {
  /** Capitalized named exports — the only ones that can be JSX tag names. */
  named: string[];
  hasDefault: boolean;
}

/** Pulls out `export function Name`, `export const Name = ...`, and
 * `export { a, b as Name }` — capitalized ones only, since a lowercase
 * export can never be used as a JSX tag. */
function exportedComponentNames(source: string): ExportInfo {
  const named = new Set<string>();
  for (const m of source.matchAll(/export\s+function\s+([A-Z]\w*)\s*\(/g)) {
    named.add(m[1] as string);
  }
  for (const m of source.matchAll(/export\s+const\s+([A-Z]\w*)\s*[:=]/g)) {
    named.add(m[1] as string);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(spec);
      const exportedName = asMatch ? (asMatch[2] as string) : spec;
      if (/^[A-Z]/.test(exportedName)) named.add(exportedName);
    }
  }
  const hasDefault = /export\s+default\s+/.test(source);
  return { named: [...named], hasDefault };
}

interface ImportedName {
  /** The name this file refers to it by. */
  local: string;
  /** The name it's exported as on the other side ("default" for a
   * default import). */
  imported: string;
  specifier: string;
}

/** Parses `import Name from "spec"`, `import { A, B as C } from "spec"`,
 * and `import Name, { A } from "spec"`. `import type {...}` is excluded —
 * a type-only import can never be a JSX tag, only its type. */
function parseImports(source: string): ImportedName[] {
  const results: ImportedName[] = [];

  const combinedRe =
    /import\s+(?!type\s)(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/g;
  for (const m of source.matchAll(combinedRe)) {
    const defaultLocal = m[1];
    const specifierList = m[2] ?? "";
    const specifier = m[3] ?? "";
    if (defaultLocal) {
      results.push({ local: defaultLocal, imported: "default", specifier });
    }
    for (const raw of specifierList.split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(spec);
      const imported = asMatch ? (asMatch[1] as string) : spec;
      const local = asMatch ? (asMatch[2] as string) : spec;
      results.push({ local, imported, specifier });
    }
  }

  const defaultOnlyRe = /import\s+(?!type\s)([A-Za-z_$][\w$]*)\s*from\s*["']([^"']+)["'];?/g;
  for (const m of source.matchAll(defaultOnlyRe)) {
    results.push({ local: m[1] as string, imported: "default", specifier: m[2] as string });
  }

  return results;
}

/** Resolves an import specifier to an absolute file path, or null when
 * it's an external package (not ours to check) or nothing on disk matches
 * any of the extensions/index shapes this repo actually uses. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = join(WEB_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = join(dirname(fromFile), specifier);
  } else {
    return null;
  }
  const candidates = [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Finds every opening JSX tag `<TagName ...>` or `<TagName ... />` for
 * `tagName` in `source`, returning each tag's full text (attributes
 * included, closing `children` excluded). Scans char-by-char tracking
 * brace depth and string state so a `>` used inside a prop's expression
 * (e.g. `disabled={page > 1}`) doesn't prematurely end the tag — the same
 * kind of balanced scan lib/guard-seam.test.ts uses for brace matching. */
function extractOpeningTags(source: string, tagName: string): string[] {
  const tags: string[] = [];
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openRe = new RegExp(`<${escaped}(?=[\\s/>])`, "g");
  for (const m of source.matchAll(openRe)) {
    const start = m.index;
    let i = start + m[0].length;
    let braceDepth = 0;
    let inString: string | null = null;
    while (i < source.length) {
      const ch = source[i];
      if (inString) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === inString) inString = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        i++;
        continue;
      }
      if (ch === "{") {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === "}") {
        braceDepth--;
        i++;
        continue;
      }
      if (braceDepth === 0 && ch === ">") break;
      i++;
    }
    tags.push(source.slice(start, i + 1));
  }
  return tags;
}

interface PropValue {
  name: string;
  /** Text inside the `{...}`, or the raw string literal — only "brace"
   * values are ever function-shaped, so string/other are carried for
   * completeness but never classified as a function. */
  raw: string;
  kind: "brace" | "string" | "other";
}

/** Splits one opening-tag's text into its `name={...}` / `name="..."`
 * props, using the same brace/string-aware scan as extractOpeningTags so a
 * prop value containing its own `{`/`}`/quotes doesn't truncate early. */
function extractProps(tagText: string): PropValue[] {
  const props: PropValue[] = [];
  const nameRe = /([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(tagText)) !== null) {
    const name = m[1] as string;
    const valueStart = nameRe.lastIndex;
    const ch = tagText[valueStart];
    if (ch === "{") {
      let depth = 0;
      let j = valueStart;
      for (; j < tagText.length; j++) {
        if (tagText[j] === "{") depth++;
        else if (tagText[j] === "}") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      props.push({ name, raw: tagText.slice(valueStart + 1, j - 1), kind: "brace" });
      nameRe.lastIndex = j;
    } else if (ch === '"' || ch === "'") {
      const end = tagText.indexOf(ch, valueStart + 1);
      const stop = end === -1 ? tagText.length : end + 1;
      props.push({ name, raw: tagText.slice(valueStart, stop), kind: "string" });
      nameRe.lastIndex = stop;
    } else {
      // Boolean shorthand (`disabled`) or something this scan doesn't
      // recognise — never function-shaped, so no further classification
      // needed.
      props.push({ name, raw: "", kind: "other" });
    }
  }
  return props;
}

/** True when `raw` (the text inside a prop's `{...}`) is itself shaped
 * like an inline function: an arrow (with or without parens around a
 * single param, `async` or not) or a `function` expression. */
function isInlineFunctionExpression(raw: string): boolean {
  const t = raw.trim();
  return (
    /^(?:async\s*)?function\b/.test(t) ||
    /^(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/.test(t) ||
    /^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(t)
  );
}

/** True when `raw` is nothing but a bare identifier (`buildHref`, not
 * `buildHref()` or `obj.buildHref` or `buildHref.bind(...)`). */
function bareIdentifier(raw: string): string | null {
  const t = raw.trim();
  return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
}

/** True when `source` declares `name` as a function in this same file —
 * `function name(...)` or `const name = (...) => ...` (with or without a
 * type annotation on the const, with or without parens around a single
 * arrow param). This is deliberately scoped to DECLARATIONS: an imported
 * name (a Server Action, or anything else) never matches, which is what
 * keeps "use server" exports out of this check without needing to special-
 * case them here. */
function declaresLocalFunction(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const funcDecl = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
  const arrowDecl = new RegExp(
    `\\bconst\\s+${escaped}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]+)?=>`,
  );
  const arrowDeclNoParens = new RegExp(
    `\\bconst\\s+${escaped}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*=>`,
  );
  return funcDecl.test(source) || arrowDecl.test(source) || arrowDeclNoParens.test(source);
}

interface FileEntry {
  isClient: boolean;
  named: string[];
  hasDefault: boolean;
  source: string;
}

interface Violation {
  file: string;
  component: string;
  prop: string;
  snippet: string;
}

function sweep(): Violation[] {
  const violations: Violation[] = [];
  const allFiles = [...findTsxFiles(APP_DIR), ...findTsxFiles(COMPONENTS_DIR)];
  const cache = new Map<string, FileEntry>();

  function load(path: string): FileEntry {
    const cached = cache.get(path);
    if (cached) return cached;
    const source = readFileSync(path, "utf8");
    const isClient = isClientComponent(source);
    const { named, hasDefault } = exportedComponentNames(source);
    const entry: FileEntry = { isClient, named, hasDefault, source };
    cache.set(path, entry);
    return entry;
  }

  for (const file of allFiles) {
    const { isClient, source } = load(file);
    if (isClient) continue; // Only Server Components are sources of the bug.

    for (const imp of parseImports(source)) {
      const resolved = resolveSpecifier(imp.specifier, file);
      if (!resolved) continue;
      const target = load(resolved);
      if (!target.isClient) continue;
      const isRenderedExport =
        imp.imported === "default" ? target.hasDefault : target.named.includes(imp.imported);
      if (!isRenderedExport) continue;

      for (const tag of extractOpeningTags(source, imp.local)) {
        for (const prop of extractProps(tag)) {
          if (prop.kind !== "brace") continue;

          let isFunctionValued = isInlineFunctionExpression(prop.raw);
          if (!isFunctionValued) {
            const bare = bareIdentifier(prop.raw);
            if (bare && declaresLocalFunction(source, bare)) isFunctionValued = true;
          }

          if (isFunctionValued) {
            violations.push({
              file: relative(WEB_ROOT, file),
              component: imp.local,
              prop: prop.name,
              snippet: prop.raw.trim().slice(0, 80),
            });
          }
        }
      }
    }
  }

  return violations;
}

describe("Server/Client boundary: no function-valued prop into a Client Component", () => {
  it("found at least one Server Component rendering a Client Component to examine", () => {
    // A sweep that silently examines zero files passes forever and guards
    // nothing (same reasoning as the sweep-count assertions in
    // lib/guard-seam.test.ts and lib/models-drift.test.ts). If this ever
    // fires, findTsxFiles/parseImports/resolveSpecifier has drifted from
    // this codebase's actual import shape — go fix the sweep, don't delete
    // this assertion.
    const allFiles = [...findTsxFiles(APP_DIR), ...findTsxFiles(COMPONENTS_DIR)];
    let examined = 0;
    for (const file of allFiles) {
      const source = readFileSync(file, "utf8");
      if (isClientComponent(source)) continue;
      for (const imp of parseImports(source)) {
        const resolved = resolveSpecifier(imp.specifier, file);
        if (!resolved) continue;
        const targetSource = readFileSync(resolved, "utf8");
        if (isClientComponent(targetSource)) examined++;
      }
    }
    expect(examined).toBeGreaterThan(0);
  });

  it("no Server Component passes a function-valued prop to a Client Component", () => {
    const violations = sweep();
    const failures = violations.map(
      ({ file, component, prop, snippet }) =>
        `${file} renders <${component}> (a Client Component) with ${prop}={${snippet}} — a ` +
        `function value. A function cannot cross the Server/Client boundary: React throws ` +
        `"Functions cannot be passed directly to Client Components" at render time and takes ` +
        `the whole route down (this is exactly how PaginationControls broke /projects, /users ` +
        `and /allowances at once). Fix it one of two ways: pass a plain string/serializable ` +
        `value instead (see components/pagination-controls.tsx's previousHref/nextHref, which ` +
        `replaced a buildHref callback for this reason), or move the builder into a shared pure ` +
        `module the Client Component can import and call for itself (see lib/projects-url.ts's ` +
        `header for the worked example) — or if ${prop} is meant to be a Server Action, make ` +
        `sure it's imported from a module whose first line is "use server" (web/actions/*.ts), ` +
        `which this check always allows.`,
    );
    expect(failures).toEqual([]);
  });
});
