import { describe, expect, it } from "vitest";
import { checkSignupDomainAllowed } from "./signup-allowlist";

describe("checkSignupDomainAllowed", () => {
  // The whole point of the lever: an unconfigured env var must not lock
  // anyone out. Any deploy that forgets to set SIGNUP_ALLOWED_DOMAINS gets
  // open signup, not a silent outage.
  it("allows any domain when the env var is unset", () => {
    expect(checkSignupDomainAllowed("anyone@wherever.com", undefined)).toEqual({
      allowed: true,
    });
  });

  it("allows any domain when the env var is an empty string", () => {
    expect(checkSignupDomainAllowed("anyone@wherever.com", "")).toEqual({ allowed: true });
  });

  // Whitespace-only is what a dashboard field left "cleared" but not unset
  // can end up holding — should behave the same as fully empty.
  it("allows any domain when the env var is whitespace only", () => {
    expect(checkSignupDomainAllowed("anyone@wherever.com", "   ")).toEqual({ allowed: true });
  });

  it("allows an email whose domain is on the list", () => {
    expect(checkSignupDomainAllowed("dana@example.com", "example.com")).toEqual({
      allowed: true,
    });
  });

  it("allows an email matching any domain in a multi-domain list", () => {
    const result = checkSignupDomainAllowed("dana@partner.com", "example.com, partner.com");
    expect(result).toEqual({ allowed: true });
  });

  it("refuses an email whose domain is not on the list, naming the allowed domains", () => {
    const result = checkSignupDomainAllowed("dana@gmail.com", "example.com");
    expect(result).toEqual({
      allowed: false,
      reason: "Signup is limited to example.com email addresses.",
    });
  });

  // Hand-edited dashboard env vars will have inconsistent case and spacing;
  // the check has to normalize both sides or it silently refuses valid
  // company emails.
  it("matches domains case-insensitively and ignores surrounding whitespace in the list", () => {
    const result = checkSignupDomainAllowed("dana@EXAMPLE.com", " Example.com , partner.com ");
    expect(result).toEqual({ allowed: true });
  });

  // Guards against a malformed email (no "@") being treated as matching by
  // accident rather than crashing the check.
  it("refuses an email with no domain to extract", () => {
    const result = checkSignupDomainAllowed("not-an-email", "example.com");
    expect(result).toEqual({
      allowed: false,
      reason: "Signup is limited to example.com email addresses.",
    });
  });
});
