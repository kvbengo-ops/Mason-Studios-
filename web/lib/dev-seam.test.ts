// Nothing may queue a render without saying which MODE queued it.
//
// `scenes.status = 'queued'` is the entire render trigger, and `scenes.dev`
// is what keeps two processes polling the SAME queue from stepping on each
// other — see lib/mode.ts's header for the incident this exists to prevent:
// a MODE=development process on a laptop queues a scene, and if that row's
// `dev` column doesn't say so, the DEPLOYED PRODUCTION worker (polling that
// same table) claims it and bills a real vendor call for what was supposed
// to be a free local fixture. worker/internal/store/store.go's
// ClaimQueuedScenes/CountRendering/StaleRendering all filter on scenes.dev
// — there is no ownership check, no MODE check of their own, just that
// column. So exactly like the spend cap (see this directory's own
// spend-seam.test.ts), the `dev` write is a TypeScript convention with
// nothing mechanical behind it except this sweep.
//
// This test exists because that failure mode already happened once for the
// spend cap, on this exact pair of files: actions/ugc.ts shipped as a
// second, independent writer of 'queued' that spend-seam.test.ts had to be
// written to catch, and its own header says so. actions/ugc.ts's queued
// write DID call assertWithinSpendCaps from day one — spend-seam.test.ts
// never had anything to catch there — but it went a full round without
// `dev: isDev()` at all, because the MODE/scenes.dev contract landed as a
// separate, parallel change that never re-checked this file. Same shape of
// gap, different guard; this sweep is the fix for THIS one.
//
// WHAT THIS DOES NOT PROVE. Same limits as spend-seam.test.ts: a source
// sweep can only see that `dev: isDev()` appears SOMEWHERE in a file that
// also mentions `status: "queued"` somewhere — not that they're in the same
// object literal, not that every one of several queued-writes in one file
// carries it. It exists to catch "forgot entirely," which is the failure
// that actually happened, not to verify control flow.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Same normalisation, and the same reason, as spend-seam.test.ts's copy. */
const relFromWebRoot = (file: string): string => relative(WEB_ROOT, file).split(sep).join("/");

const SCANNED_DIRS = [join(WEB_ROOT, "actions"), join(WEB_ROOT, "app"), join(WEB_ROOT, "lib")];

/** Same pattern spend-seam.test.ts uses to find a queueing write — see that file for why it's loose about syntax and strict about the pair. */
const QUEUES_A_RENDER = /status:\s*["']queued["']/;

/** The one call that records which MODE wrote the row. */
const SETS_DEV_FLAG = /dev:\s*isDev\(\)/;

/**
 * Strips `//` line comments before either pattern above is applied.
 *
 * Not optional here the way it was skippable in spend-seam.test.ts:
 * enqueue.ts's OWN header literally reads "Every write below also sets
 * `dev: isDev()`" in prose, and this file's actions/ugc.ts header (added
 * alongside the fix this test guards) says the same thing — both real,
 * both true, and both enough to satisfy SETS_DEV_FLAG against a file whose
 * actual write was reverted to plain `status: "queued"`. Caught exactly
 * that way while writing this test: reverting the real fix left the sweep
 * green, because the regex was reading the comment describing the fix
 * instead of the code. Same fix lib/models-drift.test.ts already uses for
 * the identical reason (its own Descriptor blocks quote raw JSON error
 * bodies in comments).
 */
function stripLineComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, "");
}

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
    // to set a MODE flag for it.
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Files allowed to mention the value without setting `dev`, each with the
 * reason it is not a writer — same "an allowlist entry is a decision, not a
 * default" reasoning as spend-seam.test.ts's NOT_A_WRITER.
 */
const NOT_A_WRITER: Readonly<Record<string, string>> = {
  // Empty: the two files that spell `status: "queued"` outside a test
  // (actions/enqueue.ts and actions/ugc.ts — see spend-seam.test.ts's own
  // "finds the writers it expects to find") both set `dev: isDev()` on
  // every one of those writes as of this test's addition.
};

describe("every path that queues a render sets scenes.dev", () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);

  it("scans a plausible number of files, so a broken glob fails loudly", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds the writers it expects to find", () => {
    // Same guard spend-seam.test.ts puts on this exact pattern, for the
    // exact same reason: if this drops to zero the regex has stopped
    // matching and every assertion below is vacuous.
    const writers = files
      .filter((f) => QUEUES_A_RENDER.test(stripLineComments(readFileSync(f, "utf8"))))
      .map(relFromWebRoot)
      .sort();

    expect(writers).toContain("actions/enqueue.ts");
    expect(writers).toContain("actions/ugc.ts");
  });

  it("has no queue-writer without a dev flag", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = stripLineComments(readFileSync(file, "utf8"));
      if (!QUEUES_A_RENDER.test(source)) continue;

      const rel = relFromWebRoot(file);
      if (rel in NOT_A_WRITER) continue;
      if (SETS_DEV_FLAG.test(source)) continue;

      offenders.push(rel);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These files set scenes.status = 'queued' without setting dev: isDev():\n` +
            offenders.map((f) => `  ${f}`).join("\n") +
            `\n\nA worker claims a queued row only when scenes.dev matches its own MODE ` +
            `(worker/internal/store/store.go's ClaimQueuedScenes) — a write with no dev column set ` +
            `defaults to false (production), so a MODE=development process that skips this can have a ` +
            `locally-mocked render claimed and billed for real by the deployed production worker. See ` +
            `lib/mode.ts's header for the incident.\n\n` +
            `Import isDev from "@/lib/mode" and add dev: isDev() to every object literal that sets ` +
            `status: "queued".\n\n` +
            `If this file genuinely does not queue a render, add it to NOT_A_WRITER in this test with ` +
            `the reason.`,
    ).toEqual([]);
  });

  it("every allowlisted file still exists and still mentions the value", () => {
    for (const [rel, reason] of Object.entries(NOT_A_WRITER)) {
      const full = join(WEB_ROOT, rel);
      let source: string;
      try {
        source = stripLineComments(readFileSync(full, "utf8"));
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
