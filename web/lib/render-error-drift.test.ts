// The classifier must recognise the strings the worker actually writes.
//
// classifyRenderError decides whether an operator is told "worth another try"
// or "this will fail the same way", on a screen where the retry costs money.
// It decides that by matching `runs.error` against a list of phrases — and
// those phrases live in TypeScript while the errors are written in Go, with
// nothing between them.
//
// That gap has already gone stale once. Two markers read "fal" after the worker
// had started writing "kie", so the two most common reconcile outcomes — "kie
// reported the render failed" and "claimed but never submitted to kie" — matched
// nothing and fell through to the `unknown` branch.
//
// Worth being exact about the damage, because the first version of this file
// overstated it: the fallthrough is ALSO retryable: true, so the advice did not
// invert. What was lost is the category and the written explanation ("This looks
// like a transient failure (network, timeout, or a dropped connection)"),
// replaced by the raw Go error text. A worse message, not a wrong one.
//
// Nothing caught it, and nothing could have. A regex that stops matching
// returns a vaguer verdict rather than an error, and the sweep that removed fal
// from the code, the schema, the docs and the README did not reach a string
// literal inside a RegExp.
//
// So the assertions below check the CATEGORY, not just `retryable`. Checking
// retryable alone passes whether or not the markers match — which is exactly
// what the first draft of this test did, and it sailed through the mutation
// that restored the bug.
//
// So this reads the Go source and asserts the classifier answers correctly for
// every failure the worker can record. Same shape as rates-drift.test.ts, and
// for the same reason: two files must agree and no compiler can check it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyRenderError } from "./render-error";

const WORKER = fileURLToPath(new URL("../../worker/", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(`${WORKER}${relativePath}`, "utf8");
}

/**
 * The literal reasons reconcile.go hands to markFailed/giveUp.
 *
 * Extracted rather than hardcoded: a hardcoded copy would drift the same way
 * the regexes did, one indirection further away.
 */
function reconcileFailureReasons(): string[] {
  const source = read("internal/loop/reconcile.go");
  const found = new Set<string>();
  // markFailed(ctx, deps, logger, scene, "…") and giveUp(…, "…", err)
  for (const m of source.matchAll(/\b(?:markFailed|giveUp)\([^)]*?"([^"]+)"/g)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

describe("every failure the worker records is classified", () => {
  it("finds the reasons in reconcile.go, so a refactor cannot empty this test", () => {
    const reasons = reconcileFailureReasons();
    expect(
      reasons.length,
      "no markFailed/giveUp reasons parsed out of reconcile.go — this guard is watching nothing",
    ).toBeGreaterThanOrEqual(3);
  });

  it("RECOGNISES every reconcile failure, not merely tolerates it", () => {
    // category, not retryable. Every one of these describes a lost, wedged or
    // vendor-side failure — none is a statement about the prompt — so they must
    // land in `retryable`, the branch that explains itself, rather than in
    // `unknown`, which just echoes the Go error back at the operator.
    //
    // `unknown` is the tell that a marker has gone stale. It is still
    // retryable: true, which is why asserting on that flag caught nothing.
    const unrecognised: string[] = [];

    for (const reason of reconcileFailureReasons()) {
      const info = classifyRenderError(reason);
      if (info.category === "unknown") {
        unrecognised.push(`"${reason}"`);
      }
      if (!info.retryable) {
        unrecognised.push(`"${reason}" -> not retryable, which is worse`);
      }
    }

    expect(
      unrecognised,
      `the worker writes these and the classifier does not recognise them, so the operator gets the raw Go error instead of an explanation:\n  ${unrecognised.join("\n  ")}`,
    ).toEqual([]);
  });

  it("does not depend on the vendor's name", () => {
    // The regression in one line: the same sentence with a different vendor
    // must classify the same way. If this fails, a marker has picked the
    // vendor back up.
    for (const sentence of [
      "reported the render failed",
      "claimed but never submitted to",
    ]) {
      const withKie = classifyRenderError(`kie ${sentence} kie`);
      const withOther = classifyRenderError(`someone ${sentence} someone`);
      expect(
        withKie.category,
        `"${sentence}" is not recognised — the worker writes it and the classifier answers "unknown"`,
      ).toBe("retryable");
      expect(
        withOther.category,
        `"${sentence}" only classifies when the vendor is named — the next rename breaks it again`,
      ).toBe("retryable");
    }
  });

  it("still refuses to call a prompt rejection retryable", () => {
    // The other direction. Marking everything retryable would be a different
    // way of giving useless advice, and an expensive one.
    // The worker's own 4xx wrap, not an invented sentence. The first version
    // of this test made one up ("content policy violation: …"), which the
    // classifier had never been asked to recognise — so it asserted a verdict
    // nothing promises, and failed for the wrong reason.
    const info = classifyRenderError(
      'client error: status 422: {"msg":"model name not supported"}',
    );
    expect(info.retryable).toBe(false);
  });
});
