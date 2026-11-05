import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn, signOut, signUp } from "./auth";
import { checkSignupDomainAllowed } from "@/lib/signup-allowlist";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import type * as SignupAllowlistModule from "@/lib/signup-allowlist";

// auth.ts sits behind two boundaries this file replaces with fakes rather
// than exercising for real: the domain allowlist (lib/signup-allowlist.ts,
// which has its own thorough test file — this file is about the SEAM
// between that check and signUp, not the check's own logic) and the
// Supabase client factories. Next's redirect() is mocked, since outside a
// real request it has nothing to redirect to.
vi.mock("@/lib/signup-allowlist", () => ({
  checkSignupDomainAllowed: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    // Mirrors Next's own redirect(): control flow via throw, not a return.
    throw new Error(`REDIRECT:${url}`);
  }),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  ilike: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
}

/** Minimal stand-in for the `profiles` email/username availability lookup chain. */
function fakeProfilesBuilder(
  defaultResult: FakeQueryResult,
  resultsByColumn: Record<string, FakeQueryResult> = {},
): FakeQueryBuilder {
  let column = "";
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn((nextColumn: string) => {
      column = nextColumn;
      return builder;
    }),
    ilike: vi.fn((nextColumn: string) => {
      column = nextColumn;
      return builder;
    }),
    maybeSingle: vi.fn(async () => resultsByColumn[column] ?? defaultResult),
  };
  return builder;
}

/**
 * Fake admin client whose `.from()` throws on any table this test didn't
 * explicitly stub, so an unexpected query surfaces as a loud failure
 * instead of quietly returning undefined.
 */
function fakeAdminClient(tables: Record<string, FakeQueryBuilder>): {
  from: ReturnType<typeof vi.fn>;
} {
  return {
    from: vi.fn((table: string) => {
      const builder = tables[table];
      if (!builder) {
        throw new Error(`Test did not stub table "${table}"`);
      }
      return builder;
    }),
  };
}

/**
 * Fake request-scoped client whose `.auth` throws on any method this test
 * didn't stub, same rationale as fakeAdminClient above.
 */
function fakeSupabaseClient(
  auth: Record<string, ReturnType<typeof vi.fn>>,
  /**
   * The profiles row signIn reads back after authenticating, to refuse a
   * deactivated account the session. Defaults to an active account so every
   * pre-existing test keeps describing what it always described.
   */
  profile: { status: string } | null = { status: "active" },
): {
  auth: Record<string, ReturnType<typeof vi.fn>>;
  from: ReturnType<typeof vi.fn>;
} {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    single: vi.fn(async () => ({ data: profile, error: null })),
  };
  return {
    auth: new Proxy(auth, {
      get(target, prop: string): ReturnType<typeof vi.fn> {
        const stub = target[prop];
        if (!stub) {
          throw new Error(`Test did not stub supabase.auth.${prop}`);
        }
        return stub;
      },
    }),
    from: vi.fn(() => builder),
  };
}

/** The getUser stub signIn needs once authentication has succeeded. */
function signedInUser(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ data: { user: { id: "user-1" } } }));
}

function signUpFormData(overrides: Record<string, string> = {}): FormData {
  const fields: Record<string, string> = {
    username: "validuser",
    email: "person@example.com",
    password: "longenoughpassword",
    confirmPassword: "longenoughpassword",
    ...overrides,
  };
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

afterEach(() => {
  vi.mocked(checkSignupDomainAllowed).mockReset();
  vi.mocked(createClient).mockReset();
  vi.mocked(createAdminClient).mockReset();
});

describe("signUp: allowlist seam", () => {
  it("aborts on a disallowed domain and never calls supabase.auth.signUp", async () => {
    vi.mocked(checkSignupDomainAllowed).mockReturnValue({
      allowed: false,
      reason: "Signup is limited to example.com email addresses.",
    });
    // No createAdminClient/createClient stubbing at all: if the code
    // reaches past the domain check, the fake throws (there is no fake
    // here to throw from — vi.fn() from the module mock returns undefined,
    // and calling .from()/.auth on undefined throws a TypeError) rather
    // than silently succeeding.

    const result = await signUp(signUpFormData({ email: "person@blocked.com" }));

    expect(result).toEqual({
      error: "Signup is limited to example.com email addresses.",
      field: "email",
    });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("proceeds to signUp when the domain is allowed", async () => {
    vi.mocked(checkSignupDomainAllowed).mockReturnValue({ allowed: true });

    const profiles = fakeProfilesBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient({ profiles }) as never);

    const signUpMock = vi.fn(async () => ({
      data: { session: null, user: { id: "user-1" } },
      error: null,
    }));
    const supabase = fakeSupabaseClient({ signUp: signUpMock });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const result = await signUp(signUpFormData({ email: "person@allowed.com" }));

    expect(signUpMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: "person@allowed.com" }),
    );
    expect(result).toEqual({ checkInbox: true, email: "person@allowed.com" });
  });

  it("permits an arbitrary domain when SIGNUP_ALLOWED_DOMAINS is unset (open-signup default)", async () => {
    // Exercises the real lib/signup-allowlist.ts logic (unmocked return
    // value substituted with the actual permissive behavior) to document
    // that an unset/empty allowlist is a deliberate default, not an
    // accident of this file's mocking.
    const { checkSignupDomainAllowed: real } =
      await vi.importActual<typeof SignupAllowlistModule>("@/lib/signup-allowlist");
    vi.mocked(checkSignupDomainAllowed).mockImplementation((email, envVar) => real(email, envVar));

    const profiles = fakeProfilesBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient({ profiles }) as never);

    const signUpMock = vi.fn(async () => ({
      data: { session: null, user: { id: "user-1" } },
      error: null,
    }));
    const supabase = fakeSupabaseClient({ signUp: signUpMock });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const result = await signUp(signUpFormData({ email: "person@totally-arbitrary-domain.zzz" }));

    expect(signUpMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: "person@totally-arbitrary-domain.zzz" }),
    );
    expect(result).toEqual({ checkInbox: true, email: "person@totally-arbitrary-domain.zzz" });
  });
});

describe("signUp: server-side re-validation", () => {
  // The client already validates via signupFormSchema (lib/signup-schema.ts)
  // before this ever reaches the server, but "a client can post past it"
  // (auth.ts:116) — so this asserts the server itself refuses a bad payload
  // and never reaches the domain check or signUp, not merely that the
  // client would have caught it first.
  it("rejects a too-short password before checking the domain allowlist or calling signUp", async () => {
    const result = await signUp(signUpFormData({ password: "short", confirmPassword: "short" }));

    expect(result).toEqual({
      error: expect.stringMatching(/at least 8 characters/i),
      field: "password",
    });
    expect(checkSignupDomainAllowed).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("signUp: username availability", () => {
  it("refuses a taken username without calling supabase.auth.signUp", async () => {
    vi.mocked(checkSignupDomainAllowed).mockReturnValue({ allowed: true });

    const profiles = fakeProfilesBuilder(
      { data: null, error: null },
      { username: { data: { id: "existing-user" }, error: null } },
    );
    vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient({ profiles }) as never);
    // No createClient stub: signUp must never be reached.

    const result = await signUp(signUpFormData({ username: "taken" }));

    expect(result).toEqual({ error: "That username is taken. Try another.", field: "username" });
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("signUp: email availability", () => {
  it("refuses an email already present in profiles before calling Supabase signup", async () => {
    vi.mocked(checkSignupDomainAllowed).mockReturnValue({ allowed: true });

    const profiles = fakeProfilesBuilder(
      { data: null, error: null },
      { email: { data: { id: "existing-user" }, error: null } },
    );
    vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient({ profiles }) as never);

    const result = await signUp(signUpFormData({ email: "existing@example.com" }));

    expect(result).toEqual({
      error: "An account with this email already exists. Try signing in instead.",
      field: "email",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects Supabase's empty-identity duplicate response for a concurrent signup", async () => {
    vi.mocked(checkSignupDomainAllowed).mockReturnValue({ allowed: true });

    const profiles = fakeProfilesBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient({ profiles }) as never);

    const signUpMock = vi.fn(async () => ({
      data: { session: null, user: { id: "synthetic-user", identities: [] } },
      error: null,
    }));
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseClient({ signUp: signUpMock }) as never);

    const result = await signUp(signUpFormData({ email: "raced@example.com" }));

    expect(result).toEqual({
      error: "An account with this email already exists. Try signing in instead.",
      field: "email",
    });
  });
});

describe("signIn", () => {
  it("returns a generic error on invalid credentials without redirecting", async () => {
    const signInMock = vi.fn(async () => ({
      error: { code: "invalid_credentials", message: "bad" },
    }));
    const supabase = fakeSupabaseClient({ signInWithPassword: signInMock });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const fd = new FormData();
    fd.set("email", "person@example.com");
    fd.set("password", "whatever123");

    const result = await signIn(fd);

    expect(result).toEqual({ error: "Invalid email or password." });
  });

  it("redirects to /create on success", async () => {
    const signInMock = vi.fn(async () => ({ error: null }));
    const supabase = fakeSupabaseClient({
      signInWithPassword: signInMock,
      getUser: signedInUser(),
    });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const fd = new FormData();
    fd.set("email", "person@example.com");
    fd.set("password", "whatever123");

    await expect(signIn(fd)).rejects.toThrow("REDIRECT:/create");
  });

  // Deactivation takes access away, so the door is shut rather than the
  // room: no session survives the attempt.
  it("refuses a deactivated account the session entirely", async () => {
    const signOutMock = vi.fn(async () => ({ error: null }));
    const supabase = fakeSupabaseClient(
      {
        signInWithPassword: vi.fn(async () => ({ error: null })),
        getUser: signedInUser(),
        signOut: signOutMock,
      },
      { status: "deactivated" },
    );
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const fd = new FormData();
    fd.set("email", "person@example.com");
    fd.set("password", "whatever123");

    const result = await signIn(fd);

    expect(result).toEqual({
      error: "This account has been deactivated. Talk to an admin if you think that is wrong.",
    });
    // Signed out, not merely redirected — otherwise the cookie outlives the
    // refusal and the next request arrives authenticated.
    expect(signOutMock).toHaveBeenCalled();
  });

  // Pending is NOT this branch's business: /pending exists to tell that
  // account to wait, and refusing it here would replace guidance with a
  // dead end.
  it("still lets a pending account through to /pending", async () => {
    const supabase = fakeSupabaseClient(
      {
        signInWithPassword: vi.fn(async () => ({ error: null })),
        getUser: signedInUser(),
      },
      { status: "pending" },
    );
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const fd = new FormData();
    fd.set("email", "person@example.com");
    fd.set("password", "whatever123");

    await expect(signIn(fd)).rejects.toThrow("REDIRECT:/create");
  });
});

describe("signOut", () => {
  it("signs out and redirects to /login", async () => {
    const signOutMock = vi.fn(async () => ({ error: null }));
    const supabase = fakeSupabaseClient({ signOut: signOutMock });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    await expect(signOut()).rejects.toThrow("REDIRECT:/login");
    expect(signOutMock).toHaveBeenCalled();
  });
});
