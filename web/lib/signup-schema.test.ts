import { describe, expect, it } from "vitest";
import { signupFormSchema } from "./signup-schema";
import { MIN_PASSWORD_LENGTH } from "./signup-password";
import { MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH } from "./signup-username";

// This schema is what web/app/signup/page.tsx and actions/auth.ts's signUp
// both parse — see lib/signup-schema.ts's header comment. These cases
// mirror lib/signup-username.test.ts and lib/signup-password.test.ts (the
// pure functions' specification) to prove the schema enforces the same
// rules, plus the email/field-path behaviour those functions never had to
// express on their own.

const validUsername = "darwin_a2";
const validEmail = "dana@example.com";
const validPassword = "a".repeat(MIN_PASSWORD_LENGTH);

function values(
  overrides: Partial<Record<"username" | "email" | "password" | "confirmPassword", string>> = {},
): Record<"username" | "email" | "password" | "confirmPassword", string> {
  return {
    username: validUsername,
    email: validEmail,
    password: validPassword,
    confirmPassword: validPassword,
    ...overrides,
  };
}

describe("signupFormSchema", () => {
  it("accepts a fully valid submission", () => {
    expect(signupFormSchema.safeParse(values()).success).toBe(true);
  });

  it("refuses a username shorter than the minimum, attaching the error to username", () => {
    const result = signupFormSchema.safeParse(values({ username: "ab" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "username");
    expect(issue?.message).toBe(
      `Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`,
    );
  });

  it("refuses a username longer than the maximum", () => {
    const result = signupFormSchema.safeParse(
      values({ username: "a".repeat(MAX_USERNAME_LENGTH + 1) }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === "username")).toBe(true);
  });

  it("refuses a username with punctuation, attaching the error to username", () => {
    const result = signupFormSchema.safeParse(values({ username: "darwin.a" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "username");
    expect(issue?.message).toBe("Username can only contain letters, numbers, and underscores.");
  });

  it("refuses an empty email, attaching the error to email", () => {
    const result = signupFormSchema.safeParse(values({ email: "" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "email");
    expect(issue?.message).toBe("Email is required.");
  });

  it("refuses a malformed email, attaching the error to email", () => {
    const result = signupFormSchema.safeParse(values({ email: "not-an-email" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "email");
    expect(issue?.message).toBe("Enter a valid email address.");
  });

  it("refuses a password shorter than the minimum, attaching the error to password", () => {
    const result = signupFormSchema.safeParse(
      values({ password: "short", confirmPassword: "short" }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "password");
    expect(issue?.message).toBe(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  });

  it("refuses mismatched passwords, attaching the error to confirmPassword specifically", () => {
    const result = signupFormSchema.safeParse(
      values({ password: validPassword, confirmPassword: `${validPassword}x` }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({ path: ["confirmPassword"], message: "Passwords do not match." }),
    ]);
  });

  it("reports the password length problem rather than a mismatch when both are wrong", () => {
    const result = signupFormSchema.safeParse(
      values({ password: "short", confirmPassword: "othershort" }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === "password")).toBe(true);
  });

  // The whole point of intersecting rather than duplicating: username rules
  // live in signup-username.ts, password rules in signup-password.ts, and
  // this schema only composes them — proven here by every field failing at
  // once and every one of those failures surfacing on its own path.
  it("reports every field's problem independently when everything is wrong", () => {
    const result = signupFormSchema.safeParse({
      username: "ab",
      email: "not-an-email",
      password: "short",
      confirmPassword: "othershort",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path[0]);
    expect(paths).toContain("username");
    expect(paths).toContain("email");
    expect(paths).toContain("password");
  });
});
