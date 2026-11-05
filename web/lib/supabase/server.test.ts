// Covers only createAdminClient's memoization, which is the part of this
// file with behaviour worth pinning: it is shared across requests, and the
// reason that is safe (no per-request state) is an argument that could stop
// being true if someone later gave the client a session. createClient() is
// not covered here — it reads cookies via next/headers and would need a
// request context this suite has no reason to fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AdminClientOptions {
  auth: { autoRefreshToken: boolean; persistSession: boolean };
}

const createSupabaseClient = vi.fn(
  (_url: string, _key: string, _options: AdminClientOptions): { marker: symbol } => ({
    marker: Symbol("client"),
  }),
);

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, options: AdminClientOptions): { marker: symbol } =>
    createSupabaseClient(url, key, options),
}));

// next/headers is imported at module scope by createClient() above the
// function under test; stubbed so importing this module doesn't need a
// request context.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value",
};

describe("createAdminClient", () => {
  beforeEach(() => {
    vi.resetModules();
    createSupabaseClient.mockClear();
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the same instance across calls, and constructs it once", async () => {
    const { createAdminClient } = await import("./server");

    const first = createAdminClient();
    const second = createAdminClient();
    const third = createAdminClient();

    expect(second).toBe(first);
    expect(third).toBe(first);
    // The point of the memo: a single sidebar render calls this about six
    // times, and there are 75 call sites overall.
    expect(createSupabaseClient).toHaveBeenCalledTimes(1);
  });

  it("builds a session-less client — the reason sharing one is safe", async () => {
    const { createAdminClient } = await import("./server");
    createAdminClient();

    const call = createSupabaseClient.mock.calls[0];
    expect(call).toBeDefined();
    const [url, key, options] = call!;
    expect(url).toBe(ENV.NEXT_PUBLIC_SUPABASE_URL);
    expect(key).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    // If either of these ever becomes true, the client starts carrying
    // state and module-scope memoization stops being safe.
    expect(options.auth.autoRefreshToken).toBe(false);
    expect(options.auth.persistSession).toBe(false);
  });

  it("does not memoize a failure — a missing env var keeps throwing", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { createAdminClient } = await import("./server");

    expect(() => createAdminClient()).toThrow();
    // Not "threw once then handed back a broken client forever": the
    // assignment happens only after both env reads succeed, so the second
    // call re-runs them and throws again.
    expect(() => createAdminClient()).toThrow();
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });
});
