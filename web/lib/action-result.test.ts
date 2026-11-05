import { describe, expect, it } from "vitest";
import { guardResult } from "./action-result";

describe("guardResult", () => {
  // The whole point of this module: a thrown guard message is invisible to
  // the operator in production (React error #441), so it has to come back
  // as `{ error }` instead of propagating.
  it("turns a thrown Error into a returned { error } instead of letting it propagate", () => {
    expect(() =>
      guardResult(() => {
        throw new Error("would exceed the daily budget");
      }),
    ).not.toThrow();

    const result = guardResult(() => {
      throw new Error("would exceed the daily budget");
    });
    expect(result).toEqual({ error: "would exceed the daily budget" });
  });

  it("returns undefined when the guard does not throw, so a passing check needs no special-casing at the call site", () => {
    expect(guardResult(() => {})).toBeUndefined();
  });

  // A guard is expected to throw Error, but this shouldn't crash on a
  // non-Error throw (e.g. a plain string) — it should still hand back
  // something the caller can show.
  it("falls back to a generic message when the thrown value isn't an Error", () => {
    const result = guardResult(() => {
      throw "not an Error instance";
    });
    expect(result).toEqual({ error: "This action was refused." });
  });
});
