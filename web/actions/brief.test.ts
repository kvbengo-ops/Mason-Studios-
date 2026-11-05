import { afterEach, describe, expect, it, vi } from "vitest";
import { updateScenePrompt, reorderScenes, applyScenePrompt, splitScene } from "./brief";
import { requireScene, requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { compileScene } from "@/lib/claude";
import { assertWithinSpendCaps } from "@/lib/spend";
import { recordRun, recordedCall } from "@/lib/runs";
import { loadLatestTemplate } from "@/actions/compile";
import { CLAUDE_HAIKU_4_5, CLAUDE_SONNET_5, applySceneCostUsd } from "@/lib/models";

// Two things this file pins:
//
// 1. Concurrency safety is unchanged by the delivered-based commitment gate
//    added elsewhere in this pass: a scene the worker currently owns
//    ('queued'/'rendering') must still refuse a direct text edit, full
//    stop — no warning-and-allow, unlike the project-level fields in
//    actions/character.ts. assertEditable (actions/brief.ts, private) is
//    exercised here through updateScenePrompt, its Server Action boundary.
// 2. unfreezeScene — the existing per-scene "reopen a done scene for
//    correction" control — now also clears a stale `projects.status =
//    'delivered'` the moment it deletes that scene's clip and the
//    project's final asset, instead of leaving 'delivered' pointing at
//    assets that no longer exist (see that function's doc comment).
vi.mock("@/actions/guard", () => ({
  requireScene: vi.fn(),
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/actions/enqueue", () => ({}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/claude", () => ({
  compileScene: vi.fn(),
  CLAUDE_VENDOR: "anthropic",
}));

vi.mock("@/lib/spend", () => ({
  assertWithinSpendCaps: vi.fn(),
}));

vi.mock("@/lib/runs", () => ({
  recordRun: vi.fn(),
  // Real forwarding behaviour (run fn, record success/failure) rather than a
  // bare vi.fn() — Apply/Split's own control flow (the write below) depends
  // on the compileScene result recordedCall resolves to, and the point of
  // these tests is to assert what cost/model recordedCall was actually
  // CALLED with, not to replace its behaviour.
  recordedCall: vi.fn(async (meta: unknown, costUsd: number, fn: () => Promise<unknown>) => {
    return fn();
  }),
}));

vi.mock("@/actions/compile", () => ({
  loadLatestTemplate: vi.fn(),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

function fakeBuilder(result: FakeQueryResult = { data: null, error: null }): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    in: vi.fn(() => builder),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeAdminClient(): {
  from: ReturnType<typeof vi.fn>;
  builders: { scenes: FakeQueryBuilder; assets: FakeQueryBuilder; projects: FakeQueryBuilder };
} {
  const builders = {
    scenes: fakeBuilder(),
    assets: fakeBuilder(),
    projects: fakeBuilder(),
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

/**
 * splitScene's `scenes` table traffic is shaped differently from every
 * other action in this file: a select().eq().order() read (orderedSceneIds),
 * a plain update().eq() write (rewriting the first half in place), and an
 * insert().select().single() write (the second half) — the last of which
 * fakeBuilder above has no method for at all. order() and single() each
 * short-circuit with their own real Promise (mirroring how a real
 * PostgrestFilterBuilder resolves at the end of a chain); every other call
 * just returns the shared builder for chaining, and a bare await on it
 * (e.g. the first half's `update(...).eq(...)`) resolves via `.then` to a
 * plain no-error result.
 */
function fakeSplitAdminClient(
  existing: { id: string; status: string }[],
  insertedRow: { id: string },
): { from: ReturnType<typeof vi.fn>; scenes: Record<string, ReturnType<typeof vi.fn>> } {
  const scenes: Record<string, unknown> = {};
  scenes.select = vi.fn(() => scenes);
  scenes.eq = vi.fn(() => scenes);
  scenes.order = vi.fn(() => Promise.resolve({ data: existing, error: null }));
  scenes.update = vi.fn(() => scenes);
  scenes.insert = vi.fn(() => scenes);
  scenes.single = vi.fn(() => Promise.resolve({ data: insertedRow, error: null }));
  scenes.then = (
    onFulfilled: (r: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ): Promise<unknown> => Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);

  return {
    from: vi.fn((table: string) => {
      if (table !== "scenes") throw new Error(`Test did not stub table "${table}"`);
      return scenes;
    }),
    scenes: scenes as Record<string, ReturnType<typeof vi.fn>>,
  };
}

afterEach(() => {
  vi.mocked(requireScene).mockReset();
  vi.mocked(requireProject).mockReset();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(compileScene).mockReset();
  vi.mocked(assertWithinSpendCaps).mockReset();
  vi.mocked(recordRun).mockReset();
  vi.mocked(recordedCall).mockReset();
  vi.mocked(loadLatestTemplate).mockReset();
});

// Minimal-but-complete project row shared by applyScenePrompt/splitScene
// tests below — every field projectDirectionFrom/allowedDurationsFor/
// parseCompilerModel actually reads, nothing more. `render_settings` is the
// one field each test below overrides to select a compiler model.
function fakeProject(renderSettings: unknown = {}): Record<string, unknown> {
  return {
    id: "project-1",
    character_desc: null,
    product_name: null,
    product_appearance: "Matte green stand-up pouch.",
    shooting_mode: "static",
    camera_movement: false,
    visual_idea: null,
    voice_profile: null,
    pronunciation_guide: null,
    ugc_style: "testimonial",
    include_visual_idea: false,
    render_settings: renderSettings,
  };
}

const fakeSceneBrief = {
  video_prompt: "a generated prompt",
  is_talking_head: false,
  duration_s: 8,
};

// reorderScenes issues an initial select+order against `scenes` (existing
// order) followed by many update() calls against `scenes` (persistOrder's
// two-phase repack) and finally one update() against `projects` (the
// cut_order_updated_at stamp). All the `scenes` calls share one builder, so
// its fixed `existing` result also has to satisfy every update() call —
// harmless, since an update only checks `.error`, never `.data`.
function fakeAdminClientForReorder(existing: { id: string; status: string; idx: number }[]): {
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

describe("updateScenePrompt", () => {
  it("refuses a 'queued' (in-flight) scene — the worker owns its row now", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { id: "scene-1", status: "queued" },
      project: { id: "project-1" },
    } as never);
    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateScenePrompt("scene-1", "a new prompt");

    expect(result).toEqual({
      error: expect.stringMatching(/is "queued".*worker owns this scene/i),
    });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("refuses a 'rendering' (in-flight) scene the same way", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { id: "scene-1", status: "rendering" },
      project: { id: "project-1" },
    } as never);
    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateScenePrompt("scene-1", "a new prompt");

    expect(result).toEqual({
      error: expect.stringMatching(/is "rendering".*worker owns this scene/i),
    });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("allows a 'frame_ready' scene", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { id: "scene-1", status: "frame_ready" },
      project: { id: "project-1" },
    } as never);
    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateScenePrompt("scene-1", "a new prompt");

    expect(result).toBeUndefined();
    expect(admin.builders.scenes.update).toHaveBeenCalledWith(
      expect.objectContaining({ video_prompt: "a new prompt" }),
    );
  });
});

describe("reorderScenes", () => {
  it("stamps projects.cut_order_updated_at on a successful reorder", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "complete" },
    } as never);
    const existing = [
      { id: "scene-1", status: "draft", idx: 0 },
      { id: "scene-2", status: "draft", idx: 1 },
    ];
    const admin = fakeAdminClientForReorder(existing);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderScenes("project-1", ["scene-2", "scene-1"]);

    expect(result).toBeUndefined();
    expect(admin.builders.projects.update).toHaveBeenCalledWith(
      expect.objectContaining({ cut_order_updated_at: expect.any(String) }),
    );
  });

  it("refuses once the project has been delivered", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "delivered" },
    } as never);
    const admin = fakeAdminClientForReorder([
      { id: "scene-1", status: "draft", idx: 0 },
      { id: "scene-2", status: "draft", idx: 1 },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderScenes("project-1", ["scene-2", "scene-1"]);

    expect(result).toEqual({ error: expect.stringMatching(/delivered/i) });
    // Refused before ever touching `scenes` or `projects`.
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("refuses while a scene is in flight ('queued'/'rendering')", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", status: "rendering" },
    } as never);
    const admin = fakeAdminClientForReorder([
      { id: "scene-1", status: "queued", idx: 0 },
      { id: "scene-2", status: "draft", idx: 1 },
    ]);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await reorderScenes("project-1", ["scene-2", "scene-1"]);

    expect(result).toEqual({ error: expect.stringMatching(/queued or.*rendering/i) });
    // Fetching the existing order is fine (needed to detect in-flight
    // scenes); the point is that nothing gets WRITTEN — no idx repack, no
    // cut_order_updated_at stamp.
    expect(admin.builders.scenes.update).not.toHaveBeenCalled();
    expect(admin.builders.projects.update).not.toHaveBeenCalled();
  });
});

// Regression coverage for the defect where Apply/Split ignored the
// project's own compiler-model choice (COMPILER_MODELS, lib/models.ts —
// see compile.ts's parseCompilerModel(project.render_settings) for the
// resolution both call sites below now mirror), always compiled on
// defaultClaudeModel() (the CLAUDE_MODEL env default), and priced/recorded
// every call at the flat APPLY_SCENE_COST_USD regardless of which model
// actually ran.
describe("applyScenePrompt", () => {
  it("passes the project's chosen compiler model to compileScene, and cap-checks/records it at the Sonnet-derived rate", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      user: { id: "user-1", email: "a@b.com" },
      profile: { role: "member" },
      scene: {
        id: "scene-1",
        status: "frame_ready",
        script_line: "Hello there.",
        visual_idea: null,
      },
      project: fakeProject({ compileModel: CLAUDE_SONNET_5.id }),
    } as never);
    vi.mocked(loadLatestTemplate).mockResolvedValue({ id: "t1", body: "system prompt" });
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(compileScene).mockResolvedValue(fakeSceneBrief as never);
    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await applyScenePrompt("scene-1");

    expect(result).toBeUndefined();
    const expectedCost = applySceneCostUsd(CLAUDE_SONNET_5);
    expect(expectedCost).toBeCloseTo(0.03, 5);

    expect(assertWithinSpendCaps).toHaveBeenCalledWith("user-1", { role: "member" }, expectedCost);
    expect(compileScene).toHaveBeenCalledWith(
      expect.objectContaining({ model: CLAUDE_SONNET_5.id }),
    );
    // Same call site product_name already flows through — a missing
    // productAppearance here would silently vanish on every Apply after
    // the initial compile, the exact defect this field's write-up warns
    // about for the compiler-model choice (commit ba2b886).
    expect(compileScene).toHaveBeenCalledWith(
      expect.objectContaining({ productAppearance: "Matte green stand-up pouch." }),
    );
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ model: CLAUDE_SONNET_5.id, costUsd: expectedCost }),
    );
  });

  it("pins today's behaviour for a project that has never chosen a compiler model — Haiku, $0.01", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      user: { id: "user-1", email: "a@b.com" },
      profile: { role: "member" },
      scene: {
        id: "scene-1",
        status: "frame_ready",
        script_line: "Hello there.",
        visual_idea: null,
      },
      project: fakeProject({}),
    } as never);
    vi.mocked(loadLatestTemplate).mockResolvedValue({ id: "t1", body: "system prompt" });
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(compileScene).mockResolvedValue(fakeSceneBrief as never);
    const admin = fakeAdminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await applyScenePrompt("scene-1");

    expect(result).toBeUndefined();
    expect(assertWithinSpendCaps).toHaveBeenCalledWith("user-1", { role: "member" }, 0.01);
    expect(compileScene).toHaveBeenCalledWith(
      expect.objectContaining({ model: CLAUDE_HAIKU_4_5.id }),
    );
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ model: CLAUDE_HAIKU_4_5.id, costUsd: 0.01 }),
    );
  });
});

describe("splitScene", () => {
  it("passes the project's chosen compiler model to both compileScene calls, cap-checks at 2x the Sonnet-derived rate, and records it on the runs row", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      user: { id: "user-1", email: "a@b.com" },
      profile: { role: "member" },
      scene: {
        id: "scene-1",
        idx: 0,
        status: "frame_ready",
        script_line: "First sentence here. Second sentence here.",
        visual_idea: null,
        is_talking_head: false,
      },
      project: fakeProject({ compileModel: CLAUDE_SONNET_5.id }),
    } as never);
    vi.mocked(loadLatestTemplate).mockResolvedValue({ id: "t1", body: "system prompt" });
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(compileScene).mockResolvedValue(fakeSceneBrief as never);
    const admin = fakeSplitAdminClient([{ id: "scene-1", status: "frame_ready" }], {
      id: "scene-2",
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await splitScene("scene-1");

    expect(result).toBeUndefined();
    const expectedCost = applySceneCostUsd(CLAUDE_SONNET_5);
    expect(assertWithinSpendCaps).toHaveBeenCalledWith(
      "user-1",
      { role: "member" },
      2 * expectedCost,
    );
    expect(compileScene).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: CLAUDE_SONNET_5.id, scriptLine: "First sentence here." }),
    );
    expect(compileScene).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: CLAUDE_SONNET_5.id, scriptLine: "Second sentence here." }),
    );
    // Both halves must carry it — same reasoning as applyScenePrompt's own
    // productAppearance assertion above.
    expect(compileScene).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ productAppearance: "Matte green stand-up pouch." }),
    );
    expect(compileScene).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ productAppearance: "Matte green stand-up pouch." }),
    );
    expect(recordedCall).toHaveBeenCalledWith(
      expect.objectContaining({ model: CLAUDE_SONNET_5.id }),
      expectedCost,
      expect.any(Function),
    );
  });

  it("pins today's behaviour for a project that has never chosen a compiler model — Haiku, cap-checked at 2x $0.01", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      user: { id: "user-1", email: "a@b.com" },
      profile: { role: "member" },
      scene: {
        id: "scene-1",
        idx: 0,
        status: "frame_ready",
        script_line: "First sentence here. Second sentence here.",
        visual_idea: null,
        is_talking_head: false,
      },
      project: fakeProject({}),
    } as never);
    vi.mocked(loadLatestTemplate).mockResolvedValue({ id: "t1", body: "system prompt" });
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(compileScene).mockResolvedValue(fakeSceneBrief as never);
    const admin = fakeSplitAdminClient([{ id: "scene-1", status: "frame_ready" }], {
      id: "scene-2",
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await splitScene("scene-1");

    expect(result).toBeUndefined();
    expect(assertWithinSpendCaps).toHaveBeenCalledWith("user-1", { role: "member" }, 0.02);
    expect(compileScene).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: CLAUDE_HAIKU_4_5.id }),
    );
    expect(recordedCall).toHaveBeenCalledWith(
      expect.objectContaining({ model: CLAUDE_HAIKU_4_5.id }),
      0.01,
      expect.any(Function),
    );
  });
});
