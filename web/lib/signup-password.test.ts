import { describe, expect, it } from "vitest";
import { checkSignupPassword, MIN_PASSWORD_LENGTH } from "./signup-password";

describe("checkSignupPassword", () => {
  it("accepts a password at exactly the minimum length that matches its confirmation", () => {
    const password = "a".repeat(MIN_PASSWORD_LENGTH);
    expect(checkSignupPassword(password, password)).toEqual({ valid: true });
  });

  // One character short of the floor is the exact boundary a length check
  // gets wrong most often — worth its own case rather than trusting the
  // "too short" case below to cover it.
  it("refuses a password one character shorter than the minimum", () => {
    const password = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(checkSignupPassword(password, password)).toEqual({
      valid: false,
      reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  });

  it("refuses a short password, naming the minimum length", () => {
    expect(checkSignupPassword("short", "short")).toEqual({
      valid: false,
      reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  });

  // Length is checked before the match, so a short mismatched pair reports
  // the length problem first — the more fundamental of the two issues.
  it("reports the length problem before the mismatch when both are wrong", () => {
    expect(checkSignupPassword("short", "othershort")).toEqual({
      valid: false,
      reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  });

  it("refuses a long-enough password that doesn't match its confirmation", () => {
    expect(checkSignupPassword("correct-horse", "correct-house")).toEqual({
      valid: false,
      reason: "Passwords do not match.",
    });
  });

  it("has no complexity rules beyond length: an all-lowercase password is valid", () => {
    const password = "lowercaseonly";
    expect(checkSignupPassword(password, password)).toEqual({ valid: true });
  });
});
