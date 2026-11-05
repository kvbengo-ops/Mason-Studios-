import { afterEach, describe, expect, it, vi } from "vitest";
import { compileScript } from "./compile";
import { requireProject } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { compileBrief } from "@/lib/claude";
import { assertWithinSpendCaps } from "@/lib/spend";
import { recordRun } from "@/lib/runs";

// Regression coverage for the exact defect this field's own write-up warns
// about (see lib/claude.ts's CompileBriefArgs.productAppearance doc
// comment): a call site that forgets to forward product_appearance would
// have it work on the very first compile (nothing to forget yet) and then
// silently vanish on every recompile after — this pins that the full
// compile path (runCompile, reached here through its compileScript Server
// Action) actually forwards projects.product_appearance to compileBrief.

vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/claude", () => ({
  compileBrief: vi.fn(),
  CLAUDE_VENDOR: "anthropic",
}));

vi.mock("@/lib/spend", () => ({
  assertWithinSpendCaps: vi.fn(),
}));

vi.mock("@/lib/runs", () => ({
  recordRun: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
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
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    insert: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    update: vi.fn(() => builder),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

// The session-scoped client (createClient) fields two independent readers
// inside runCompile — projectHasCharacterRefAsset/projectHasProduct query
// `assets`, loadLatestTemplate queries `prompt_templates` — plus one more
// call to createClient() from inside loadLatestTemplate itself. It also
// serves redirectToFirstScene's post-compile `scenes` select/order/limit
// /maybeSingle lookup, since compileScript/recompile call it right after
// runCompile succeeds; defaults to a single scene so the ordinary
// redirect-into-the-scene path is what these tests exercise.
function fakeSessionClient(): { from: ReturnType<typeof vi.fn> } {
  const assets = fakeBuilder({ data: [], error: null });
  const templates = fakeBuilder({
    data: { id: "template-1", body: "system prompt" },
    error: null,
  });
  const scenes = fakeBuilder({ data: { id: "scene-1" }, error: null });
  return {
    from: vi.fn((table: string) => {
      if (table === "assets") return assets;
      if (table === "prompt_templates") return templates;
      if (table === "scenes") return scenes;
      throw new Error(`Test did not stub table "${table}"`);
    }),
  };
}

function fakeAdminClient(): { from: ReturnType<typeof vi.fn> } {
  const scenes = fakeBuilder({ data: null, error: null });
  const projects = fakeBuilder({ data: null, error: null });
  return {
    from: vi.fn((table: string) => {
      if (table === "scenes") return scenes;
      if (table === "projects") return projects;
      throw new Error(`Test did not stub table "${table}"`);
    }),
  };
}

const fakeBrief = {
  character: "A woman in a kitchen.",
  scenes: [
    {
      script_line: "Hello there.",
      video_prompt: "A medium shot.",
      is_talking_head: true,
      duration_s: 8,
    },
  ],
};

function fakeProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "project-1",
    script_raw: "Hello there.",
    character_desc: "A woman in her late 20s.",
    product_name: null,
    product_appearance: "Matte green stand-up pouch, kraft-paper texture.",
    render_settings: {},
    shooting_mode: "static",
    camera_movement: false,
    visual_idea: null,
    voice_profile: null,
    pronunciation_guide: null,
    ugc_style: "testimonial",
    include_visual_idea: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.mocked(requireProject).mockReset();
  vi.mocked(createClient).mockReset();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(compileBrief).mockReset();
  vi.mocked(assertWithinSpendCaps).mockReset();
  vi.mocked(recordRun).mockReset();
});

describe("compileScript (runCompile)", () => {
  it("passes the project's product_appearance through to compileBrief", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1", email: "a@b.com" },
      profile: { role: "member" },
      project: fakeProject(),
    } as never);
    vi.mocked(createClient).mockResolvedValue(fakeSessionClient() as never);
    vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient() as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(compileBrief).mockResolvedValue(fakeBrief as never);

    await expect(compileScript("project-1")).rejects.toThrow("NEXT_REDIRECT");

    expect(compileBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        productAppearance: "Matte green stand-up pouch, kraft-paper texture.",
      }),
    );
  });

  it("passes undefined, not null, when the project has no product_appearance set", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1", email: "a@b.com" },
      profile: { role: "member" },
      project: fakeProject({ product_appearance: null }),
    } as never);
    vi.mocked(createClient).mockResolvedValue(fakeSessionClient() as never);
    vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient() as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(compileBrief).mockResolvedValue(fakeBrief as never);

    await expect(compileScript("project-1")).rejects.toThrow("NEXT_REDIRECT");

    expect(compileBrief).toHaveBeenCalledWith(
      expect.objectContaining({ productAppearance: undefined }),
    );
  });
});
