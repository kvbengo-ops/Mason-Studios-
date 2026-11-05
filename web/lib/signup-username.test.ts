import { describe, expect, it } from "vitest";
import { checkSignupUsername, MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH } from "./signup-username";

describe("checkSignupUsername", () => {
  it("accepts a username at exactly the minimum length", () => {
    const username = "a".repeat(MIN_USERNAME_LENGTH);
    expect(checkSignupUsername(username)).toEqual({ valid: true });
  });

  it("accepts a username at exactly the maximum length", () => {
    const username = "a".repeat(MAX_USERNAME_LENGTH);
    expect(checkSignupUsername(username)).toEqual({ valid: true });
  });

  // Boundaries are where a length check gets it wrong most often — worth
  // their own cases rather than trusting the generic "too short"/"too
  // long" cases below to cover them.
  it("refuses a username one character shorter than the minimum", () => {
    const username = "a".repeat(MIN_USERNAME_LENGTH - 1);
    expect(checkSignupUsername(username)).toEqual({
      valid: false,
      reason: `Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`,
    });
  });

  it("refuses a username one character longer than the maximum", () => {
    const username = "a".repeat(MAX_USERNAME_LENGTH + 1);
    expect(checkSignupUsername(username)).toEqual({
      valid: false,
      reason: `Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`,
    });
  });

  it("refuses a short username, naming the allowed range", () => {
    expect(checkSignupUsername("ab")).toEqual({
      valid: false,
      reason: `Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`,
    });
  });

  it("refuses a username containing a space", () => {
    expect(checkSignupUsername("dar win")).toEqual({
      valid: false,
      reason: "Username can only contain letters, numbers, and underscores.",
    });
  });

  it("refuses a username containing punctuation", () => {
    expect(checkSignupUsername("darwin.a")).toEqual({
      valid: false,
      reason: "Username can only contain letters, numbers, and underscores.",
    });
  });

  it("accepts a username with digits and underscores mixed with letters", () => {
    expect(checkSignupUsername("darwin_a2")).toEqual({ valid: true });
  });

  it("preserves case: an uppercase-containing username is valid on its own", () => {
    expect(checkSignupUsername("DarwinA")).toEqual({ valid: true });
  });
});
