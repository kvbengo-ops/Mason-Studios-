import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachRunAsset,
  recordRun,
  recordedCall,
  sweepStaleImageReservations,
  failedRunFields,
} from "./runs";
import { ImageGenerationError, KieTaskPendingError } from "./kie";
import { BILLING_UNKNOWN_PREFIX } from "./image-attempt";
import { createAdminClient } from "@/lib/supabase/server";

// recordRun is the one place that INSERTs into `runs` — every spend
// aggregate (spend_total_usd, user_spend_usd, the sidebar snapshot) reads
// this table back, so a wrong or missing write here makes every cap wrong
// too. These tests pin the row it writes, its throw-on-failure behaviour,
// and recordedCall's record-both-outcomes wrapping.
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

interface FakeInsertResult {
  error: { message: string } | null;
}

function fakeAdminClient(result: FakeInsertResult): {
  from: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn(async (_payload: unknown) => result);
  return {
    from: vi.fn((table: string) => {
      if (table !== "runs") throw new Error(`Test did not stub table "${table}"`);
      return { insert };
    }),
    insert,
  };
}

afterEach(() => {
  vi.mocked(createAdminClient).mockReset();
});

describe("recordRun", () => {
  it("writes the exact row it was given", async () => {
    const admin = fakeAdminClient({ error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await recordRun({
      projectId: "project-1",
      sceneId: "scene-1",
      vendor: "fal",
      model: "some-model",
      costUsd: 0.42,
    });

    expect(admin.insert).toHaveBeenCalledWith({
      project_id: "project-1",
      // Unset by every project-backed caller, and written as an explicit null
      // rather than omitted: user_spend_usd resolves the owner as
      // coalesce(runs.user_id, projects.user_id) since 0085, so null here is
      // "ask the project", not "nobody".
      user_id: null,
      scene_id: "scene-1",
      vendor: "fal",
      model: "some-model",
      cost_usd: 0.42,
      // Null on the success path by design: there is nothing left to reconcile
      // once the outcome is known. It is filled in on ONE path — a poll-budget
      // timeout, via failedRunFields below.
      kie_task_id: null,
      error: null,
    });
  });

  it("defaults a null project (the library-wide call site) rather than dropping the field", async () => {
    const admin = fakeAdminClient({ error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await recordRun({ projectId: null, vendor: "fal", model: "m", costUsd: 1 });

    expect(admin.insert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: null, user_id: null, scene_id: null }),
    );
  });

  it("attributes a project-less run to its owner, so the caps can still see it", async () => {
    const admin = fakeAdminClient({ error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    // The personal Image Generator's shape (0085): no project, but a real
    // owner. Without user_id on the row there is nothing for a per-user
    // aggregate to join to, and the spend reads $0 against the weekly
    // allowance — the failure 0030_runs_project_id.sql's header names.
    await recordRun({ projectId: null, userId: "user-9", vendor: "kie", model: "m", costUsd: 1 });

    expect(admin.insert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: null, user_id: "user-9" }),
    );
  });

  it("throws on a genuine insert failure, rather than swallowing it", async () => {
    const admin = fakeAdminClient({ error: { message: "insert failed" } });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await expect(
      recordRun({ projectId: "project-1", vendor: "fal", model: "m", costUsd: 1 }),
    ).rejects.toThrow(/insert failed/);
  });
});

describe("recordedCall", () => {
  it("returns the wrapped call's result unchanged, and records the success cost", async () => {
    const admin = fakeAdminClient({ error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await recordedCall(
      { projectId: "project-1", vendor: "fal", model: "m" },
      0.5,
      async () => ({ url: "https://example.com/x.png" }),
    );

    expect(result).toEqual({ url: "https://example.com/x.png" });
    expect(admin.insert).toHaveBeenCalledWith(
      expect.objectContaining({ cost_usd: 0.5, error: null }),
    );
  });

  it("records a run with cost_usd null and the error message, then rethrows, on failure", async () => {
    const admin = fakeAdminClient({ error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const boom = new Error("vendor exploded");

    await expect(
      recordedCall({ projectId: "project-1", vendor: "fal", model: "m" }, 0.5, async () => {
        throw boom;
      }),
    ).rejects.toThrow("vendor exploded");

    expect(admin.insert).toHaveBeenCalledWith(
      expect.objectContaining({ cost_usd: null, error: "vendor exploded" }),
    );
    // The failure path must never record the price the call would have cost
    // if it had succeeded — that's exactly the "billed a charge that never
    // happened" case recordRun's own comment says is as wrong as missing one.
    expect(admin.insert).not.toHaveBeenCalledWith(expect.objectContaining({ cost_usd: 0.5 }));
  });
});

// ---------------------------------------------------------------------------
// The sweep's SCOPE, which is the half of it that can do damage.
//
// Settling at the estimate is safe by design (see sweepStaleImageReservations'
// own comment). Settling the WRONG ROWS is not: reserve_image_attempt writes
// user_id on both shapes (0085), so a personal sweep filtered on user_id alone
// would reach into that same account's project-backed reservations and mark an
// in-flight attempt billing-unknown from a page that has no business touching
// it. The `project_id is null` filter is what stops that, and it is invisible
// in review — one chained call among five — which is why it is pinned here.
// ---------------------------------------------------------------------------
function fakeSweepClient(): {
  client: { from: ReturnType<typeof vi.fn> };
  filters: Array<[string, string, unknown]>;
} {
  const filters: Array<[string, string, unknown]> = [];
  const builder = {
    eq: vi.fn((column: string, value: unknown) => {
      filters.push(["eq", column, value]);
      return builder;
    }),
    is: vi.fn((column: string, value: unknown) => {
      filters.push(["is", column, value]);
      return builder;
    }),
    not: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    select: vi.fn(async () => ({ data: [], error: null })),
  };
  return {
    client: {
      from: vi.fn((table: string) => {
        if (table !== "runs") throw new Error(`Test did not stub table "${table}"`);
        return { update: vi.fn(() => builder) };
      }),
    },
    filters,
  };
}

describe("sweepStaleImageReservations", () => {
  it("scopes a project sweep to that project, and never to an account", async () => {
    const { client, filters } = fakeSweepClient();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await sweepStaleImageReservations({ projectId: "project-1" });

    expect(filters).toContainEqual(["eq", "project_id", "project-1"]);
    expect(filters.some(([, column]) => column === "user_id")).toBe(false);
  });

  it("scopes a personal sweep to project-less rows of that account only", async () => {
    const { client, filters } = fakeSweepClient();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await sweepStaleImageReservations({ projectId: null, userId: "user-9" });

    expect(filters).toContainEqual(["eq", "user_id", "user-9"]);
    // The filter that keeps this account's PROJECT reservations out of reach.
    expect(filters).toContainEqual(["is", "project_id", null]);
  });
});

// The rule that decides whether a timed-out generation is reported as free.
// kie's poll budget expires while the vendor is still drawing (measured: a 149s
// generation against a 100s budget), and every call site here records the
// outcome AFTER the fact — so this function is the only thing standing between
// "held at the estimate, task id kept, reconcilable" and "recorded as a $0
// failure and lost".
describe("failedRunFields", () => {
  it("holds the estimate and keeps the task id when the poll budget expired", () => {
    const err = new KieTaskPendingError(
      "task-abc",
      "generating",
      "kie task task-abc did not finish within 100s",
    );

    expect(failedRunFields(err, 0.02)).toEqual({
      kieTaskId: "task-abc",
      costUsd: 0.02,
      error: `${BILLING_UNKNOWN_PREFIX}kie task task-abc did not finish within 100s`,
    });
  });

  it("asserts no charge for every other failure, as before", () => {
    expect(failedRunFields(new ImageGenerationError("kie rejected the prompt"), 0.02)).toEqual({
      kieTaskId: null,
      costUsd: null,
      error: "kie rejected the prompt",
    });
  });

  it("stringifies a non-Error throw rather than losing it", () => {
    expect(failedRunFields("boom", 0.02)).toEqual({
      kieTaskId: null,
      costUsd: null,
      error: "boom",
    });
  });
});

// ---------------------------------------------------------------------------
// The link that makes recovery safe to press twice.
//
// "Check status / Recover image" is a button, and a button gets double-clicked.
// Both presses read the same finished task from kie (a free GET, so neither
// costs money), both upload, and both insert an asset — and exactly one of them
// may become the attempt's image. `is("asset_id", null)` is the whole mechanism,
// and it is one chained call among four: invisible in review, and silently
// reverting to last-write-wins would strand the first image as an asset row
// nothing references. Hence pinned here.
// ---------------------------------------------------------------------------
function fakeLinkClient(result: { data: unknown[] | null; error: { message: string } | null }): {
  client: { from: ReturnType<typeof vi.fn> };
  filters: Array<[string, string, unknown]>;
  update: ReturnType<typeof vi.fn>;
} {
  const filters: Array<[string, string, unknown]> = [];
  const builder = {
    eq: vi.fn((column: string, value: unknown) => {
      filters.push(["eq", column, value]);
      return builder;
    }),
    is: vi.fn((column: string, value: unknown) => {
      filters.push(["is", column, value]);
      return builder;
    }),
    select: vi.fn(async () => result),
  };
  const update = vi.fn(() => builder);
  return {
    client: {
      from: vi.fn((table: string) => {
        if (table !== "runs") throw new Error(`Test did not stub table "${table}"`);
        return { update };
      }),
    },
    filters,
    update,
  };
}

describe("attachRunAsset", () => {
  it("claims the run only while its asset_id is still null", async () => {
    const { client, filters, update } = fakeLinkClient({ data: [{ id: "run-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    expect(await attachRunAsset("run-1", "asset-1")).toBe("linked");
    expect(update).toHaveBeenCalledWith({ asset_id: "asset-1" });
    expect(filters).toContainEqual(["eq", "id", "run-1"]);
    // THE PREDICATE. Without it the second of two concurrent recoveries
    // overwrites the first one's link and orphans its image.
    expect(filters).toContainEqual(["is", "asset_id", null]);
  });

  it("reports `taken` when another writer already linked an image", async () => {
    // Postgres serialises the two updates on the row lock, so the loser's
    // `asset_id is null` no longer holds and it matches zero rows.
    const { client } = fakeLinkClient({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    expect(await attachRunAsset("run-1", "asset-2")).toBe("taken");
  });

  it("reports `unknown` — never `taken` — when the write itself failed", async () => {
    // The distinction is the point: `taken` tells the caller to DELETE the image
    // it just stored, and doing that on a failed bookkeeping write would destroy
    // a real, paid-for picture that nothing else has a copy of.
    const { client } = fakeLinkClient({ data: null, error: { message: "connection reset" } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    expect(await attachRunAsset("run-1", "asset-1")).toBe("unknown");
  });
});
