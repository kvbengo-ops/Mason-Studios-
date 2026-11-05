// Nothing may CALL a vendor without asking MODE first.
//
// The third guard in this family, and the one that answers the question an
// operator actually asks before running the stack on their laptop: "is it
// really all mocked?" spend-seam.test.ts proves nothing queues a render
// without a cap check; dev-seam.test.ts proves nothing queues one without
// saying which MODE queued it. Both are about the QUEUE. Neither says
// anything about the calls the web app makes directly — the Claude compile,
// the kie image generation, the kie balance read — which spend money the
// moment they are made, with no scene row involved at all.
//
// Until this file, that half was guarded by nothing but a person reading the
// code and reporting back. That answer has a shelf life of exactly one
// commit.
//
// The failure this catches is "forgot entirely": a fifth `new Anthropic()`
// added to lib/claude.ts, or a new module that talks to a vendor, without an
// isDev() branch in front of it. That is the realistic mistake — the existing
// four call sites each got their gate because whoever wrote them was thinking
// about MODE at the time, and the fifth is written by someone who is not.
//
// WHAT THIS DOES NOT PROVE, stated as plainly as its two siblings do. A
// source sweep cannot verify control flow. It sees that an isDev() appears
// above a vendor call, not that it RETURNS before reaching it, and not that
// the gate covers every branch. It is a smoke alarm, not a proof: the blank
// ANTHROPIC_API_KEY and KIE_API_KEY in a local .env are the second layer, and
// scenes.dev is the third.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(`${WEB_ROOT}${relativePath}`, "utf8");
}

/**
 * Every marker that means "this line reaches a paid vendor", and the file it
 * lives in.
 *
 * Listed explicitly rather than discovered by scanning for `fetch(`, because
 * this app fetches plenty of things that cost nothing — Supabase, its own
 * routes — and a guard that cried wolf on those would be turned off.
 */
const VENDOR_CALLS: readonly { file: string; marker: string; what: string }[] = [
  { file: "lib/claude.ts", marker: "new Anthropic(", what: "a Claude compile" },
  { file: "lib/kie.ts", marker: "createTask", what: "a kie image generation" },
  { file: "lib/kie-balance.ts", marker: "KIE_CREDIT_URL", what: "a kie balance read" },
];

/**
 * The unit a gate protects is an EXPORTED FUNCTION, not a line.
 *
 * The first version of this checked for an isDev() within twelve lines above
 * each vendor call and reported lib/kie.ts as ungated — wrongly. That module
 * gates at its single exported entry, generateImage, and everything that
 * touches the network below it (createTask, recordInfo, pollForResult) is
 * private and unreachable from outside. Guarding line-by-line describes
 * lib/claude.ts's shape and not lib/kie.ts's, and a guard that only fits one
 * of the two files it watches is a guard someone deletes.
 *
 * What actually matters is that no caller OUTSIDE these modules can reach a
 * vendor without passing a gate — which makes the exported surface the thing
 * to check.
 */
function exportedBlocks(source: string): { name: string; body: string }[] {
  const lines = source.split("\n");
  const starts: { name: string; line: number }[] = [];
  lines.forEach((line, i) => {
    const m = /^export (?:async )?function (\w+)/.exec(line);
    if (m?.[1]) starts.push({ name: m[1], line: i });
  });
  // Bounded by the function's own closing brace at column 0, not by the next
  // export. Splitting on the next export swept private helpers defined
  // BETWEEN two exports into the earlier one's body — which reported
  // __resetKieTestSeams (a test seam) as reaching kie, because createTask
  // happens to sit between it and generateImage.
  return starts.map(({ name, line }) => {
    let end = lines.length;
    for (let i = line + 1; i < lines.length; i++) {
      if (lines[i] === "}") {
        end = i + 1;
        break;
      }
    }
    return { name, body: lines.slice(line, end).join("\n") };
  });
}

describe("every vendor call site is gated on MODE", () => {
  it("finds the call sites it expects, so a rename fails loudly", () => {
    // Without this, deleting lib/claude.ts's Anthropic construction (or
    // renaming the marker) would make the sweep below pass by finding
    // nothing at all — the classic way a source guard goes quietly green.
    const found = VENDOR_CALLS.map(({ file, marker }) => {
      const hits = read(file)
        .split("\n")
        .filter((l) => l.includes(marker)).length;
      return { file, marker, hits };
    });

    for (const { file, marker, hits } of found) {
      expect(
        hits,
        `${file} no longer contains "${marker}" — this guard is watching nothing`,
      ).toBeGreaterThan(0);
    }

    // Six Claude call sites today. Pinned as a number so a SEVENTH one has to
    // come past this test, which is the whole point: the next one is the one
    // written by someone not thinking about MODE.
    //
    // It has moved both ways. refineClipPromptText arrived as the fifth and
    // describeReferenceImage as the sixth; refine was later deleted with its
    // UI, and compileImageSequence (the Image Generator sequence compiler) is
    // the sixth now. Each time the count failed while the "gates every
    // exported function" case beside it kept passing, which together say a new
    // vendor call appeared AND it was correctly gated.
    const claude = found.find((f) => f.file === "lib/claude.ts");
    expect(
      claude?.hits,
      "the number of Claude call sites changed — add the new one's gate, then update this count",
    ).toBe(6);
  });

  it("gates every exported function that can reach a vendor", () => {
    const ungated: string[] = [];

    for (const { file, marker, what } of VENDOR_CALLS) {
      const source = read(file);
      const blocks = exportedBlocks(source);
      expect(
        blocks.length,
        `${file}: no exported functions parsed — the regex has drifted`,
      ).toBeGreaterThan(0);

      for (const { name, body } of blocks) {
        // Only exports that actually reach the vendor need a gate. A pure
        // helper exported from the same file does not, and demanding one
        // would teach people to add meaningless isDev() calls.
        const reaches = body
          .split("\n")
          .some(
            (line) =>
              line.includes(marker) &&
              !line.trim().startsWith("//") &&
              !line.trim().startsWith("*"),
          );
        if (!reaches) continue;

        const gateAt = body.indexOf("isDev()");
        const callAt = body.indexOf(marker);
        if (gateAt === -1) {
          ungated.push(`${file}: ${name}() reaches ${what} with no isDev() anywhere in it`);
        } else if (gateAt > callAt) {
          ungated.push(`${file}: ${name}() checks isDev() only AFTER reaching ${what}`);
        }
      }
    }

    expect(
      ungated,
      `an exported path to a vendor with no MODE gate spends real money on a local run:\n  ${ungated.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the vendor calls in lib/kie.ts private, since its gate is at the door", () => {
    // The corollary of gating at the entry point rather than at each call: it
    // only holds while the calls stay unreachable from outside. Exporting
    // createTask would route around the gate without touching it.
    const source = read("lib/kie.ts");
    for (const helper of ["createTask", "recordInfo", "pollForResult"]) {
      expect(
        source,
        `lib/kie.ts exports ${helper} — a caller can now reach kie without passing generateImage's isDev() gate`,
      ).not.toMatch(new RegExp(`export (async )?function ${helper}\\b`));
    }
  });

  it("reads MODE from one place, so there is one answer to change", () => {
    // Three independent per-vendor flags is the shape this replaced, and its
    // problem was that a half-mocked run was a legal configuration. Every
    // gate above must come from lib/mode.ts, not from a local re-read of
    // process.env.MODE that could disagree with it.
    for (const { file } of VENDOR_CALLS) {
      const source = read(file);
      if (!source.includes("isDev()")) continue;
      expect(
        source,
        `${file} calls isDev() without importing it from lib/mode — a second reading of MODE can disagree with the first`,
      ).toMatch(/from "(\.\/mode|@\/lib\/mode)"/);
    }
  });
});

describe("the worker's own vendor client is gated too", () => {
  // The web app is only half the spend. The worker submits the actual video
  // render, and its gate is a Go one this sweep can still read as text.
  it("checks c.mock in every exported method that reaches kie", () => {
    const client = readFileSync(`${WEB_ROOT}../worker/internal/kie/client.go`, "utf8");

    for (const method of ["Submit", "Status", "Result"]) {
      const start = client.indexOf(`func (c *Client) ${method}(`);
      expect(
        start,
        `kie.Client.${method} not found — this guard is watching nothing`,
      ).toBeGreaterThan(-1);
      // The gate must appear early in the method: validation may precede it,
      // a network call may not.
      const body = client.slice(start, start + 900);
      expect(
        body.includes("if c.mock {"),
        `kie.Client.${method} has no mock branch — MODE=development would submit a real render`,
      ).toBe(true);
    }
  });
});
