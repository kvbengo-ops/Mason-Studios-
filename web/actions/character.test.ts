import { afterEach, describe, expect, it, vi } from "vitest";
import { removeCharacterRef, improveDescription, describeProductFromPhoto } from "./character";
import { requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { improveDescriptionText, describePhotoAppearance } from "@/lib/claude";
import { assertWithinSpendCaps } from "@/lib/spend";
import { recordRun } from "@/lib/runs";
import { signedUrl } from "@/lib/storage";

// actions/character.ts's project-level lock moved from "any scene has left
// draft/frame_ready" to `project.status === 'delivered'` — see
// lib/editable-guard.ts's header comment for why those are different
// questions. These tests pin exactly that: a rendered-but-undelivered
// project (deriveProjectStatus's 'complete'/'rendering'/etc., already
// resolved onto `project` by requireProject) must stay editable, and only
// an actual delivery refuses. removeCharacterRef is the simplest call site
// to exercise this through — its own body does nothing past the lock check
// when there's no character_ref row to remove, so a "does it get PAST the
// lock" test doesn't need to mock Storage removal at all.
vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
  requireScene: vi.fn(),
  isAdmin: vi.fn(() => false),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/claude", () => ({
  improveDescriptionText: vi.fn(),
  describePhotoAppearance: vi.fn(),
  CLAUDE_VENDOR: "anthropic",
}));

vi.mock("@/lib/spend", () => ({
  assertWithinSpendCaps: vi.fn(),
}));

vi.mock("@/lib/runs", () => ({
  recordRun: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  signedUrl: vi.fn(),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeAdminClient(assetsResult: FakeQueryResult): { from: ReturnType<typeof vi.fn> } {
  return {
    from: vi.fn((table: string) => {
      if (table === "assets") return fakeBuilder(assetsResult);
      throw new Error(`Test did not stub table "${table}"`);
    }),
  };
}

/**
 * primaryProductRefStorageKey (actions/character.ts) chains
 * .select().eq().eq().order() — one more link than fakeBuilder above
 * supports — so describeProductFromPhoto's tests get their own builder
 * rather than growing the shared one for a shape only this file's newest
 * tests need.
 */
interface FakeOrderedQueryBuilder extends FakeQueryBuilder {
  order: ReturnType<typeof vi.fn>;
}

function fakeOrderedBuilder(result: FakeQueryResult): FakeOrderedQueryBuilder {
  const builder = fakeBuilder(result) as FakeOrderedQueryBuilder;
  builder.order = vi.fn(() => builder);
  return builder;
}

function fakeAdminClientWithProductRefs(productRefsResult: FakeQueryResult): {
  from: ReturnType<typeof vi.fn>;
} {
  return {
    from: vi.fn((table: string) => {
      if (table === "assets") return fakeOrderedBuilder(productRefsResult);
      throw new Error(`Test did not stub table "${table}"`);
    }),
  };
}

afterEach(() => {
  vi.mocked(requireProject).mockReset();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(improveDescriptionText).mockReset();
  vi.mocked(describePhotoAppearance).mockReset();
  vi.mocked(assertWithinSpendCaps).mockReset();
  vi.mocked(recordRun).mockReset();
  vi.mocked(signedUrl).mockReset();
});

describe("removeCharacterRef (project-level character lock)", () => {
  it("refuses once the project has been delivered", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "delivered" },
    } as never);
    const admin = fakeAdminClient({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await removeCharacterRef("project-1");

    expect(result).toEqual({ error: expect.stringMatching(/delivered/i) });
    // Refused before ever touching `assets` — no query, no Storage call.
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("is not refused on a rendered-but-undelivered project", async () => {
    // 'complete' — every scene finished, nobody has clicked Mark delivered.
    // The old lock (any scene left draft/frame_ready) would have refused
    // this; the new one must not.
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "complete" },
    } as never);
    const admin = fakeAdminClient({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await removeCharacterRef("project-1");

    // No character_ref row exists in this fixture, so the function's own
    // no-op path returns `undefined` — the point being it got PAST the lock
    // check to reach that query at all, unlike the delivered case above.
    expect(result).toBeUndefined();
    expect(admin.from).toHaveBeenCalledWith("assets");
  });

  it("is not refused before any scene has ever been touched", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      project: { status: "draft" },
    } as never);
    const admin = fakeAdminClient({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await removeCharacterRef("project-1");

    expect(result).toBeUndefined();
    expect(admin.from).toHaveBeenCalledWith("assets");
  });
});

// Minimal-but-complete project row shared below — render_settings: {} means
// parseCompilerModel falls back to Haiku, so applySceneCostUsd resolves to
// a known, pinned figure (see lib/models.ts / actions/brief.ts's own
// "pins today's behaviour for a project that has never chosen a compiler
// model" tests for the identical pattern).
function fakeProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "project-1",
    status: "draft",
    render_settings: {},
    product_name: null,
    ...overrides,
  };
}

describe("improveDescription", () => {
  it("refuses once the project has been delivered, without spending anything", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject({ status: "delivered" }),
    } as never);

    const result = await improveDescription("project-1", "character", "an athletic woman");

    expect(result).toEqual({ error: expect.stringMatching(/delivered/i) });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
    expect(improveDescriptionText).not.toHaveBeenCalled();
  });

  it("refuses an empty description before checking spend caps", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject(),
    } as never);

    const result = await improveDescription("project-1", "character", "   ");

    expect(result).toEqual({ error: expect.stringMatching(/nothing to improve/i) });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
  });

  it("returns the spend-cap refusal and never calls the Claude helper", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject(),
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue({ error: "over your daily cap" });

    const result = await improveDescription("project-1", "character", "an athletic woman");

    expect(result).toEqual({ error: "over your daily cap" });
    expect(improveDescriptionText).not.toHaveBeenCalled();
  });

  it("on success, calls the Claude helper, records a run at the quoted cost, and returns the suggestion", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject(),
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(improveDescriptionText).mockResolvedValue({
      description: "an athletic woman with shoulder-length dark hair, wearing running gear",
    });

    const result = await improveDescription("project-1", "character", "an athletic woman");

    expect(result).toEqual({
      suggestion: "an athletic woman with shoulder-length dark hair, wearing running gear",
    });
    expect(improveDescriptionText).toHaveBeenCalledWith(
      expect.objectContaining({ description: "an athletic woman", subject: "character" }),
    );
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", costUsd: expect.any(Number) }),
    );
    expect(recordRun).toHaveBeenCalledTimes(1);
  });

  it("on a failed Claude call, records the run with a null cost and rethrows — never guesses it was billed", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject(),
    } as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(improveDescriptionText).mockRejectedValue(new Error("vendor timeout"));

    await expect(improveDescription("project-1", "character", "an athletic woman")).rejects.toThrow(
      "vendor timeout",
    );

    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: null, error: "vendor timeout" }),
    );
    expect(recordRun).toHaveBeenCalledTimes(1);
  });
});

describe("describeProductFromPhoto", () => {
  it("refuses once the project has been delivered, without spending anything", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject({ status: "delivered" }),
    } as never);

    const result = await describeProductFromPhoto("project-1");

    expect(result).toEqual({ error: expect.stringMatching(/delivered/i) });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
  });

  it("refuses with no product photo uploaded, before checking spend caps", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject(),
    } as never);
    const admin = fakeAdminClientWithProductRefs({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await describeProductFromPhoto("project-1");

    expect(result).toEqual({ error: expect.stringMatching(/upload a product photo/i) });
    expect(assertWithinSpendCaps).not.toHaveBeenCalled();
  });

  it("returns the spend-cap refusal and never calls the Claude helper", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject(),
    } as never);
    const admin = fakeAdminClientWithProductRefs({
      data: [{ id: "asset-1", storage_key: "product/1.jpg", position: 0 }],
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue({ error: "over your daily cap" });

    const result = await describeProductFromPhoto("project-1");

    expect(result).toEqual({ error: "over your daily cap" });
    expect(describePhotoAppearance).not.toHaveBeenCalled();
  });

  it("on success, signs the primary photo, calls the Claude helper, records a run, and returns the suggestion", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject({ product_name: "Kinoko" }),
    } as never);
    const admin = fakeAdminClientWithProductRefs({
      data: [{ id: "asset-1", storage_key: "product/1.jpg", position: 0 }],
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(signedUrl).mockResolvedValue("https://signed.example/product/1.jpg");
    vi.mocked(describePhotoAppearance).mockResolvedValue({
      description: "Matte kraft-paper pouch, forest-green label.",
    });

    const result = await describeProductFromPhoto("project-1");

    expect(result).toEqual({ suggestion: "Matte kraft-paper pouch, forest-green label." });
    expect(signedUrl).toHaveBeenCalledWith("product/1.jpg");
    expect(describePhotoAppearance).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: "https://signed.example/product/1.jpg",
        productName: "Kinoko",
      }),
    );
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", costUsd: expect.any(Number) }),
    );
  });

  it("on a failed Claude call, records the run with a null cost and rethrows", async () => {
    vi.mocked(requireProject).mockResolvedValue({
      user: { id: "user-1" },
      profile: { role: "editor" },
      project: fakeProject(),
    } as never);
    const admin = fakeAdminClientWithProductRefs({
      data: [{ id: "asset-1", storage_key: "product/1.jpg", position: 0 }],
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    vi.mocked(assertWithinSpendCaps).mockResolvedValue(undefined);
    vi.mocked(signedUrl).mockResolvedValue("https://signed.example/product/1.jpg");
    vi.mocked(describePhotoAppearance).mockRejectedValue(new Error("vendor timeout"));

    await expect(describeProductFromPhoto("project-1")).rejects.toThrow("vendor timeout");

    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: null, error: "vendor timeout" }),
    );
    expect(recordRun).toHaveBeenCalledTimes(1);
  });
});
