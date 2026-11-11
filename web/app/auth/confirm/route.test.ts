import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

const mockedCreateClient = vi.mocked(createClient);

function stubSupabase(
  error: { message: string } | null,
  verifyOtpMock = vi.fn(async () => ({ error })),
): {
  client: Awaited<ReturnType<typeof createClient>>;
  verifyOtpMock: ReturnType<typeof vi.fn>;
} {
  return {
    client: {
      auth: {
        verifyOtp: verifyOtpMock,
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>,
    verifyOtpMock,
  };
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

describe("GET /auth/confirm — happy and failure paths", () => {
  it("verifies a recovery token_hash and redirects to the resolved next on base", async () => {
    const { client, verifyOtpMock } = stubSupabase(null);
    mockedCreateClient.mockResolvedValue(client);

    const res = await GET(
      request("/auth/confirm?token_hash=pkce_hash_123&type=recovery&next=/reset-password"),
    );

    expect(verifyOtpMock).toHaveBeenCalledWith({
      token_hash: "pkce_hash_123",
      type: "recovery",
    });
    expect(res.headers.get("location")).toBe("https://good.example/reset-password");
  });

  it("falls back to the default next (/create) when none is supplied", async () => {
    const { client } = stubSupabase(null);
    mockedCreateClient.mockResolvedValue(client);

    const res = await GET(request("/auth/confirm?token_hash=pkce_hash_123&type=recovery"));

    expect(res.headers.get("location")).toBe("https://good.example/create");
  });

  it("redirects to /login on base when verifyOtp errors", async () => {
    const { client } = stubSupabase({ message: "Token has expired or is invalid" });
    mockedCreateClient.mockResolvedValue(client);

    const res = await GET(
      request("/auth/confirm?token_hash=bad&type=recovery&next=/reset-password"),
    );

    expect(res.headers.get("location")).toBe("https://good.example/login");
  });

  it("redirects to /login on base when token_hash or type=recovery is missing", async () => {
    const resMissingHash = await GET(request("/auth/confirm?type=recovery&next=/reset-password"));
    expect(resMissingHash.headers.get("location")).toBe("https://good.example/login");

    const resWrongType = await GET(
      request("/auth/confirm?token_hash=pkce_hash_123&type=signup&next=/reset-password"),
    );
    expect(resWrongType.headers.get("location")).toBe("https://good.example/login");
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });
});

describe("GET /auth/confirm — open-redirect rejection", () => {
  const base = "https://good.example";

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
      const { client } = stubSupabase(null);
      mockedCreateClient.mockResolvedValue(client);

      const res = await GET(
        request(
          `/auth/confirm?token_hash=pkce_hash_123&type=recovery&next=${encodeURIComponent(candidate)}`,
          base,
        ),
      );

      const location = res.headers.get("location")!;
      expect(new URL(location).origin).toBe(base);
      expect(location).toBe(`${base}/create`);
    },
  );
});
