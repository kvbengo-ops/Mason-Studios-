import { afterEach, describe, expect, it, vi } from "vitest";
import { updateCompileModel } from "./compiler-model";
import { requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { CLAUDE_SONNET_5, GPT_5 } from "@/lib/models";

// projects.render_settings.compileModel has no CHECK constraint (see this
// file's own header comment) — CompilerModelIdSchema is the only thing
// standing between it and an arbitrary string. These tests are about that
// validation and the merge-not-replace write; they deliberately do NOT
// assert any draft/frame_ready lock, since the header explains there
// isn't one here on purpose (compile.ts's assertRecompilable is the actual
// gate, one step downstream).
vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
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
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
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
  vi.mocked(createAdminClient).mockReset();
});

describe("updateCompileModel", () => {
  it("refuses an unauthorized caller before writing anything", async () => {
    vi.mocked(requireProject).mockRejectedValue(new Error("not authorized"));

    await expect(updateCompileModel("project-1", CLAUDE_SONNET_5.id)).rejects.toThrow(
      "not authorized",
    );

    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("rejects an unknown model instead of persisting it", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", render_settings: {} },
    } as never);
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateCompileModel("project-1", "not-a-real-model");

    expect(result).toEqual({ error: expect.stringMatching(/Unknown compiler model/) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("rejects a disabled model instead of persisting it", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", render_settings: {} },
    } as never);
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateCompileModel("project-1", GPT_5.id);

    expect(result).toEqual({ error: expect.stringMatching(/cannot be selected/) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("persists a valid model", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { id: "project-1", render_settings: {} },
    } as never);
    const projectsBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ projects: projectsBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateCompileModel("project-1", CLAUDE_SONNET_5.id);

    expect(result).toBeUndefined();
    expect(projectsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        render_settings: { compileModel: CLAUDE_SONNET_5.id },
      }),
    );
  });

  it("merges the compiler-model write onto the column's existing video settings instead of replacing it", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: {
        id: "project-1",
        // model/resolution/fps are the video RenderSettings fields this
        // schema knows nothing about — see this action's own header
        // comment on why they must survive a compiler-model write.
        render_settings: {
          model: "ltx-2.3-fast",
          resolution: "1080p",
          fps: 24,
        },
      },
    } as never);
    const projectsBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ projects: projectsBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateCompileModel("project-1", CLAUDE_SONNET_5.id);

    expect(result).toBeUndefined();
    expect(projectsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        render_settings: {
          model: "ltx-2.3-fast",
          resolution: "1080p",
          fps: 24,
          compileModel: CLAUDE_SONNET_5.id,
        },
      }),
    );
  });
});
