// One in-flight look, enforced across the whole UI.
//
// The rule, asked for twice by hand after it was broken twice: anything with
// work in flight draws the GitHub Actions ring — a rotating partial circle.
// Never three bouncing dots, and never a label swapped to "Saving…" /
// "Compiling…" / "Deleting…".
//
// The reason is money, not decoration. Every control this covers spends
// something (a compile is $0.12, a reference frame $0.02-$0.04, a Seedance
// render $1.89 and up) and the price is written ON the label — "Confirm —
// $1.89", "Regenerate ($0.04)". Swapping that label for "Rendering…" deletes
// the number at the exact moment the operator is waiting to find out what
// they just agreed to spend. And this app drew the same three dots for
// "nothing here yet", so "working" and "empty" were wearing the same clothes
// on the screens where the difference is whether money is moving.
//
// The fix shipped six times and regressed five, because each new dialog was
// written by copying whichever neighbour the author happened to open. A
// per-component test cannot catch that — every one of those components was
// individually correct and individually pending-aware. What was wrong was
// the SET: sixteen controls, three different idioms. So this sweeps the
// source instead.
//
// The three approved entry points, all of which draw the same ring:
//   - components/pending-button.tsx  — actions that are not a form submit
//     (useTransition, a dialog's own async handler)
//   - components/submit-button.tsx   — inside an ActionForm's <form>
//   - components/status-icon.tsx     — the rail rows and scene tiles
//
// A fourth idiom is the thing this file exists to refuse.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED_DIRS = [join(WEB_ROOT, "components"), join(WEB_ROOT, "app")];

/**
 * A ternary whose true branch is a bare string literal ending in an ellipsis
 * — `{isPending ? "Deleting…" : "Delete"}`. That is the label swap, and the
 * ellipsis is what makes it recognisable as one rather than as ordinary
 * conditional copy.
 */
const LABEL_SWAP = /\?\s*"[^"]*…"/;

/**
 * The one legitimate shape that matches LABEL_SWAP: choosing WHICH pending
 * label to hand SubmitButton/UploadButton, e.g.
 * `pendingLabel={hasScenes ? "Recompiling…" : "Compiling…"}`. Those two
 * components draw the ring themselves and put the label beside it, so the
 * label is additive here, not a replacement.
 */
const ALLOWED_PENDING_LABEL = /pendingLabel/;

/**
 * The second legitimate shape: a `role="status"` line that REPORTS what is
 * happening, rather than a control that changes its own face.
 *
 * The rule this file enforces is about controls — a button that swaps
 * "Save" for "Saving…" goes dead-static and stops looking like a thing you
 * pressed. A status paragraph beside an autosaving form is the opposite:
 * it exists only to say "Saving…", and a form that saves itself with no
 * acknowledgement is indistinguishable from a form that did nothing.
 *
 * Narrow on purpose. Only a line that carries role="status" qualifies, so a
 * button cannot buy its way out of the rule by claiming to be one.
 */
const ALLOWED_STATUS_LINE = /role="status"/;

/**
 * The matched line plus its enclosing element's opening tag — everything from
 * the nearest line that opens a tag down to the match itself.
 *
 * Capped at 20 lines back so a walk that finds no tag (a helper returning a
 * bare ternary, say) gives up rather than sweeping the whole file into the
 * allowance.
 */
function enclosingTag(lines: string[], index: number): string {
  for (let i = index; i >= 0 && index - i <= 20; i--) {
    if (/<[a-zA-Z]/.test(lines[i]!)) return lines.slice(i, index + 1).join("\n");
  }
  return lines[index]!;
}

function findTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...findTsxFiles(fullPath));
    } else if (entry.endsWith(".tsx") && !entry.includes(".test.")) {
      results.push(fullPath);
    }
  }
  return results;
}

const sourceFiles = SCANNED_DIRS.flatMap(findTsxFiles);

describe("loading treatment", () => {
  it("sweeps a real, non-trivial set of files (so a broken walk fails loudly instead of passing on nothing)", () => {
    expect(sourceFiles.length).toBeGreaterThan(80);
  });

  it("no control replaces its label with a pending word — the ring goes beside the label, the price stays on screen", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!LABEL_SWAP.test(line)) return;
        if (ALLOWED_PENDING_LABEL.test(line)) return;
        // A status line's role="status" sits on the opening tag, which is
        // above the ternary that matched — and how far above depends on how
        // many attributes prettier wrapped onto their own lines, so a fixed
        // lookback of a few lines reported real status elements as offenders.
        // Walk back to the nearest opening tag instead: that is the element
        // the ternary is actually inside, and a button cannot inherit the
        // allowance from a status element that merely sits nearby, because
        // the button's own tag is what the walk stops on.
        if (ALLOWED_STATUS_LINE.test(enclosingTag(lines, i))) return;
        offenders.push(`${relative(WEB_ROOT, file)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "Swapped pending labels found. Use PendingButton (pending={...}) or, inside an " +
        "ActionForm, SubmitButton (pendingLabel=...) — both draw the ring and keep the " +
        "label, and the label is where the price is written.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("nothing draws bouncing dots for work in flight — that shape also means 'nothing here yet'", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      if (/<LoadingDots|from "@\/components\/loading-dots"/.test(source)) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    expect(
      offenders,
      "LoadingDots was deleted on purpose. Draw the ring instead — see submit-button.tsx.",
    ).toEqual([]);
  });
});
