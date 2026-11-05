import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFrames, updateScenePromptAndRegenerate, setActiveSceneVersion } from "./frames";
import { requireProject, requireScene } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { assertWithinSpendCaps } from "@/lib/spend";
import { generateImage, modelForImageArgs } from "@/lib/kie";
import { REF_FRAME_COST_USD } from "@/lib/models";

// This file exists because Gate 2 (docs/architecture.md's "REVIEW FRAMES —
// GATE — $0.02 each") is real money with no cap in front of it before
// assertWithinSpendCaps was added — see this file's own header comment on
// generateFrames. The tests below are deliberately about ONE thing each: the
// authorization guard and the spend cap must both run, in order, BEFORE any
// vendor call, and the cap check must be given the right dollar figure. They
// assert on mock CALLS (arguments, call counts), never on a mock's own
// echoed-back return value — see enqueue.test.ts's per-scene-override tests,
// which this follows.
vi.mock("@/actions/guard", () => ({
  requireScene: vi.fn(),
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/spend", () => ({
  assertWithinSpendCaps: vi.fn(),
}));

vi.mock("@/lib/kie", () => ({
  generateImage: vi.fn(),
  modelForImageArgs: vi.fn(() => "google/nano-banana"),
  ImageGenerationError: class ImageGenerationError extends Error {},
  KieTaskPendingError: class KieTaskPendingError extends Error {},
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
  in: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

function fakeBuilder(result: FakeQueryResult = { data: null, error: null }): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    is: vi.fn(() => builder),
    order: vi.fn(() => builder),
    update: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

/** Throws on any table the test didn't stub — a wrongly-reached DB call must fail loudly, not silently return undefined. */
function fakeAdminClient(stubs: Record<string, FakeQueryBuilder> = {}): {
  from: ReturnType<typeof vi.fn>;
} {
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
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(assertWithinSpendCaps).mockReset();
  vi.mocked(generateImage).mockReset();
  vi.mocked(modelForImageArgs).mockReset().mockReturnValue("google/nano-banana");
});

describe("generateFrames", () => {
  it("refuses an unauthorized caller before touching the admin client, the spend cap, or kie", async () => {
    vi.mocked(requireProject).mockRejectedValue(new Error("not authorized"));

    await expect(generateFrames("project-1")).rejects.toThrow("not authorized");

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("prices the cap check at the whole batch, and a cap refusal stops every frame before kie is ever called", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const scenesBuilder = fakeBuilder({
      data: [
        { id: "scene-1", status: "draft", video_prompt: "a", is_talking_head: false },
        { id: "scene-2", status: "frame_ready", video_prompt: "b", is_talking_head: false },
      ],
      error: null,
    });
    const admin = fakeAdminClient({ scenes: scenesBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue({ error: "Over cap." });

    const result = await generateFrames("project-1");

    // THE arguments, not just that the mock was called: two editable scenes
    // at REF_FRAME_COST_USD each, priced as one batch total.
    expect(assertWithinSpendCaps).toHaveBeenCalledWith(
      "user-1",
      { role: "editor" },
      2 * REF_FRAME_COST_USD,
    );
    expect(result).toEqual({
      succeeded: [],
      failed: [
        { sceneId: "scene-1", error: "Over cap." },
        { sceneId: "scene-2", error: "Over cap." },
      ],
    });
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("updateScenePromptAndRegenerate", () => {
  const editableScene = {
    id: "scene-1",
    project_id: "project-1",
    status: "draft" as const,
    video_prompt: "old prompt",
  };

  it("refuses an unauthorized caller before touching the admin client, the spend cap, or kie", async () => {
    vi.mocked(requireScene).mockRejectedValue(new Error("not authorized"));

    await expect(updateScenePromptAndRegenerate("scene-1", "new prompt")).rejects.toThrow(
      "not authorized",
    );

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("refuses a scene that has moved past frame_ready before checking the spend cap at all", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { ...editableScene, status: "rendering" },
      project: { id: "project-1" },
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const result = await updateScenePromptAndRegenerate("scene-1", "new prompt");

    expect(result).toEqual({
      error: expect.stringMatching(/is "rendering".*worker owns this scene/i),
    });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("prices the cap check at one frame, and a cap refusal saves nothing and never calls kie", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: editableScene,
      project: { id: "project-1" },
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue({ error: "Over cap." });

    const result = await updateScenePromptAndRegenerate("scene-1", "  new prompt  ");

    // THE argument: a single frame, not the batch figure generateFrames uses.
    expect(assertWithinSpendCaps).toHaveBeenCalledWith(
      "user-1",
      { role: "editor" },
      REF_FRAME_COST_USD,
    );
    expect(result).toEqual({ error: "Over cap." });
    // Refused before the new prompt was ever written, and before kie was hit.
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("setActiveSceneVersion", () => {
  const baseScene = {
    id: "scene-1",
    project_id: "project-1",
    status: "draft" as const,
  };

  const version = {
    id: "version-2",
    video_prompt: "an earlier prompt",
    ref_frame_asset_id: "ref-asset-2",
  };

  it("refuses an unauthorized caller before touching the admin client", async () => {
    vi.mocked(requireScene).mockRejectedValue(new Error("not authorized"));

    await expect(setActiveSceneVersion("scene-1", "version-2")).rejects.toThrow("not authorized");

    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // THE bug this test exists to pin: this file used to keep its own private
  // ["draft", "frame_ready"] editable list rather than reading
  // isSceneContentEditable (lib/editable-guard.ts), so switching versions on
  // a finished scene — the whole point of the picker, since a scene worth
  // comparing versions on has usually already rendered — was refused with a
  // "money is committed" message on the one screen that offers the button.
  it("is ALLOWED on a 'done' scene — that is the case the version picker exists for", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: { ...baseScene, status: "done" },
      project: { id: "project-1" },
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    const versionsBuilder = fakeBuilder({ data: version, error: null });
    const scenesBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeAdminClient({ scene_versions: versionsBuilder, scenes: scenesBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await setActiveSceneVersion("scene-1", "version-2");

    expect(result).toBeUndefined();
    // Both fields the compiler and worker actually read are carried back
    // onto the scene, along with the pointer — see this function's doc
    // comment: active_version_id alone would change only the label.
    expect(scenesBuilder.update).toHaveBeenCalledWith({
      active_version_id: "version-2",
      video_prompt: "an earlier prompt",
      ref_frame_asset_id: "ref-asset-2",
    });
  });

  it.each(["queued", "rendering"] as const)(
    "refuses while the scene is '%s' — the worker owns the row",
    async (status) => {
      vi.mocked(requireScene).mockResolvedValue({
        scene: { ...baseScene, status },
        project: { id: "project-1" },
        user: { id: "user-1" },
        profile: { role: "editor" },
      } as never);

      const result = await setActiveSceneVersion("scene-1", "version-2");

      expect(result).toEqual({
        error: expect.stringMatching(new RegExp(`is "${status}".*worker owns this scene`, "i")),
      });
      expect(createAdminClient).not.toHaveBeenCalled();
    },
  );

  it("refuses a version that does not belong to this scene, without writing anything", async () => {
    vi.mocked(requireScene).mockResolvedValue({
      scene: baseScene,
      project: { id: "project-1" },
      user: { id: "user-1" },
      profile: { role: "editor" },
    } as never);

    // .eq("scene_id", sceneId) filtered it out server-side — maybeSingle
    // comes back empty, same as a foreign version id.
    const versionsBuilder = fakeBuilder({ data: null, error: null });
    const scenesBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeAdminClient({ scene_versions: versionsBuilder, scenes: scenesBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await setActiveSceneVersion("scene-1", "someone-elses-version");

    expect(result).toEqual({ error: expect.stringMatching(/does not belong to this scene/) });
    expect(scenesBuilder.update).not.toHaveBeenCalled();
  });
});
