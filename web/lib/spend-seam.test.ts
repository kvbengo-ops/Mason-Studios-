// Nothing may queue a render without checking what it costs.
//
// `scenes.status = 'queued'` is the entire render trigger. The Go worker's
// ClaimQueuedScenes selects on that value and nothing else — no ownership
// check, no cap check, no idea which route wrote the row. So every guard in
// this product is a TypeScript convention, and until this file existed
// nothing enforced it: AGENTS.md says "every Server Action calls a guard.ts
// helper first", doc comments repeat it, and a new file that ignored all of
// it would have shipped green.
//
// That is not hypothetical. This test was written immediately after adding
// actions/ugc.ts — a second, independent writer of 'queued' — precisely
// because the audit that preceded it said, in as many words, that such a file
// would be an ungated spend button and no test in the repo would fail.
//
// The existing sweeps do not cover this. lib/guard-seam.test.ts checks WHICH
// guard a route declares, never whether a spend check exists, and it is
// scoped to app/api/projects/[id]/ and app/(app)/projects/[id]/ — a Server
// Action in actions/ is outside it entirely.
//
// WHAT THIS DOES NOT PROVE. It is a source sweep, so it can only see that the
// call appears in the same file, not that it runs before the write, nor that
// its result is returned rather than dropped. A file could satisfy this and
// still be wrong. It exists to catch the failure that actually happens —
// someone writes a new path and simply does not think about the cap — not to
// verify control flow.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * `relative()` against WEB_ROOT, always with "/" separators.
 *
 * On Windows `relative()` returns "actions\enqueue.ts", which matches neither
 * the POSIX literals this file asserts on nor the NOT_A_WRITER keys — so on a
 * Windows checkout the name assertions failed and, worse, `rel in NOT_A_WRITER`
 * silently stopped matching, which would report a known non-writer as an
 * offender. Both sweeps passed on CI throughout, because CI is Linux.
 *
 * `sep` is "/" on POSIX, so this is a no-op there.
 */
const relFromWebRoot = (file: string): string => relative(WEB_ROOT, file).split(sep).join("/");

const SCANNED_DIRS = [join(WEB_ROOT, "actions"), join(WEB_ROOT, "app"), join(WEB_ROOT, "lib")];

/**
 * A write that sets a scene's status to 'queued'.
 *
 * Deliberately loose about surrounding syntax and strict about the pair:
 * `status: "queued"` in an object literal is how every one of the six
 * existing writers spells it, and a future one that spells it differently
 * (a variable, a computed key) is a case this cannot see. Better a check
 * that catches the common shape than none.
 */
const QUEUES_A_RENDER = /status:\s*["']queued["']/;

/** The one function that enforces every cap: kie's balance, global, weekly, daily. */
const CHECKS_SPEND = /assertWithinSpendCaps\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    // Tests write 'queued' constantly as fixture data and must not be asked
    // to check a spend cap for it.
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Files allowed to mention the value without checking spend, each with the
 * reason it is not a writer.
 *
 * An allowlist rather than a cleverer regex on purpose: the point of this
 * test is that adding a NEW file to this list should feel like a decision.
 */
const NOT_A_WRITER: Readonly<Record<string, string>> = {
  // Empty, and that is the finding rather than an oversight: exactly two
  // files in the whole web app spell `status: "queued"` outside a test —
  // actions/enqueue.ts and actions/ugc.ts — and both check the cap. Every
  // other module that cares about the value reads it through the
  // SceneStatus type or compares against it, neither of which matches the
  // pattern above.
  //
  // So an entry here means a NEW file mentions the write and someone decided
  // it does not really queue a render. That decision should be written down,
  // which is what the string is for.
};

describe("every path that queues a render checks the spend cap", () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);

  it("scans a plausible number of files, so a broken glob fails loudly", () => {
    // A sweep that silently matched nothing would pass forever. This is the
    // same guard lib/models-drift.test.ts puts on its own parser.
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds the writers it expects to find", () => {
    // If this drops to zero the regex has stopped matching and every
    // assertion below is vacuous — the "green because it looked at nothing"
    // failure this codebase has already been bitten by twice (the anon-grants
    // RLS test, and models-drift's parser).
    const writers = files
      .filter((f) => QUEUES_A_RENDER.test(readFileSync(f, "utf8")))
      .map(relFromWebRoot)
      .sort();

    // Both known writers by name. A rename is fine — update this — but a
    // silent disappearance means the sweep is no longer watching the thing
    // it was written to watch.
    expect(writers).toContain("actions/enqueue.ts");
    expect(writers).toContain("actions/ugc.ts");
  });

  it("has no queue-writer without a cap check", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!QUEUES_A_RENDER.test(source)) continue;

      const rel = relFromWebRoot(file);
      if (rel in NOT_A_WRITER) continue;
      if (CHECKS_SPEND.test(source)) continue;

      offenders.push(rel);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These files set scenes.status = 'queued' without calling assertWithinSpendCaps:\n` +
            offenders.map((f) => `  ${f}`).join("\n") +
            `\n\nQueuing a scene is the render trigger — the Go worker claims any queued row with ` +
            `no cap check of its own, so a path that skips this bills a vendor with nothing in ` +
            `front of it.\n\n` +
            `Copy the sequence from actions/enqueue.ts's enqueueScene, which runs all four shape ` +
            `guards. Do NOT copy retryScene or retryAllFailed — they run none of them.\n\n` +
            `If this file genuinely does not queue a render, add it to NOT_A_WRITER in this test ` +
            `with the reason.`,
    ).toEqual([]);
  });

  it("every allowlisted file still exists and still mentions the value", () => {
    // An allowlist entry for a file that has been deleted or changed is a
    // stale exemption, and a stale exemption is how a real writer sneaks
    // back in under an old name.
    for (const [rel, reason] of Object.entries(NOT_A_WRITER)) {
      const full = join(WEB_ROOT, rel);
      let source: string;
      try {
        source = readFileSync(full, "utf8");
      } catch {
        expect.fail(`${rel} is allowlisted here (${reason}) but no longer exists — remove it.`);
      }
      expect(
        QUEUES_A_RENDER.test(source),
        `${rel} is allowlisted here (${reason}) but no longer mentions status: 'queued' — remove it.`,
      ).toBe(true);
    }
  });
});
