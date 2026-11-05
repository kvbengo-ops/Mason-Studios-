// The bug this file exists to stop from recurring: a page can guard its own
// entry with the permissive `requireProjectReadable` (a non-owning admin is
// let through, isOwner:false) and then, in the very same render, await a
// server action that guards ITSELF with the strict, owner-only
// `requireProject` (which calls notFound() for anyone who isn't the owner).
// Both guards are individually correct — the defect lives in the SEAM
// between them, not inside either one. That is exactly what happened in
// production: app/(app)/projects/[id]/deliver/page.tsx let a non-owning
// admin through its own door with requireProjectReadable, then six lines
// later awaited getCutStatus(id) from @/actions/deliver, which was still
// guarded with requireProject — so the admin was notFound()'d out of a page
// they had just been admitted to, mid-render.
//
// actions/guard.test.ts cannot catch this class of bug no matter how
// thoroughly it's written: it tests each guard function in isolation, and
// neither guard misbehaved on its own. requireProject correctly refused a
// non-owner; requireProjectReadable correctly admitted one. The bug only
// exists in the combination of "this page's door" and "this action awaited
// inside it," which a per-function unit test has no way to see.
//
// This test sweeps every page.tsx/layout.tsx under app/(app)/projects/[id]/
// that guards itself with requireProjectReadable, finds every action
// identifier imported from @/actions/* that the page actually AWAITS in its
// module body (as opposed to merely importing and handing to a client
// component as a <form action> prop, which runs later, after render, on
// submit — those are correctly strict and must not be flagged), and asserts
// that action's own guard is requireProjectReadable, not requireProject.
//
// The awaited-vs-passed-as-prop distinction is read off actual source text,
// not parsed with a real AST — it works because this codebase draws that
// line consistently in the source itself: an action deferred to a later
// submit is always written as `actionName.bind(null, id)`, and an action
// invoked during render is always written as a direct call, `actionName(id)`,
// which regex-matches `actionName(` and never `actionName.bind(`. If a page
// or action file ever stops following that convention, the file-existence
// and sweep-count assertions below are designed to fail loudly rather than
// silently pass having examined nothing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECTS_ID_DIR = join(WEB_ROOT, "app", "(app)", "projects", "[id]");
// /ugc is a second project-scoped surface and is swept for the same seam.
//
// It cannot fail this check today: its page guards with requireProject, the
// STRICT door, and the defect hunted here is a READABLE door with a strict
// action behind it. That is exactly why it is added — the sweep's scope is
// the set of pages that could develop the shape, not the set that has it. The
// day someone loosens /ugc to requireProjectReadable so a non-owning admin can
// look at a project's clips, every action it awaits becomes a candidate, and
// a scope pinned to one directory would have said nothing.
const UGC_ID_DIR = join(WEB_ROOT, "app", "(app)", "ugc", "[id]");
// /images is the third project-scoped surface (0084_image_project_kind.sql) and
// is swept for the same seam. Its page guards with the READABLE door so a
// non-owning admin can look, while generateProjectImage behind it guards with
// the strict requireProject — exactly the shape this file exists to police. It
// is safe today only because the page hands that action over as
// `generateProjectImage.bind(null, id)` rather than awaiting it during render;
// the sweep is what keeps that true.
const IMAGES_ID_DIR = join(WEB_ROOT, "app", "(app)", "images", "[id]");
const ACTIONS_DIR = join(WEB_ROOT, "actions");
const API_PROJECTS_ID_DIR = join(WEB_ROOT, "app", "api", "projects", "[id]");

/** Recursively collects every page.tsx/layout.tsx under `dir`. */
function findPageAndLayoutFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...findPageAndLayoutFiles(fullPath));
    } else if (entry === "page.tsx" || entry === "layout.tsx") {
      results.push(fullPath);
    }
  }
  return results;
}

interface NamedImport {
  local: string;
  source: string; // e.g. "@/actions/deliver"
}

/**
 * Parses every `import { a, b as c } from "@/actions/xxx";` statement in
 * `source`, returning one entry per named import. Only named imports off
 * `@/actions/...` matter here — default/namespace imports and imports from
 * anywhere else are outside this rule's scope.
 */
function parseActionsImports(source: string): NamedImport[] {
  const imports: NamedImport[] = [];
  const importRegex = /import\s*\{([^}]*)\}\s*from\s*["'](@\/actions\/[^"']+)["'];?/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    const specifierList = match[1] ?? "";
    const source_ = match[2] ?? "";
    for (const rawSpecifier of specifierList.split(",")) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(specifier);
      const local = asMatch ? (asMatch[2] ?? specifier) : specifier;
      imports.push({ local, source: source_ });
    }
  }
  return imports;
}

/**
 * True when `identifier` appears in `source` as a direct call — `foo(` —
 * during module-body evaluation, as opposed to only ever appearing as
 * `foo.bind(`. A direct call site only counts if it's awaited: either
 * `await foo(...)` directly, or as an element inside an `await
 * Promise.all([...])` array. Both shapes are detected the same way — walk
 * backward from the call site to the nearest statement boundary (`;`) and
 * check whether an `await` appears before that boundary is hit.
 */
function isAwaitedInModuleBody(source: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Negative lookbehind excludes `identifier.bind(` (preceded by `.`) and
  // any accidental substring match (preceded by a word character).
  const callRegex = new RegExp(`(?<![.\\w$])${escaped}\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(source)) !== null) {
    const callIndex = match.index;
    const windowStart = Math.max(0, callIndex - 2000);
    const window = source.slice(windowStart, callIndex);
    const lastSemicolon = window.lastIndexOf(";");
    const lastAwait = window.lastIndexOf("await");
    if (lastAwait > lastSemicolon) {
      return true;
    }
  }
  return false;
}

/** Resolves "@/actions/deliver" to <web>/actions/deliver.ts. */
function resolveActionsModule(specifier: string): string {
  const rel = specifier.replace(/^@\/actions\//, "");
  return join(ACTIONS_DIR, `${rel}.ts`);
}

type Guard = "requireProjectReadable" | "requireProject" | "unknown";

/**
 * Finds `export async function <name>(...) { ... }` in `source` and
 * classifies which guard its body calls. `requireProject(` and
 * `requireProjectReadable(` are mutually exclusive substrings by
 * construction — the character immediately after `requireProject` in
 * `requireProjectReadable(` is `R`, not `(`, so a literal search for
 * `requireProject(` can never match inside `requireProjectReadable(`.
 * That's what makes this safe without a real parser.
 */
function findExportedFunctionGuard(source: string, name: string): Guard {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signatureRegex = new RegExp(`export\\s+async\\s+function\\s+${escaped}\\s*\\(`);
  const sigMatch = signatureRegex.exec(source);
  if (!sigMatch) return "unknown";

  // Walk forward from the signature to find the function body's opening
  // `{` (skipping over the parameter list and return-type annotation), then
  // brace-match to find where the body ends.
  const openBraceIndex = source.indexOf("{", sigMatch.index + sigMatch[0].length);
  if (openBraceIndex === -1) return "unknown";

  let depth = 0;
  let bodyEnd = -1;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  if (bodyEnd === -1) return "unknown";

  const body = source.slice(openBraceIndex, bodyEnd);
  const usesReadable = body.includes("requireProjectReadable(");
  const usesStrict = body.includes("requireProject(");
  if (usesReadable) return "requireProjectReadable";
  if (usesStrict) return "requireProject";
  return "unknown";
}

interface ExaminedPair {
  pageFile: string;
  actionName: string;
  actionSource: string;
}

function sweep(): ExaminedPair[] {
  const pageFiles = [
    ...findPageAndLayoutFiles(PROJECTS_ID_DIR),
    ...findPageAndLayoutFiles(UGC_ID_DIR),
    ...findPageAndLayoutFiles(IMAGES_ID_DIR),
  ];
  const examined: ExaminedPair[] = [];

  for (const pageFile of pageFiles) {
    const source = readFileSync(pageFile, "utf8");

    // Only pages/layouts that guard their own door with
    // requireProjectReadable are in scope for this rule at all.
    if (!/requireProjectReadable\s*\(/.test(source)) continue;

    const actionImports = parseActionsImports(source).filter(
      (imp) => imp.source !== "@/actions/guard",
    );

    for (const imp of actionImports) {
      if (!isAwaitedInModuleBody(source, imp.local)) continue;
      examined.push({ pageFile, actionName: imp.local, actionSource: imp.source });
    }
  }

  return examined;
}

describe("guard seam: awaited actions on a requireProjectReadable page", () => {
  it("found at least one page/action pair to examine", () => {
    // A sweep that silently examines zero files passes forever and guards
    // nothing. If this ever fires, the parsing above has drifted from this
    // codebase's actual shape (e.g. every awaited action moved to a
    // different import style) — go fix the sweep, don't delete this
    // assertion.
    const examined = sweep();
    expect(examined.length).toBeGreaterThan(0);
  });

  it("every action awaited during render on a requireProjectReadable page also guards itself with requireProjectReadable", () => {
    const examined = sweep();
    const failures: string[] = [];

    for (const { pageFile, actionName, actionSource } of examined) {
      const actionFilePath = resolveActionsModule(actionSource);
      const actionFileSource = readFileSync(actionFilePath, "utf8");
      const guard = findExportedFunctionGuard(actionFileSource, actionName);

      if (guard !== "requireProjectReadable") {
        failures.push(
          `${pageFile} awaits ${actionName}() (from "${actionSource}") directly in its ` +
            `module body while guarding itself with the permissive ` +
            `requireProjectReadable — but ${actionName} guards itself with ` +
            `${guard === "requireProject" ? "the strict, owner-only requireProject" : "an undetermined guard"}. ` +
            `Because ${actionName} runs during server render (not deferred to a form ` +
            `submit), a non-owning admin who was just admitted past the page's own ` +
            `requireProjectReadable check gets notFound()'d out mid-render, out of a ` +
            `page they were already let into. Change ${actionName} in ${actionSource}.ts ` +
            `to guard itself with requireProjectReadable instead of requireProject.`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});

// The sweep above only covers Server Actions awaited by pages/layouts under
// app/(app)/projects/[id]/. Route handlers under app/api/projects/[id]/ are
// a different kind of surface (an <a> navigation or fetch(), not something
// awaited during a page's own render) and are NOT reachable by that sweep at
// all — so this is a second, independent mechanism, not a reuse of the one
// above.
//
// It would be convenient to also assert "every route here must use
// requireProject" or "must use requireProjectReadable," but that is the
// wrong rule and would be actively wrong today: this directory already
// contains two routes that legitimately use DIFFERENT guards, on purpose.
// archive/route.ts serves clip video files — paid render output, a
// narrower thing than "can this person view the project" — so it stays
// strict, owner-only requireProject even though it hangs off a page a
// non-owning admin can read. brief-csv/route.ts is a plain read of the same
// scene rows the Brief page already renders for a readable viewer, so it
// uses requireProjectReadable — using requireProject there would 404 an
// admin out of a download reachable from a page they were just let into,
// the exact seam bug this file exists to catch. Neither choice is a
// mistake; a blanket rule would force one of them to be "wrong."
//
// So instead of asserting an answer, this registry forces a DECISION: every
// route.ts under app/api/projects/[id]/ must have an entry here declaring
// which guard it uses and why, and the test checks the declaration against
// the actual source. A new route with no entry fails loudly, naming the
// route and telling its author to add one — not to copy whichever
// neighbour they saw first, since the two neighbours disagree.
interface ApiRouteGuardEntry {
  /** Path relative to app/api/projects/[id]/, e.g. "archive/route.ts". */
  relativePath: string;
  guard: Exclude<Guard, "unknown">;
  /** Why THIS route uses THIS guard — not a restatement of the guard's name. */
  reason: string;
}

const API_ROUTE_GUARD_REGISTRY: ApiRouteGuardEntry[] = [
  {
    relativePath: "archive/route.ts",
    guard: "requireProject",
    reason:
      "Serves clip video files (paid render output) — narrower than 'can this " +
      "person view the project,' so it stays owner-only even though it hangs " +
      "off a page a non-owning admin can read.",
  },
  {
    relativePath: "brief-csv/route.ts",
    guard: "requireProjectReadable",
    reason:
      "Plain read of the same scene rows the Brief page already renders for a " +
      "readable viewer — using the strict guard here would 404 an admin out of " +
      "a download reachable from a page they were just let into.",
  },
];

/**
 * Classifies which guard a route handler's source calls, by the same
 * substring logic findExportedFunctionGuard uses above: `requireProject(`
 * and `requireProjectReadable(` are mutually exclusive substrings by
 * construction (the character after `requireProject` in
 * `requireProjectReadable(` is `R`, not `(`), so a literal search for
 * `requireProject(` can never match inside `requireProjectReadable(`.
 * Applied to the whole file rather than one function body, since route
 * handlers call their guard directly in GET/POST/etc., not via a shared
 * named export the way actions/*.ts does.
 */
function findRouteGuard(source: string): Guard {
  const usesReadable = source.includes("requireProjectReadable(");
  const usesStrict = source.includes("requireProject(");
  if (usesReadable) return "requireProjectReadable";
  if (usesStrict) return "requireProject";
  return "unknown";
}

/** Recursively collects every route.ts under `dir`, as paths relative to `dir`. */
function findApiRouteFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...findApiRouteFiles(fullPath, base));
    } else if (entry === "route.ts") {
      // Forward slashes, not join()'s native separator: the registry above
      // declares "archive/route.ts", so on Windows the raw slice would be
      // "archive\route.ts" and every route would read as undeclared.
      results.push(fullPath.slice(base.length + 1).replaceAll("\\", "/"));
    }
  }
  return results;
}

describe("guard seam: app/api/projects/[id]/ route registry", () => {
  it("found at least one route.ts to check against the registry", () => {
    // Same reasoning as the sweep-count assertion above: a directory scan
    // that silently matches zero files passes forever while guarding
    // nothing. If this fires, findApiRouteFiles has drifted from this
    // codebase's actual shape — go fix the scan, don't delete this
    // assertion.
    const routeFiles = findApiRouteFiles(API_PROJECTS_ID_DIR);
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it("every declared route actually uses the guard the registry claims", () => {
    const failures: string[] = [];

    for (const { relativePath, guard, reason } of API_ROUTE_GUARD_REGISTRY) {
      const fullPath = join(API_PROJECTS_ID_DIR, relativePath);
      const source = readFileSync(fullPath, "utf8");
      const actual = findRouteGuard(source);

      if (actual !== guard) {
        failures.push(
          `app/api/projects/[id]/${relativePath}: registry declares ${guard} (${reason}) ` +
            `but the file actually calls ` +
            `${actual === "unknown" ? "neither requireProject nor requireProjectReadable" : actual} — ` +
            `either the guard changed without updating the registry entry above, or the ` +
            `registry's declared reason no longer matches what the route does. A read ` +
            `reachable from a page the user can already view should not be stricter than ` +
            `that page; a route serving paid render output or performing a write should be ` +
            `owner-only (requireProject). Fix whichever one is wrong.`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("every route.ts under app/api/projects/[id]/ is declared in the registry", () => {
    const routeFiles = findApiRouteFiles(API_PROJECTS_ID_DIR);
    const declared = new Set(API_ROUTE_GUARD_REGISTRY.map((entry) => entry.relativePath));
    const undeclared = routeFiles.filter((relativePath) => !declared.has(relativePath));

    const failures = undeclared.map(
      (relativePath) =>
        `app/api/projects/[id]/${relativePath} is not declared in API_ROUTE_GUARD_REGISTRY ` +
        `(lib/guard-seam.test.ts). Add an entry naming which guard it uses and WHY — do not ` +
        `copy whichever neighbouring route you saw first, since archive/route.ts and ` +
        `brief-csv/route.ts already deliberately disagree. Decide: a read reachable from a ` +
        `page the user can already view should use the permissive requireProjectReadable; a ` +
        `route serving paid render output or performing a write should use the strict, ` +
        `owner-only requireProject.`,
    );

    expect(failures).toEqual([]);
  });
});
