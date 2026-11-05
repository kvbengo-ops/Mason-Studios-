import { describe, expect, it } from "vitest";
import { remainingForDisplayUsd } from "@/lib/format-usd";

// A remaining figure goes negative whenever a ceiling drops below what an
// account has already spent — a lowered override, a bulk role change, a
// grant ending or expiring mid-week after it had been drawn on. Enforcement
// is right in every one of those cases and it heals at the Manila week
// reset, but "-1,000 cr left" reads as a bug to whoever is looking at it.
describe("remainingForDisplayUsd", () => {
  it("floors an overspent account at zero rather than showing a debt", () => {
    expect(remainingForDisplayUsd(-5)).toBe(0);
  });

  it("leaves a real remaining figure alone", () => {
    expect(remainingForDisplayUsd(12.5)).toBe(12.5);
  });

  it("passes exact zero through unchanged", () => {
    // The ordinary end state of "End grant", which caps an account at what it
    // has already spent — it must read as 0, not as anything else.
    expect(remainingForDisplayUsd(0)).toBe(0);
  });

  // Matches 0075_revoke_allowance_grants.sql's outstanding_allowance_usd,
  // which already floors its per-account term with greatest(0, ...). The two
  // sides of the app must not disagree about whether an overspent account
  // contributes a negative.
  it("agrees with the SQL side's greatest(0, ...)", () => {
    for (const [input, expected] of [
      [-100, 0],
      [-0.01, 0],
      [0, 0],
      [0.01, 0.01],
    ] as const) {
      expect(remainingForDisplayUsd(input)).toBe(expected);
    }
  });
});
