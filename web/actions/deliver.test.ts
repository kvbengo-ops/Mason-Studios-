import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reopenProject,
  reassembleProject,
  getCutStatus,
  reorderCut,
  markDelivered,
} from "./deliver";
import { reorderScenes } from "./brief";
import { requireProject, requireProjectReadable } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { removeStorageObjects } from "@/lib/storage";

// The explicit "way back" out of 'delivered' (requirement 4 of the
// commitment-point move: character/brief/frames stay locked at
// `project.status === 'delivered'` — lib/editable-guard.ts's header
// comment — until this runs).
//
// Also covers reassembleProject (deletes the `final`/poster assets so the
// worker's assemble loop rebuilds them — see that function's doc comment)
// and getCutStatus (the three-state staleness read the UI agent consumes).
vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
  requireProjectReadable: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  removeStorageObjects: vi.fn(),
  signedUrl: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

function fakeBuilder(result: FakeQueryResult = { data: null, error: null }): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    single: vi.fn(() => builder),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

// Memoizes one builder per table so a test can grab the builder for a given
// table off the return value and assert on its update/delete/etc. calls,
// even across multiple `.from(table)` calls in the same action.
function fakeClientFor(tableResults: Record<string, FakeQueryResult>): {
  from: ReturnType<typeof vi.fn>;
  builders: Record<string, FakeQueryBuilder>;
} {
  const builders: Record<string, FakeQueryBuilder> = {};
  return {
    builders,
    from: vi.fn((table: string) => {
      const result = tableResults[table];
      if (!result) throw new Error(`Test did not stub table "${table}"`);
      builders[table] ??= fakeBuilder(result);
      return builders[table];
    }),
  };
}

afterEach(() => {
  vi.mocked(requireProject).mockReset();
  vi.mocked(requireProjectReadable).mockReset();
  vi.mocked(createClient).mockReset();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(removeStorageObjects).mockReset();
});

describe("reopenProject", () => {
  it("clears 'delivered' back to a non-delivered status", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "delivered" },
    } as never);
    const admin = fakeClientFor({ projects: { data: null, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await reopenProject("project-1");

    expect(admin.builders.projects!.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "complete" }),
    );
  });

  it("is a no-op when the project isn't currently delivered", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete" },
    } as never);
    const admin = fakeClientFor({ projects: { data: null, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await reopenProject("project-1");

    expect(admin.from).not.toHaveBeenCalled();
  });
});

// reassembleProject no longer touches `assets` at all (0060_final_versions.sql):
// asking for a build is an INSERT into final_versions, not a delete of the
// previous cut. These pin that the destruction is really gone, and that the
// recipe recorded is the project's scenes in idx order at their active
// versions.
function fakeAdminClientForAssemble({
  scenes,
  inserted = { id: "version-2" },
}: {
  scenes: { id: string; active_version_id: string | null }[];
  inserted?: { id: string } | null;
}): {
  from: ReturnType<typeof vi.fn>;
  builders: Record<string, FakeQueryBuilder>;
} {
  const builders: Record<string, FakeQueryBuilder> = {
    scenes: fakeBuilder({ data: scenes, error: null }),
    final_versions: fakeBuilder({ data: inserted, error: null }),
    projects: fakeBuilder({ data: null, error: null }),
  };
  return {
    builders,
    from: vi.fn((table: string) => {
      const builder = builders[table];
      if (!builder) throw new Error(`Test did not stub table "${table}"`);
      return builder;
    }),
  };
}

describe("reassembleProject", () => {
  it("inserts a version carrying the recipe, and deletes nothing", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete", active_final_version_id: null },
    } as never);
    const admin = fakeAdminClientForAssemble({
      scenes: [
        { id: "scene-1", active_version_id: "sv-1" },
        { id: "scene-2", active_version_id: null },
      ],
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reassembleProject("project-1");

    expect(result).toBeUndefined();
    expect(admin.builders.final_versions!.insert).toHaveBeenCalledWith({
      project_id: "project-1",
      // dev is asserted, not ignored. It is the MODE partition (0069): a
      // build request that forgets it takes the column's `false` default and
      // becomes claimable by the PRODUCTION worker, which is the same
      // shared-table race scenes.dev closes one step earlier. Tests default
      // to MODE=development, so false here would mean the stamp was dropped.
      dev: true,
      // `n` is deliberately absent — the final_versions_assign_n trigger
      // assigns it, so two concurrent requests cannot collide on
      // `unique (project_id, n)`.
      recipe: [
        { scene_id: "scene-1", scene_version_id: "sv-1" },
        { scene_id: "scene-2", scene_version_id: null },
      ],
    });
    // The whole point: no asset row and no Storage object is destroyed to
    // ask for a rebuild any more.
    expect(admin.builders.assets).toBeUndefined();
    expect(removeStorageObjects).not.toHaveBeenCalled();
  });

  it("points the project at the version it just opened", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete", active_final_version_id: "version-1" },
    } as never);
    const admin = fakeAdminClientForAssemble({
      scenes: [{ id: "scene-1", active_version_id: "sv-1" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await reassembleProject("project-1", "new");

    expect(admin.builders.projects!.update).toHaveBeenCalledWith({
      active_final_version_id: "version-2",
    });
  });

  it("'update' re-opens the ACTIVE version in place instead of inserting one", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete", active_final_version_id: "version-1" },
    } as never);
    const admin = fakeAdminClientForAssemble({
      scenes: [{ id: "scene-1", active_version_id: "sv-1" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reassembleProject("project-1", "update");

    expect(result).toBeUndefined();
    expect(admin.builders.final_versions!.insert).not.toHaveBeenCalled();
    expect(admin.builders.final_versions!.update).toHaveBeenCalledWith(
      expect.objectContaining({
        built_at: null,
        failed_at: null,
        failure_reason: null,
        final_asset_id: null,
        poster_asset_id: null,
        recipe: [{ scene_id: "scene-1", scene_version_id: "sv-1" }],
      }),
    );
  });

  it("'update' on a project that has never been assembled opens a version instead of failing", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete", active_final_version_id: null },
    } as never);
    const admin = fakeAdminClientForAssemble({
      scenes: [{ id: "scene-1", active_version_id: "sv-1" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await reassembleProject("project-1", "update");

    expect(admin.builders.final_versions!.insert).toHaveBeenCalled();
  });

  it("refuses a project with no scenes — there is nothing to assemble", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete", active_final_version_id: null },
    } as never);
    const admin = fakeAdminClientForAssemble({ scenes: [] });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reassembleProject("project-1");

    expect(result).toEqual({ error: expect.stringMatching(/no scenes/i) });
    expect(admin.builders.final_versions!.insert).not.toHaveBeenCalled();
  });

  it("refuses once the project has been delivered", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "delivered", active_final_version_id: "version-1" },
    } as never);
    const admin = fakeAdminClientForAssemble({ scenes: [] });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reassembleProject("project-1");

    expect(result).toEqual({ error: expect.stringMatching(/delivered/i) });
    // Refused before ever reading a scene or opening a version.
    expect(admin.from).not.toHaveBeenCalled();
  });
});

// getCutStatus resolves the cut through projects.active_final_version_id ->
// final_versions.final_asset_id -> assets (0060_final_versions.sql), not
// `assets.find(kind === 'final')`. The scenes read is the recipe comparison
// that replaced deleting the final on every re-render.
function stubCutStatus({
  finalAsset,
  recipe = [{ scene_id: "scene-1", scene_version_id: "sv-1" }],
  scenes = [{ id: "scene-1", active_version_id: "sv-1" }],
}: {
  finalAsset: { created_at: string; built_from_cut_order_at: string | null } | null;
  recipe?: unknown;
  scenes?: { id: string; active_version_id: string | null }[];
}): ReturnType<typeof fakeClientFor> {
  return fakeClientFor({
    final_versions: {
      data: [{ final_asset_id: finalAsset === null ? null : "final-1", recipe }],
      error: null,
    },
    assets: { data: finalAsset === null ? [] : [finalAsset], error: null },
    scenes: { data: scenes, error: null },
  });
}

function readableProject(overrides: Record<string, unknown> = {}): never {
  return {
    project: {
      id: "project-1",
      cut_order_updated_at: null,
      active_final_version_id: "version-1",
      ...overrides,
    },
  } as never;
}

describe("getCutStatus", () => {
  it("returns 'no_final' when the project has never been assembled", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue(
      readableProject({ active_final_version_id: null }),
    );
    const supabase = fakeClientFor({ assets: { data: [], error: null } });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const result = await getCutStatus("project-1");

    expect(result).toEqual({ state: "no_final" });
  });

  // Still building, or pruned to its recipe: either way there is no cut to
  // be stale, and the Deliver page reports those on their own terms.
  it("returns 'no_final' when the active version has no file", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue(readableProject());
    vi.mocked(createClient).mockResolvedValue(stubCutStatus({ finalAsset: null }) as never);

    const result = await getCutStatus("project-1");

    expect(result).toEqual({ state: "no_final" });
  });

  it("returns 'current' when the cut order has never been reordered", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue(readableProject());
    vi.mocked(createClient).mockResolvedValue(
      stubCutStatus({
        finalAsset: { created_at: "2026-08-01T00:00:00.000Z", built_from_cut_order_at: null },
      }) as never,
    );

    const result = await getCutStatus("project-1");

    expect(result).toEqual({ state: "current" });
  });

  it("returns 'current' when the final's stamp is at/after the last reorder", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue(
      readableProject({ cut_order_updated_at: "2026-08-01T00:00:00.000Z" }),
    );
    vi.mocked(createClient).mockResolvedValue(
      stubCutStatus({
        finalAsset: {
          created_at: "2026-08-02T00:00:00.000Z",
          built_from_cut_order_at: "2026-08-01T00:00:00.000Z",
        },
      }) as never,
    );

    const result = await getCutStatus("project-1");

    expect(result).toEqual({ state: "current" });
  });

  it("returns 'stale' when the cut order changed after the final's stamp", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue(
      readableProject({ cut_order_updated_at: "2026-08-03T00:00:00.000Z" }),
    );
    vi.mocked(createClient).mockResolvedValue(
      stubCutStatus({
        finalAsset: {
          created_at: "2026-08-02T00:00:00.000Z",
          built_from_cut_order_at: "2026-08-02T00:00:00.000Z",
        },
      }) as never,
    );

    const result = await getCutStatus("project-1");

    expect(result).toEqual({
      state: "stale",
      reason: "order",
      finalCreatedAt: "2026-08-02T00:00:00.000Z",
      cutOrderUpdatedAt: "2026-08-03T00:00:00.000Z",
    });
  });

  // THE case that replaced deleteStaleFinalAssets (actions/enqueue.ts). A
  // re-render moves the scene onto a NEW scene version and touches nothing
  // the order comparison above looks at, so before this the project read as
  // "current" while serving the cut built from the clip that had just been
  // superseded. The old code prevented that by DELETING the final; the honest
  // equivalent under versioning is to say so.
  it("returns 'stale' with reason 'recipe' when a scene has moved to another version since the build", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue(readableProject());
    vi.mocked(createClient).mockResolvedValue(
      stubCutStatus({
        finalAsset: {
          created_at: "2026-08-02T00:00:00.000Z",
          built_from_cut_order_at: "2026-08-02T00:00:00.000Z",
        },
        recipe: [{ scene_id: "scene-1", scene_version_id: "sv-1" }],
        scenes: [{ id: "scene-1", active_version_id: "sv-2" }],
      }) as never,
    );

    const result = await getCutStatus("project-1");

    expect(result).toEqual({
      state: "stale",
      reason: "recipe",
      finalCreatedAt: "2026-08-02T00:00:00.000Z",
      // Null on this branch: no reorder is what went wrong.
      cutOrderUpdatedAt: null,
    });
  });

  it("returns 'stale' with reason 'recipe' when a scene was added since the build", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue(readableProject());
    vi.mocked(createClient).mockResolvedValue(
      stubCutStatus({
        finalAsset: {
          created_at: "2026-08-02T00:00:00.000Z",
          built_from_cut_order_at: "2026-08-02T00:00:00.000Z",
        },
        recipe: [{ scene_id: "scene-1", scene_version_id: "sv-1" }],
        scenes: [
          { id: "scene-1", active_version_id: "sv-1" },
          { id: "scene-2", active_version_id: "sv-9" },
        ],
      }) as never,
    );

    expect(await getCutStatus("project-1")).toMatchObject({ state: "stale", reason: "recipe" });
  });

  // The race this comparison exists to close: a SECOND reorder lands WHILE
  // assembly is already running (0042_final_built_from_cut_order.sql's
  // header). The worker read the clips (and stamped built_from_cut_order_at)
  // using the FIRST reorder's timestamp — then the second reorder commits,
  // and the final finishes writing after it. The final's created_at is NEWER
  // than the second reorder, which is exactly what fooled the old
  // created_at-based comparison into reporting "current".
  it("returns 'stale' when a second reorder lands mid-assembly, even though the final's created_at is newer than that reorder", async () => {
    const firstReorderAt = "2026-08-14T10:00:00.000Z";
    const secondReorderAt = "2026-08-14T10:05:00.000Z";
    const finalCreatedAt = "2026-08-14T10:06:00.000Z";

    vi.mocked(requireProjectReadable).mockResolvedValue(
      readableProject({ cut_order_updated_at: secondReorderAt }),
    );
    vi.mocked(createClient).mockResolvedValue(
      stubCutStatus({
        finalAsset: { created_at: finalCreatedAt, built_from_cut_order_at: firstReorderAt },
      }) as never,
    );

    expect(await getCutStatus("project-1")).toEqual({
      state: "stale",
      reason: "order",
      finalCreatedAt,
      cutOrderUpdatedAt: secondReorderAt,
    });
  });

  // Pins the actual production incident (project
  // 647739b6-f3ec-4910-96ce-bd9f1114a4ce — see
  // 0043_built_from_cut_order_at_no_null_on_write.sql's header): the worker
  // stamped the clip-read time on a never-reordered project, an operator
  // reordered afterwards, and the final was written after THAT. created_at
  // is newer than the reorder; built_from_cut_order_at is older, so this
  // must read 'stale'.
  it("returns 'stale' for the exact production incident: never-reordered clip-read stamp, then a reorder, with created_at newer than the reorder", async () => {
    const clipReadStamp = "2026-08-14T09:56:40.000Z";
    const reorderAt = "2026-08-14T09:58:28.000Z";
    const finalCreatedAt = "2026-08-14T09:58:59.000Z";

    vi.mocked(requireProjectReadable).mockResolvedValue(
      readableProject({ cut_order_updated_at: reorderAt }),
    );
    vi.mocked(createClient).mockResolvedValue(
      stubCutStatus({
        finalAsset: { created_at: finalCreatedAt, built_from_cut_order_at: clipReadStamp },
      }) as never,
    );

    expect(await getCutStatus("project-1")).toEqual({
      state: "stale",
      reason: "order",
      finalCreatedAt,
      cutOrderUpdatedAt: reorderAt,
    });
  });

  // A final written before 0042_final_built_from_cut_order.sql has
  // built_from_cut_order_at === null — unknown, not stale. Reporting every
  // pre-existing final as stale on deploy day would be a false alarm across
  // every project at once.
  it("returns 'current' when the final has no stamp (predates the built_from_cut_order_at column)", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue(
      readableProject({ cut_order_updated_at: "2026-08-14T10:05:00.000Z" }),
    );
    vi.mocked(createClient).mockResolvedValue(
      stubCutStatus({
        finalAsset: { created_at: "2026-08-01T00:00:00.000Z", built_from_cut_order_at: null },
      }) as never,
    );

    expect(await getCutStatus("project-1")).toEqual({ state: "current" });
  });

  // Pins the production bug getCutStatus's doc comment explains: the Deliver
  // page admits a non-owner admin via requireProjectReadable and then calls
  // getCutStatus in the same render — with the owner-only guard, that admin
  // passed the page's check and was notFound()'d a moment later.
  it("lets a non-owner admin through (requireProjectReadable, not requireProject)", async () => {
    vi.mocked(requireProjectReadable).mockResolvedValue({
      project: {
        id: "project-1",
        cut_order_updated_at: null,
        active_final_version_id: null,
      },
      isOwner: false,
    } as never);
    const supabase = fakeClientFor({ assets: { data: [], error: null } });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    expect(await getCutStatus("project-1")).toEqual({ state: "no_final" });
    expect(requireProject).not.toHaveBeenCalled();
  });
});

// reorderCut is the assembled-cut counterpart to reorderScenes
// (actions/brief.ts) — same persistOrder write, but it deliberately skips
// assertLockedOrderPreserved (lib/editable-guard.ts) because its own
// precondition (every scene terminal) is what makes that safe. These tests
// pin: the happy path, every refusal precondition, and — the whole point —
// that a swap of two 'done' scenes succeeds here while reorderScenes still
// rejects the identical swap (lib/editable-guard.ts's
// assertLockedOrderPreserved), so nobody "unifies" the two actions later
// and silently reopens the brief-stage hole.
function fakeAdminClientForCutReorder(existing: { id: string; status: string }[]): {
  from: ReturnType<typeof vi.fn>;
  builders: { scenes: FakeQueryBuilder; projects: FakeQueryBuilder };
} {
  const builders = {
    scenes: fakeBuilder({ data: existing, error: null }),
    projects: fakeBuilder({ data: null, error: null }),
  };
  return {
    from: vi.fn((table: string) => {
      const builder = builders[table as keyof typeof builders];
      if (!builder) throw new Error(`Test did not stub table "${table}"`);
      return builder;
    }),
    builders,
  };
}

describe("reorderCut", () => {
  it("rewrites idx in the new order and stamps cut_order_updated_at when every scene is terminal", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete" },
    } as never);
    const admin = fakeAdminClientForCutReorder([
      { id: "scene-1", status: "done" },
      { id: "scene-2", status: "done" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderCut("project-1", ["scene-2", "scene-1"]);

    expect(result).toBeUndefined();
    expect(admin.builders.scenes.update).toHaveBeenCalled();
    expect(admin.builders.projects.update).toHaveBeenCalledWith(
      expect.objectContaining({ cut_order_updated_at: expect.any(String) }),
    );
  });

  it("succeeds swapping two 'done' scenes — the case reorderScenes rejects", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete" },
    } as never);
    const admin = fakeAdminClientForCutReorder([
      { id: "scene-1", status: "done" },
      { id: "scene-2", status: "done" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderCut("project-1", ["scene-2", "scene-1"]);

    expect(result).toBeUndefined();
  });

  it("the same swap is still rejected by reorderScenes (assertLockedOrderPreserved)", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete" },
    } as never);
    const admin = fakeAdminClientForCutReorder([
      { id: "scene-1", status: "done" },
      { id: "scene-2", status: "done" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderScenes("project-1", ["scene-2", "scene-1"]);

    expect(result).toEqual({ error: expect.stringMatching(/locked/i) });
  });

  it("refuses once the project has been delivered", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "delivered" },
    } as never);
    const admin = fakeAdminClientForCutReorder([]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderCut("project-1", []);

    expect(result).toEqual({ error: expect.stringMatching(/delivered/i) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("refuses when a scene is still 'draft' (not yet rendered)", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete" },
    } as never);
    const admin = fakeAdminClientForCutReorder([
      { id: "scene-1", status: "draft" },
      { id: "scene-2", status: "done" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderCut("project-1", ["scene-2", "scene-1"]);

    expect(result).toEqual({ error: expect.stringMatching(/scene-1.*"draft"/i) });
    expect(admin.builders.scenes.update).not.toHaveBeenCalled();
    expect(admin.builders.projects.update).not.toHaveBeenCalled();
  });

  it("refuses when a scene is still 'frame_ready' (not yet rendered)", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete" },
    } as never);
    const admin = fakeAdminClientForCutReorder([
      { id: "scene-1", status: "frame_ready" },
      { id: "scene-2", status: "done" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderCut("project-1", ["scene-2", "scene-1"]);

    expect(result).toEqual({ error: expect.stringMatching(/scene-1.*"frame_ready"/i) });
  });

  it("refuses when a scene is 'queued' (in flight)", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "rendering" },
    } as never);
    const admin = fakeAdminClientForCutReorder([
      { id: "scene-1", status: "queued" },
      { id: "scene-2", status: "done" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderCut("project-1", ["scene-2", "scene-1"]);

    expect(result).toEqual({ error: expect.stringMatching(/scene-1.*"queued"/i) });
    expect(admin.builders.scenes.update).not.toHaveBeenCalled();
  });

  it("refuses when a scene is 'rendering' (in flight)", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "rendering" },
    } as never);
    const admin = fakeAdminClientForCutReorder([
      { id: "scene-1", status: "rendering" },
      { id: "scene-2", status: "done" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderCut("project-1", ["scene-2", "scene-1"]);

    expect(result).toEqual({ error: expect.stringMatching(/scene-1.*"rendering"/i) });
  });

  it("refuses when orderedIds is not the project's complete scene set", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete" },
    } as never);
    const admin = fakeAdminClientForCutReorder([
      { id: "scene-1", status: "done" },
      { id: "scene-2", status: "failed" },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    // Missing the failed scene-2, which has no clip in the grid but still
    // occupies a slot in the assembled cut.
    const result = await reorderCut("project-1", ["scene-1"]);

    expect(result).toEqual({ error: expect.stringMatching(/complete scene set/i) });
    expect(admin.builders.scenes.update).not.toHaveBeenCalled();
    expect(admin.builders.projects.update).not.toHaveBeenCalled();
  });
});

// A disabled button is a convenience, never a boundary — a Server Action can
// be POSTed directly, past whatever the browser would have refused. This one
// writes the commitment point every project-level lock in the codebase
// reads, so a project frozen with clips missing locks the operator out of
// the very edits that would fix it. The component's own doc used to admit
// the check was "NOT implemented".
describe("markDelivered — the completeness check the button only pretended to make", () => {
  it("refuses while any scene has not rendered, and writes nothing", async () => {
    vi.mocked(requireProject).mockResolvedValue({ project: { id: "project-1" } } as never);
    const supabase = fakeClientFor({
      scenes: { data: [{ status: "done" }, { status: "failed" }, { status: "done" }], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(supabase as never);
    const admin = { from: vi.fn() };
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await markDelivered("project-1");

    expect(result).toEqual({ error: expect.stringMatching(/1 of 3 scenes/i) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("refuses a project with no scenes at all", async () => {
    vi.mocked(requireProject).mockResolvedValue({ project: { id: "project-1" } } as never);
    vi.mocked(createClient).mockResolvedValue(
      fakeClientFor({ scenes: { data: [], error: null } }) as never,
    );
    const admin = { from: vi.fn() };
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await markDelivered("project-1");

    expect(result).toEqual({ error: expect.stringMatching(/nothing to deliver/i) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("writes 'delivered' once every scene is done", async () => {
    vi.mocked(requireProject).mockResolvedValue({ project: { id: "project-1" } } as never);
    vi.mocked(createClient).mockResolvedValue(
      fakeClientFor({ scenes: { data: [{ status: "done" }], error: null } }) as never,
    );
    const builder = {
      update: vi.fn(() => builder),
      eq: vi.fn(() => Promise.resolve({ error: null })),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const result = await markDelivered("project-1");

    expect(result).toBeUndefined();
    expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({ status: "delivered" }));
  });
});
