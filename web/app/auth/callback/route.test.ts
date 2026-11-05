import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";

// This route is hit by the redirect link in password-recovery and
// email-confirmation emails, so its `next` query param is
// attacker-influenced. It is guarded by two independent layers:
//   1. safeNext() — rejects anything not starting with "/", anything
//      starting with "//", and anything containing a backslash.
//   2. after resolving `next` against `base`, a check that the resolved
//      URL's origin still equals `base`.
// Every open-redirect test below asserts on the route's actual redirect
// Location, not on safeNext in isolation, because layer 2 is part of the
// real guarantee — a payload that slips past layer 1 (e.g. embedded
// tab/newline, which WHATWG URL parsing strips before resolving) still has
// to be caught by layer 2 to be safe.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

const mockedCreateClient = vi.mocked(createClient);

function stubSupabase(error: { message: string } | null): Awaited<ReturnType<typeof createClient>> {
  return {
    auth: {
      exchangeCodeForSession: vi.fn(async () => ({ error })),
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>;
}

function request(pathAndQuery: string, origin = "https://good.example"): NextRequest {
  return new NextRequest(new URL(pathAndQuery, origin));
}

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
});

describe("GET /auth/callback — happy and failure paths", () => {
  it("exchanges a valid code and redirects to the resolved next on base", async () => {
    mockedCreateClient.mockResolvedValue(stubSupabase(null));

    const res = await GET(request("/auth/callback?code=abc123&next=/settings"));

    expect(res.headers.get("location")).toBe("https://good.example/settings");
  });

  it("falls back to the default next (/create) when none is supplied", async () => {
    mockedCreateClient.mockResolvedValue(stubSupabase(null));

    const res = await GET(request("/auth/callback?code=abc123"));

    expect(res.headers.get("location")).toBe("https://good.example/create");
  });

  it("redirects to /login on base when the exchange errors", async () => {
    mockedCreateClient.mockResolvedValue(stubSupabase({ message: "invalid code" }));

    const res = await GET(request("/auth/callback?code=bad&next=/settings"));

    expect(res.headers.get("location")).toBe("https://good.example/login");
  });

  it("redirects to /login on base when no code is present at all", async () => {
    const res = await GET(request("/auth/callback?next=/settings"));

    expect(res.headers.get("location")).toBe("https://good.example/login");
    // No code means the exchange must never even be attempted.
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });
});

describe("GET /auth/callback — base resolution (Render-proxy fallback)", () => {
  it("uses NEXT_PUBLIC_APP_URL instead of the request origin when set", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
    mockedCreateClient.mockResolvedValue(stubSupabase(null));

    // Request origin resolves to the unroutable in-container address, the
    // way it does behind Render's proxy.
    const res = await GET(
      request("/auth/callback?code=abc123&next=/settings", "https://0.0.0.0:10000"),
    );

    expect(res.headers.get("location")).toBe("https://app.example/settings");
  });

  it("falls back to the request origin when NEXT_PUBLIC_APP_URL is unset", async () => {
    mockedCreateClient.mockResolvedValue(stubSupabase(null));

    const res = await GET(
      request("/auth/callback?code=abc123&next=/settings", "https://good.example"),
    );

    expect(res.headers.get("location")).toBe("https://good.example/settings");
  });
});

describe("GET /auth/callback — open-redirect rejection", () => {
  const base = "https://good.example";

  // Every candidate here must land the redirect on `base`, never on
  // evil.com, regardless of which of the two layers is doing the catching.
  const hostileNextToDefault: Array<[string, string]> = [
    ["protocol-relative", "//evil.com"],
    ["triple-slash protocol-relative", "///evil.com"],
    ["backslash after leading slash", "/\\evil.com"],
    ["backslash then slash", "/\\/evil.com"],
    ["absolute https URL", "https://evil.com"],
    ["absolute http URL", "http://evil.com"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["percent-encoded, no leading slash", "%2f%2fevil.com"],
  ];

  it.each(hostileNextToDefault)(
    "%s (%s) falls back to the default path on base",
    async (_label, candidate) => {
      mockedCreateClient.mockResolvedValue(stubSupabase(null));

      const res = await GET(
        request(`/auth/callback?code=abc123&next=${encodeURIComponent(candidate)}`, base),
      );

      const location = res.headers.get("location")!;
      expect(new URL(location).origin).toBe(base);
      expect(location).toBe(`${base}/create`);
    },
  );

  // These pass layer 1 (they start with "/", not "//", and carry no literal
  // backslash) but WHATWG URL parsing strips embedded tab/newline/CR before
  // resolving, which turns them into a protocol-relative reference. Layer 2
  // (the post-resolution origin check) is what actually stops these — this
  // is the exact case the task calls out as a real risk if layer 2 is ever
  // removed or bypassed by a client that doesn't strip these characters.
  const controlCharSmuggled: Array<[string, string]> = [
    ["embedded tab", "/\t/evil.com"],
    ["embedded newline", "/\n/evil.com"],
    ["embedded CR", "/\r/evil.com"],
  ];

  it.each(controlCharSmuggled)(
    "%s (%s) survives safeNext but is still caught by the origin check",
    async (_label, candidate) => {
      mockedCreateClient.mockResolvedValue(stubSupabase(null));

      const res = await GET(
        request(`/auth/callback?code=abc123&next=${encodeURIComponent(candidate)}`, base),
      );

      // safeNext() lets these through unchanged (no "//" prefix, no literal
      // backslash), so layer 2 is the only thing standing between this and
      // evil.com. Since the resolved origin does not match base, the route
      // never redirects to `target` at all — it falls through to /login.
      const location = res.headers.get("location")!;
      expect(new URL(location).origin).toBe(base);
      expect(location).toBe(`${base}/login`);
    },
  );

  it("percent-encoded //, with a leading slash, stays on-origin (no double-decode)", async () => {
    mockedCreateClient.mockResolvedValue(stubSupabase(null));

    const res = await GET(
      request(`/auth/callback?code=abc123&next=${encodeURIComponent("/%2f%2fevil.com")}`, base),
    );

    const location = res.headers.get("location")!;
    expect(new URL(location).origin).toBe(base);
  });

  // A backslash that does NOT resolve off-origin (mid-path, not right after
  // the leading slash) — this is the case that isolates the backslash guard
  // from the origin-check guard: without the backslash guard this would
  // resolve on-origin to "/valid/path" (URL parsing folds a mid-path
  // backslash to a slash for a special scheme), so layer 2 would silently
  // pass it and only safeNext's explicit backslash rejection stops it.
  it("a same-origin-resolving backslash payload is still rejected by safeNext, not just the origin check", async () => {
    mockedCreateClient.mockResolvedValue(stubSupabase(null));

    const res = await GET(
      request(`/auth/callback?code=abc123&next=${encodeURIComponent("/valid\\path")}`, base),
    );

    const location = res.headers.get("location")!;
    expect(location).toBe(`${base}/create`);
  });

  it("legitimate relative paths are honoured", async () => {
    mockedCreateClient.mockResolvedValue(stubSupabase(null));

    const res = await GET(request("/auth/callback?code=abc123&next=/projects", base));

    expect(res.headers.get("location")).toBe(`${base}/projects`);
  });
});
