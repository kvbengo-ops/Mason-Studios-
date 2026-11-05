import { afterEach, describe, expect, it, vi } from "vitest";
import { updateProject, renameProject, duplicateProject } from "./project";
import { requireUser, requireProject } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/types/db";

// actions/project.ts sits behind two boundaries this file replaces with
// fakes rather than exercising for real: the ownership guards
// (actions/guard.ts, which has no test file of its own — these tests are
// about project.ts's own logic, not guard.ts's) and the Supabase client
// factories. Next's redirect()/revalidatePath() are also mocked, since
// outside a real request they have nothing to redirect or revalidate.
vi.mock("@/actions/guard", () => ({
  requireUser: vi.fn(),
  requireProject: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    // Mirrors Next's own redirect(): control flow via throw, not a return.
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

/**
 * Minimal stand-in for the chainable Supabase query builder. Every
 * intermediate call (select/eq/order/update/insert/delete) returns the same
 * object so chains of arbitrary shape keep working; `.single()` and a
 * bare `await` (via `.then`) both resolve to the same fixed result, which
 * is all any call site in project.ts needs.
 */
function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    update: vi.fn((_payload: unknown) => builder),
    insert: vi.fn((_payload: unknown) => builder),
    delete: vi.fn(() => builder),
    single: vi.fn(async () => result),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeClient(tables: Record<string, FakeQueryBuilder>): { from: ReturnType<typeof vi.fn> } {
  return {
    from: vi.fn((table: string) => {
      const builder = tables[table];
      if (!builder) {
        throw new Error(`Test did not stub table "${table}"`);
      }
      return builder;
    }),
  };
}

function fullProjectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "project-1",
    user_id: "owner-1",
    title: "Original title",
    script_raw: "Original script",
    character_desc: "Original character",
    character_desc_edited_at: null,
    product_appearance_edited_at: null,
    status: "framed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    cut_order_updated_at: null,
    active_final_version_id: null,
    render_settings: { model: "ltx-2.3-fast", resolution: "1440p", fps: 30 },
    shooting_mode: "mirror",
    camera_movement: true,
    visual_idea: "Lock the camera, zero pan",
    voice_profile: "warm, inspiring",
    pronunciation_guide: "Seranova -> seh-rah-NOH-vah",
    ugc_style: "unboxing",
    include_visual_idea: true,
    // Deliberately NOT the shipped defaults: a fixture on the defaults
    // would let a duplicate that dropped these columns still assert equal,
    // since the new row's own column defaults would supply the same values.
    captions_enabled: false,
    caption_box_color: "#112233",
    caption_text_color: "#445566",
    product_name: "NeuroBlast SMN16-18",
    product_appearance: "Matte green stand-up pouch, kraft-paper texture.",
    source_character_id: "character-lib-1",
    kind: "scripted",
    is_personal: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.mocked(requireUser).mockReset();
  vi.mocked(requireProject).mockReset();
  vi.mocked(createClient).mockReset();
  vi.mocked(createAdminClient).mockReset();
});

describe("updateProject", () => {
  // The commitment point is `project.status === 'delivered'`
  // (deriveProjectStatus's output, already resolved onto `project` by
  // requireProject — see actions/guard.ts), NOT "a scene has left
  // draft/frame_ready" — see lib/editable-guard.ts's header comment. A
  // rendered-but-undelivered project (status 'complete'/'rendering'/etc.)
  // must stay editable; only 'delivered' refuses.

  it("refuses script_raw once the project has been delivered", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "delivered" },
    } as never);
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateProject("project-1", { script_raw: "new script" });

    expect(result).toEqual({ error: expect.stringMatching(/delivered/i) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("refuses character_desc once the project has been delivered", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "delivered" },
    } as never);
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateProject("project-1", { character_desc: "new character" });

    expect(result).toEqual({ error: expect.stringMatching(/delivered/i) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("still allows a title-only rename once the project has been delivered", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "delivered" },
    } as never);
    const projectsBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ projects: projectsBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateProject("project-1", { title: "Renamed" });

    expect(result).toBeUndefined();
    expect(projectsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Renamed" }),
    );
    const written = projectsBuilder.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty("script_raw");
    expect(written).not.toHaveProperty("character_desc");
  });

  it("writes script_raw and character_desc on a rendered-but-undelivered project", async () => {
    // 'complete' — every scene finished rendering, nobody has clicked Mark
    // delivered yet. This is exactly the case the old scene-status lock got
    // wrong: rendering having started (or even finished) must not block
    // this write, only an actual delivery does.
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "complete" },
    } as never);
    const projectsBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ projects: projectsBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateProject("project-1", {
      script_raw: "new script",
      character_desc: "new character",
    });

    expect(result).toBeUndefined();
    expect(projectsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ script_raw: "new script", character_desc: "new character" }),
    );
  });

  it("writes script_raw and character_desc while every scene is still draft/frame_ready", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "briefed" },
    } as never);
    const projectsBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ projects: projectsBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateProject("project-1", {
      script_raw: "new script",
      character_desc: "new character",
    });

    expect(result).toBeUndefined();
    expect(projectsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ script_raw: "new script", character_desc: "new character" }),
    );
  });

  it("treats a project with no scenes yet as unlocked", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "draft" },
    } as never);
    const projectsBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ projects: projectsBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await updateProject("project-1", { script_raw: "new script" });

    expect(result).toBeUndefined();
    expect(projectsBuilder.update).toHaveBeenCalled();
  });
});

describe("renameProject", () => {
  it("writes the trimmed title when it differs from the current one", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { title: "Original title" },
    } as never);
    const projectsBuilder = fakeBuilder({ data: null, error: null });
    const admin = fakeClient({ projects: projectsBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await renameProject("project-1", "  New name  ");

    expect(result).toBeUndefined();
    // Trimmed by requireTitle (the same function createProject/saveTitle
    // use), not by renameProject re-implementing its own trim.
    expect(projectsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New name" }),
    );
  });

  it("refuses an empty or whitespace-only title without touching the admin client — a rename requireTitle would refuse for create must be refused here too", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { title: "Original title" },
    } as never);
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await renameProject("project-1", "   ");

    expect(result).toEqual({ error: expect.stringMatching(/title is required/i) });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("treats a resubmitted, unchanged title as a no-op — no admin-client write for a row nothing actually changed on", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { title: "Original title" },
    } as never);
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await renameProject("project-1", "Original title");

    expect(result).toBeUndefined();
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("propagates requireProject's ownership refusal (another user's project, or one that no longer exists) before ever creating the admin client", async () => {
    vi.mocked(requireProject).mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;404"));
    const admin = fakeClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await expect(renameProject("project-1", "New name")).rejects.toThrow(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
    expect(admin.from).not.toHaveBeenCalled();
  });
});

describe("duplicateProject", () => {
  it("copies every operator-authored column, excludes source_character_id, and owns the copy as the current user", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      user: { id: "current-user", email: "x@y.z" },
    } as never);

    const sourceProject = fullProjectRow();
    const projectsReadBuilder = fakeBuilder({ data: sourceProject, error: null });
    const scenesReadBuilder = fakeBuilder({ data: [], error: null });
    const supabase = fakeClient({ projects: projectsReadBuilder, scenes: scenesReadBuilder });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const insertedProject = { ...sourceProject, id: "project-2", user_id: "current-user" };
    const projectsWriteBuilder = fakeBuilder({ data: insertedProject, error: null });
    const admin = fakeClient({ projects: projectsWriteBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await expect(duplicateProject("project-1")).rejects.toThrow("REDIRECT:/projects/project-2");

    expect(projectsWriteBuilder.insert).toHaveBeenCalledWith({
      user_id: "current-user",
      title: "Original title (copy)",
      script_raw: "Original script",
      character_desc: "Original character",
      render_settings: sourceProject.render_settings,
      shooting_mode: "mirror",
      camera_movement: true,
      visual_idea: "Lock the camera, zero pan",
      voice_profile: "warm, inspiring",
      pronunciation_guide: "Seranova -> seh-rah-NOH-vah",
      ugc_style: "unboxing",
      product_name: "NeuroBlast SMN16-18",
      product_appearance: "Matte green stand-up pouch, kraft-paper texture.",
      include_visual_idea: true,
      captions_enabled: false,
      caption_box_color: "#112233",
      caption_text_color: "#445566",
      kind: "scripted",
      status: "draft",
    });

    const inserted = projectsWriteBuilder.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted).not.toHaveProperty("source_character_id");
    expect(inserted).not.toHaveProperty("id");
    expect(inserted).not.toHaveProperty("created_at");
    expect(inserted).not.toHaveProperty("updated_at");
  });

  it("never carries the source project's user_id onto the copy, even for an admin duplicating someone else's project", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      user: { id: "admin-1", email: "admin@y.z" },
    } as never);

    const sourceProject = fullProjectRow({ user_id: "someone-else" });
    const projectsReadBuilder = fakeBuilder({ data: sourceProject, error: null });
    const scenesReadBuilder = fakeBuilder({ data: [], error: null });
    const supabase = fakeClient({ projects: projectsReadBuilder, scenes: scenesReadBuilder });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const insertedProject = { ...sourceProject, id: "project-2", user_id: "admin-1" };
    const projectsWriteBuilder = fakeBuilder({ data: insertedProject, error: null });
    const admin = fakeClient({ projects: projectsWriteBuilder });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await expect(duplicateProject("project-1")).rejects.toThrow("REDIRECT:/projects/project-2");

    const inserted = projectsWriteBuilder.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.user_id).toBe("admin-1");
  });
});
