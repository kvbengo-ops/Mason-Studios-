import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { createAdminClient } from "@/lib/supabase/server";
import { EXPECTED_DB_VERSION } from "@/lib/version";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

const mockedCreateAdminClient = vi.mocked(createAdminClient);

/**
 * Builds a stub admin client. `reachable` drives the shallow
 * prompt_templates probe, `version` drives the applied_schema_version() RPC.
 */
function stubClient({
  reachable = true,
  version = "0048",
  rpcThrows = false,
}: {
  reachable?: boolean;
  version?: string | null;
  rpcThrows?: boolean;
} = {}) {
  return {
    from: () => ({
      select: () => ({
        limit: async () => (reachable ? { error: null } : { error: { message: "boom" } }),
      }),
    }),
    rpc: async () => {
      if (rpcThrows) throw new Error("rpc exploded");
      return version === null
        ? { data: null, error: { message: "no such function" } }
        : { data: version, error: null };
    },
  } as unknown as ReturnType<typeof createAdminClient>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/health", () => {
  it("reports ok and the applied schema version when both reads succeed", async () => {
    mockedCreateAdminClient.mockReturnValue(stubClient({ version: "0048" }));

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      database: "reachable",
      dbVersion: "0048",
    });
  });

  // The contract this endpoint's header states: the version read is a
  // diagnostic, never a gate. A database that is reachable stays "ok" even
  // when applied_schema_version() is missing — which is the ordinary state
  // before 0046 is applied, not an outage.
  it("stays ok when the version RPC fails, reporting a null version", async () => {
    mockedCreateAdminClient.mockReturnValue(stubClient({ version: null }));

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      database: "reachable",
      dbVersion: null,
    });
  });

  it("stays ok when the version RPC throws outright", async () => {
    mockedCreateAdminClient.mockReturnValue(stubClient({ rpcThrows: true }));

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", dbVersion: null });
  });

  it("degrades to 503 when the database probe fails, still reporting the version", async () => {
    mockedCreateAdminClient.mockReturnValue(stubClient({ reachable: false, version: "0048" }));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      database: "boom",
      dbVersion: "0048",
    });
  });

  // The catch branch reports dbVersion: null outright rather than retrying a
  // client that just threw. Asserted so nobody "restores" a second round trip
  // that could only ever produce this same null.
  it("reports down with a null version when the client itself throws", async () => {
    mockedCreateAdminClient.mockImplementation(() => {
      throw new Error("no service role key");
    });

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "down",
      error: "no service role key",
      dbVersion: null,
    });
    // Exactly one construction attempt — the catch must not build another.
    expect(mockedCreateAdminClient).toHaveBeenCalledTimes(1);
  });

  // The file is not the process.
  //
  // worker/.env carried MOCK_FAL_VIDEO=1 all day on 2026-08-31 while the
  // running worker had it false, and that file was quoted three times as
  // proof local was mocked before a real $2.52 render said otherwise. Both
  // services now answer the question themselves instead of being read off
  // disk. These pin the web half. MODE replaced the old independent
  // MOCK_CLAUDE/MOCK_FAL_IMAGE pair with one switch (lib/mode.ts), so there
  // is one value to report, not two that could disagree.
  describe("mode reporting", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reports this process's MODE", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("MODE", "production");
      mockedCreateAdminClient.mockReturnValue(stubClient({ version: "0060" }));

      const body = await (await GET()).json();
      expect(body.mode).toBe("production");
    });

    it("omits the block entirely in a production build", async () => {
      // Not reported as false: MODE is a local-development fact, and a
      // deployed endpoint echoing it invites someone to wonder whether it's
      // ever wrong there.
      vi.stubEnv("NODE_ENV", "production");
      mockedCreateAdminClient.mockReturnValue(stubClient({ version: "0060" }));

      const body = await (await GET()).json();
      expect(body.mode).toBeUndefined();
      expect(body.status).toBe("ok");
    });
  });
});

// The drift this endpoint now exists to make visible. On 2026-09-03 production
// answered dbVersion 0075 while every pushed branch stopped at 0074, and
// nothing anywhere printed the two numbers side by side — version.test.ts
// compares the constant to the migrations DIRECTORY, so CI stays green while
// the repo and the live database come apart.
describe("GET /api/health — schema drift", () => {
  it("says aligned when the database is on the migration this build expects", async () => {
    mockedCreateAdminClient.mockReturnValue(stubClient({ version: EXPECTED_DB_VERSION }));

    await expect((await GET()).json()).resolves.toMatchObject({
      expectedDbVersion: EXPECTED_DB_VERSION,
      schemaDrift: "aligned",
    });
  });

  it("says database-ahead when a migration was applied that the repo does not have", async () => {
    // The 2026-09-03 case exactly: additive and harmless the day it happens,
    // then a schema nobody can rebuild from the repo.
    mockedCreateAdminClient.mockReturnValue(stubClient({ version: "9999" }));

    await expect((await GET()).json()).resolves.toMatchObject({
      dbVersion: "9999",
      schemaDrift: "database-ahead",
    });
  });

  it("says code-ahead when the deploy landed before its migration", async () => {
    mockedCreateAdminClient.mockReturnValue(stubClient({ version: "0001" }));

    await expect((await GET()).json()).resolves.toMatchObject({
      dbVersion: "0001",
      schemaDrift: "code-ahead",
    });
  });

  it("reports null drift rather than aligned when the version cannot be read", async () => {
    // "I could not read it" and "they match" must not look the same to
    // whoever is reading this endpoint during an incident.
    mockedCreateAdminClient.mockReturnValue(stubClient({ version: null }));

    await expect((await GET()).json()).resolves.toMatchObject({
      status: "ok",
      dbVersion: null,
      schemaDrift: null,
    });
  });
});
