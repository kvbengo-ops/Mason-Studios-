import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

// Proves readAppliedSchemaVersion (lib/db-version.ts) keeps its fail-soft
// contract: applied_schema_version() is a diagnostic readout for the sidebar
// footer, not a gate, so a missing function (not yet migrated), a failed
// RPC, or a thrown error must all degrade to `null` — never propagate and
// take app/(app)/layout.tsx (every authenticated page) down with it. This is
// the CURRENT state of the target database, since 0046 is unapplied.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

describe("readAppliedSchemaVersion", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns the version string on a successful RPC read", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(() => Promise.resolve({ data: "0045", error: null })),
    } as unknown as SupabaseClient<Database>);

    const { readAppliedSchemaVersion } = await import("./db-version");
    expect(await readAppliedSchemaVersion()).toBe("0045");
  });

  it("returns null when the RPC responds with an error, even if `data` is truthy", async () => {
    // `data` is deliberately non-null here — a stale/misleading payload
    // alongside an error is exactly the case a `data ?? null` fallback
    // WITHOUT an explicit `error` check would miss (it would happily return
    // "0045" instead of null). Only checking `error` first catches this.
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(() =>
        Promise.resolve({
          data: "0045",
          error: { message: "function applied_schema_version() does not exist" },
        }),
      ),
    } as unknown as SupabaseClient<Database>);

    const { readAppliedSchemaVersion } = await import("./db-version");
    expect(await readAppliedSchemaVersion()).toBeNull();
  });

  it("returns null (not undefined) when data comes back undefined without an error", async () => {
    // `undefined`, not `null` — the mocked shape a bare `return data;` (no
    // `?? null`) would pass straight through unchanged, since `data` is
    // already `null` in every other case here. Only the `?? null` coalesce
    // normalizes this one to `null`.
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(() => Promise.resolve({ data: undefined, error: null })),
    } as unknown as SupabaseClient<Database>);

    const { readAppliedSchemaVersion } = await import("./db-version");
    expect(await readAppliedSchemaVersion()).toBeNull();
  });

  it("returns null when the rpc call throws (network hiccup)", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(() => {
        throw new Error("network hiccup");
      }),
    } as unknown as SupabaseClient<Database>);

    const { readAppliedSchemaVersion } = await import("./db-version");
    expect(await readAppliedSchemaVersion()).toBeNull();
  });

  it("returns null when createClient() itself rejects (auth/RLS surprise)", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockRejectedValue(new Error("auth surprise"));

    const { readAppliedSchemaVersion } = await import("./db-version");
    expect(await readAppliedSchemaVersion()).toBeNull();
  });
});
