// A UI that promises something the pipeline cannot do.
//
// Caption burning was DELETED, not disabled, when fal was decommissioned: the
// word timings came from fal-ai/whisper and nothing replaced it, so
// loop/assemble.go's captionOrFallback, buildCaptionTrack and recordCaptionRun
// are gone and an assembled final now carries no captions at all.
//
// The settings page kept offering caption colour, size and position, under
// copy reading "Burned into the final video, one word at a time, timed to the
// spoken audio" — present tense, and false. An operator styling something that
// silently never renders is a worse failure than the missing feature, because
// nothing tells them. Nothing failed, either: no test, no type and no build
// step connects a sentence in a Card to a deleted Go function.
//
// This is that connection. It is a source-reading guard, the same shape as
// models-drift.test.ts (which parses Go to compare price tables) and the route
// guard registry — the repo's existing answer to "two files must agree and no
// compiler can check it".
//
// It fails in BOTH directions on purpose:
//   - captions still not burned, but the copy promises them  → fix the copy
//   - captions burned again, but the copy still disclaims     → fix the copy
// The second is the one worth having. Whoever restores captions gets told,
// by name, that there is a sentence to update.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Whether the worker actually burns captions onto an assembled video.
 *
 * media.Runner.BurnCaptions still EXISTS — it is dormant infrastructure with
 * no fal dependency, waiting on word timings — so its existence proves
 * nothing. What matters is whether the assemble loop calls it.
 */
function captionsAreBurned(): boolean {
  const assemble = read("worker/internal/loop/assemble.go");
  // Strip comments before looking for a call: assemble.go's own header
  // discusses captionOrFallback and BurnCaptions at length precisely because
  // they were removed, and matching that prose would invert this test.
  const code = assemble
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return /\bBurnCaptions\s*\(|\bcaptionOrFallback\s*\(/.test(code);
}

describe("the captions setting does not promise what the pipeline cannot do", () => {
  it("is disclaimed in the UI for exactly as long as the worker does not burn captions", () => {
    const burned = captionsAreBurned();
    const sidebar = read("web/components/project-settings-sidebar.tsx");

    // Only the rendered copy counts. The file's own comment block explains the
    // history and would otherwise satisfy every check below on its own.
    const copy = sidebar
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");

    const disclaims = /not currently burned/i.test(copy);
    const promises = /burned into the final video/i.test(copy);

    if (burned) {
      expect(
        disclaims,
        "the worker burns captions again, but the settings page still says they are not — remove the disclaimer in project-settings-sidebar.tsx",
      ).toBe(false);
    } else {
      expect(
        promises,
        'the settings page says captions are "burned into the final video", but loop/assemble.go does not burn them — the operator styles something that never renders',
      ).toBe(false);
      expect(
        disclaims,
        "captions are not burned and the settings page does not say so — an operator picking colours has no way to find out",
      ).toBe(true);
    }
  });

  it("keeps the style fields rather than removing them", () => {
    // Deliberate: the chunk/measure/ASS machinery never had a fal dependency
    // and is waiting on word timings, nothing else. A style saved today is a
    // style that applies when a vendor returns, so the fields stay and only
    // the promise changes.
    const sidebar = read("web/components/project-settings-sidebar.tsx");
    expect(sidebar).toContain("CaptionStyleFields");
  });
});
