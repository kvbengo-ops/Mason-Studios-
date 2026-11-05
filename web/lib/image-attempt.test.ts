// The Image Generator's status model (0095_image_attempt_recovery.sql).
//
// This is the whole reason no status COLUMN was added: the five states are a
// function of four columns that already exist, and the risk of deriving rather
// than storing is that the derivation is wrong somewhere nobody looks. So it
// lives in one pure function and every branch of it is pinned here.
//
// The branch that matters most for money is billing_unknown. A held attempt
// keeps its estimate counted (lib/runs.ts's holdRunBillingUnknown) precisely
// because kie may have charged for it, so mistaking one for a plain failure
// would tell the operator nothing is at stake when something is, and invite the
// second charge that pressing Generate again would make.
import { describe, expect, it } from "vitest";
import {
  BILLING_UNKNOWN_PREFIX,
  imageAttemptReason,
  imageAttemptStatus,
  isImageAttemptUnfinished,
} from "./image-attempt";

describe("imageAttemptStatus", () => {
  it("is queued once reserved and before kie has been asked", () => {
    // reserve_image_attempt inserts settled_at NULL and nothing else. Nothing
    // can have been billed yet — there is no submission to bill.
    expect(imageAttemptStatus({ settledAt: null, kieTaskId: null, error: null })).toBe("queued");
  });

  it("is generating once kie has returned a task id", () => {
    expect(imageAttemptStatus({ settledAt: null, kieTaskId: "task-1", error: null })).toBe(
      "generating",
    );
  });

  it("is completed when settled without an error", () => {
    expect(
      imageAttemptStatus({ settledAt: "2026-09-08T03:00:00Z", kieTaskId: "task-1", error: null }),
    ).toBe("completed");
  });

  it("is failed when settled with an ordinary error", () => {
    expect(
      imageAttemptStatus({
        settledAt: "2026-09-08T03:00:00Z",
        kieTaskId: null,
        error: "kie createTask rejected the request: code=422",
      }),
    ).toBe("failed");
  });

  it("is billing_unknown when the error carries the shared prefix", () => {
    expect(
      imageAttemptStatus({
        settledAt: "2026-09-08T03:00:00Z",
        kieTaskId: "task-1",
        error: `${BILLING_UNKNOWN_PREFIX}kie task task-1 failed: no reason given`,
      }),
    ).toBe("billing_unknown");
  });

  it("treats an unsettled row as unfinished even if it already carries an error", () => {
    // The error column is only meaningful once the outcome is known. A row that
    // is still in flight has not reached a verdict, and reporting one would let
    // the panel stop polling an attempt that is still drawing.
    expect(
      imageAttemptStatus({ settledAt: null, kieTaskId: "task-1", error: "transient read failure" }),
    ).toBe("generating");
  });
});

describe("isImageAttemptUnfinished", () => {
  it("is true for exactly the two states that can still change on their own", () => {
    expect(isImageAttemptUnfinished("queued")).toBe(true);
    expect(isImageAttemptUnfinished("generating")).toBe(true);
    expect(isImageAttemptUnfinished("completed")).toBe(false);
    expect(isImageAttemptUnfinished("failed")).toBe(false);
    expect(isImageAttemptUnfinished("billing_unknown")).toBe(false);
  });
});

describe("imageAttemptReason", () => {
  it("strips the operational prefix, which is a query marker and not a sentence", () => {
    expect(imageAttemptReason(`${BILLING_UNKNOWN_PREFIX}kie task t1 failed: quota exceeded`)).toBe(
      "kie task t1 failed: quota exceeded",
    );
  });

  it("passes an ordinary error through untouched", () => {
    expect(imageAttemptReason("kie createTask rejected the request")).toBe(
      "kie createTask rejected the request",
    );
  });

  it("has nothing to say about an attempt with no error", () => {
    expect(imageAttemptReason(null)).toBeNull();
  });
});
