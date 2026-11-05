import { afterEach, describe, expect, it, vi } from "vitest";
import {
  updateRenderSettings,
  updateSceneRenderOverride,
  clearSceneRenderOverride,
} from "./render-settings";
import { requireProject, requireScene } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import * as models from "@/lib/models";
import { SEEDANCE_2_5, KLING_3_PRO } from "@/lib/models";

// projects.render_settings is what the Render gate (and every render path in
// actions/enqueue.ts) prices against — see this file's own header comment.
// The column has no CHECK constraint by design, so this action's Zod
// validation is the ONLY thing standing between an operator's click and an
// untyped blob the worker hands straight to fal. These tests are about that
// validation, the in-flight concurrency lock, and the merge-not-replace
// write — not about re-testing RenderSettingsSchema's own field rules
// (lib/models.test.ts already covers those, if present).
vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
  requireScene: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
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
  eq: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    update: vi.fn(() => builder),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

/** Throws on any table the test didn't stub — an unexpected write must fail loudly, not silently succeed. */
function fakeClient(stubs: Record<string, FakeQueryBuilder>): { from: ReturnType<typeof vi.fn> } {
  return {
    from: vi.fn((table: string) => {
      const builder = stubs[table];
      if (!builder) throw new Error(`Test did not stub table "${table}"`);
      return builder;
    }),
  };
}

afterEach(() => {
  vi.mocked(requireProject).mockReset();
  vi.mocked(requireScene).mockReset();
  vi.mocked(createClient).mockReset();
  vi.mocked(createAdminClient).mockReset();
});

describe("updateRenderSettings", () => {
  it("refuses an unauthorized caller before reading scenes or writing anything", async () => {
    vi.mocked(requireProject).mockRejectedValue(new Error("not authorized"));

    await expect(
      updateRenderSettings("project-1", { model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }),
    ).rejects.toThrow("not authorized");

    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("rejects an unknown model instead of persisting it", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", render_settings: {} },
    } as never);
    const scenesBuilder = fakeBuilder({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ scenes: scenesBuilder }) as never);
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateRenderSettings("project-1", {
      model: "not-a-real-model",
      resolution: "1080p",
      fps: 24,
    });

    expect(result).toEqual({ error: expect.stringMatching(/Unknown model/) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("refuses to change settings while a scene is queued or rendering, without writing anything", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", render_settings: {} },
    } as never);
    const scenesBuilder = fakeBuilder({
      data: [{ status: "queued", duration_s: 8 }],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ scenes: scenesBuilder }) as never);
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateRenderSettings("project-1", {
      model: SEEDANCE_2_5.id,
      resolution: "720p",
      fps: 24,
    });

    expect(result).toEqual({ error: expect.stringMatching(/queued or rendering/) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("merges the new settings onto the column's existing raw contents instead of replacing it", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: {
        id: "project-1",
        // compileModel is a sibling key this schema knows nothing about —
        // see this action's own header comment on why it must survive.
        render_settings: {
          model: "old-model",
          resolution: "1080p",
          fps: 24,
          compileModel: "claude-haiku-4-5",
        },
      },
    } as never);
    const scenesBuilder = fakeBuilder({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ scenes: scenesBuilder }) as never);
    const projectsBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ projects: projectsBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    // "720p", kie's own spelling for this model's tier (not the "720p" the
    // stale stored row above carries) — writing it here would be refused by
    // the schema and this test would pass on a rejection rather than on the
    // merge it is about. The stored 1080p above is left alone deliberately
    // — it is what rows in the database still carry, and the point is that
    // the merge replaces it while `compileModel` survives.
    const result = await updateRenderSettings("project-1", {
      model: SEEDANCE_2_5.id,
      resolution: "720p",
      fps: 24,
    });

    expect(result).toBeUndefined();
    expect(projectsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        render_settings: {
          compileModel: "claude-haiku-4-5",
          model: SEEDANCE_2_5.id,
          resolution: "720p",
          fps: 24,
        },
      }),
    );
  });
});

// The per-scene sibling of updateRenderSettings above — writes
// scenes.render_settings_override instead of projects.render_settings, one
// scene at a time. requireScene is mocked directly (not createClient's
// "scenes" table) since the action reads the scene entirely through
// requireScene, never a second query of its own.
function baseScene(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "scene-1",
    project_id: "project-1",
    status: "frame_ready",
    duration_s: 8,
    render_settings_override: null,
    ...overrides,
  };
}

describe("updateSceneRenderOverride", () => {
  it("refuses while the scene is queued or rendering, without writing anything", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: baseScene({ status: "queued" }),
    } as never);

    const result = await updateSceneRenderOverride("scene-1", {
      model: SEEDANCE_2_5.id,
      resolution: "720p",
      fps: 24,
    });

    expect(result).toEqual({ error: expect.stringMatching(/locked/) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("rejects an unknown model instead of persisting it", async () => {
    vi.mocked(requireScene).mockResolvedValue({ scene: baseScene() } as never);

    const result = await updateSceneRenderOverride("scene-1", {
      model: "not-a-real-model",
      resolution: "1080p",
      fps: 24,
    });

    expect(result).toEqual({ error: expect.stringMatching(/Unknown model/) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("merges the new settings onto the scene's existing raw override instead of replacing it", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: baseScene({
        // `foo` is a key this schema knows nothing about — see
        // updateSceneRenderOverride's own doc comment on why it must
        // survive a write (the column is partial by design, and a retry
        // may already have written something here).
        render_settings_override: { foo: "bar", model: "old-model" },
      }),
    } as never);
    const scenesBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ scenes: scenesBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateSceneRenderOverride("scene-1", {
      model: KLING_3_PRO.id,
      resolution: "1080p",
      fps: 24,
    });

    expect(result).toBeUndefined();
    expect(scenesBuilder.update).toHaveBeenCalledWith({
      render_settings_override: {
        foo: "bar",
        model: KLING_3_PRO.id,
        resolution: "1080p",
        fps: 24,
      },
    });
  });

  it("validates against THIS scene's own duration, not some other value", async () => {
    // 11s is not a special number — it only matters that it's this SCENE's
    // own duration_s and nothing else. renderSettingsSchemaFor's fps/
    // duration cross-field rule (maxDurationSByFps) has no model to exercise
    // a real pass/reject through today — every current descriptor's
    // maxDurationSByFps is empty (see lib/models.test.ts's own note on
    // this) — so this pins the wiring directly: the schema factory must be
    // built from scene.duration_s, not the project's longest scene or any
    // other value, the same way updateRenderSettings builds it from every
    // scene in the project.
    vi.mocked(requireScene).mockResolvedValue({
      scene: baseScene({ duration_s: 11 }),
    } as never);
    const scenesBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ scenes: scenesBuilder }) as never);
    const spy = vi.spyOn(models, "renderSettingsSchemaFor");

    await updateSceneRenderOverride("scene-1", {
      model: SEEDANCE_2_5.id,
      resolution: "720p",
      fps: 24,
    });

    expect(spy).toHaveBeenCalledWith(11);
    spy.mockRestore();
  });
});

describe("clearSceneRenderOverride", () => {
  it("clears the override back to the project default", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: baseScene({ render_settings_override: { model: KLING_3_PRO.id } }),
    } as never);
    const scenesBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ scenes: scenesBuilder }) as never);

    const result = await clearSceneRenderOverride("scene-1");

    expect(result).toBeUndefined();
    expect(scenesBuilder.update).toHaveBeenCalledWith({ render_settings_override: null });
  });

  it("refuses while the scene is queued or rendering, without writing anything", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: baseScene({
        status: "rendering",
        render_settings_override: { model: KLING_3_PRO.id },
      }),
    } as never);

    const result = await clearSceneRenderOverride("scene-1");

    expect(result).toEqual({ error: expect.stringMatching(/locked/) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

// The hazard RenderSettingsOverrideSchema's doc comment used to guard by
// refusing resolution outright: a per-scene column holding a resolution the
// merged model does not support. The override carries resolution now, so the
// guarantee has to come from the write instead — this is that guarantee.
describe("updateSceneRenderOverride — model and resolution must agree", () => {
  it("refuses a resolution the chosen model does not offer, and writes nothing", async () => {
    vi.mocked(requireScene).mockResolvedValue({ scene: baseScene() } as never);
    const admin = { from: vi.fn() };
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    // Kling offers 720p and 1080p (see KLING_3_PRO.allowedResolutions) —
    // 480p is a Seedance tier, not one of Kling's.
    const result = await updateSceneRenderOverride("scene-1", {
      model: KLING_3_PRO.id,
      resolution: "480p",
      fps: 24,
    });

    expect(result).toHaveProperty("error");
    expect(String((result as { error: string }).error)).toMatch(/480p/);
    // Not merely "returned an error" — nothing reached the database.
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("accepts pro/1080p, the pair the model does offer", async () => {
    vi.mocked(requireScene).mockResolvedValue({ scene: baseScene() } as never);
    const builder = {
      update: vi.fn(() => builder),
      eq: vi.fn(() => Promise.resolve({ error: null })),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const result = await updateSceneRenderOverride("scene-1", {
      model: KLING_3_PRO.id,
      resolution: "1080p",
      fps: 24,
    });

    expect(result).toBeUndefined();
    expect(builder.update).toHaveBeenCalled();
  });

  it("accepts std/720p too, since 2026-09-10 — the tier /ugc actually offers Kling at", async () => {
    vi.mocked(requireScene).mockResolvedValue({ scene: baseScene() } as never);
    const builder = {
      update: vi.fn(() => builder),
      eq: vi.fn(() => Promise.resolve({ error: null })),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const result = await updateSceneRenderOverride("scene-1", {
      model: KLING_3_PRO.id,
      resolution: "720p",
      fps: 24,
    });

    expect(result).toBeUndefined();
    expect(builder.update).toHaveBeenCalled();
  });
});
