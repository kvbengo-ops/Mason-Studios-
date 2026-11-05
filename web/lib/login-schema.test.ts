import { describe, expect, it } from "vitest";
import { loginFormSchema } from "./login-schema";

// This schema is what web/app/login/page.tsx and actions/auth.ts's signIn
// both parse — see lib/login-schema.ts's header comment. Login has no rule
// beyond "these were typed in and the email looks like an email"; whether
// the credentials are actually correct is Supabase's job, not this
// schema's, so that's all these cases cover.

describe("loginFormSchema", () => {
  it("accepts a valid email and any non-empty password", () => {
    const result = loginFormSchema.safeParse({ email: "dana@example.com", password: "whatever" });
    expect(result.success).toBe(true);
  });

  it("refuses an empty email, attaching the error to email", () => {
    const result = loginFormSchema.safeParse({ email: "", password: "whatever" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "email");
    expect(issue?.message).toBe("Email is required.");
  });

  it("refuses a malformed email, attaching the error to email", () => {
    const result = loginFormSchema.safeParse({ email: "not-an-email", password: "whatever" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "email");
    expect(issue?.message).toBe("Enter a valid email address.");
  });

  it("refuses an empty password, attaching the error to password", () => {
    const result = loginFormSchema.safeParse({ email: "dana@example.com", password: "" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "password");
    expect(issue?.message).toBe("Password is required.");
  });

  // Login deliberately has no length floor of its own: an existing account
  // may predate MIN_PASSWORD_LENGTH or have been provisioned by hand with a
  // shorter password, and this schema must not lock that account out.
  it("accepts a password shorter than the signup minimum", () => {
    const result = loginFormSchema.safeParse({ email: "dana@example.com", password: "short" });
    expect(result.success).toBe(true);
  });
});
