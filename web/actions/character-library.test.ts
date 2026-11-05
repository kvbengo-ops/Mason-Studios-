import { afterEach, describe, expect, it, vi } from "vitest";
import { removeCharacter } from "./character-library";
import { requireAdmin } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { removeStorageObjects } from "@/lib/storage";

// removeCharacter's own comment (character-library.ts, above the function)
// says Storage-first, row-second is deliberate: removeStorageObjects'
// failure mode is only safe in that order (see lib/storage.ts's doc comment
// on removeStorageObjects — storage-first means a failure there leaves
// nothing touched and the operation retriable; row-first would risk an
// unreclaimable orphaned object). These tests pin: (1) an unauthorized
// caller deletes nothing at all, (2) storage removal really does happen
// before the row delete, and (3) a storage removal failure leaves the row
// alive (the delete must never be reached).
vi.mock("@/actions/guard", () => ({
  requireAdmin: vi.fn(),
  requireProject: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  removeStorageObjects: vi.fn(),
  buildStorageKey: vi.fn(),
  copyStorageObject: vi.fn(),
  extFromFilename: vi.fn(),
  uploadLibraryFile: vi.fn(),
  uploadLibraryFromUrl: vi.fn(),
}));

vi.mock("@/lib/kie", () => ({
  generateImage: vi.fn(),
  modelForImageArgs: vi.fn(),
  ImageGenerationError: class ImageGenerationError extends Error {},
}));

vi.mock("@/lib/render-error", () => ({
  classifyRenderError: vi.fn(),
}));

vi.mock("@/actions/character", () => ({
  invalidateComposite: vi.fn(),
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

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

function fakeBuilder(
  selectResult: FakeQueryResult,
  deleteResult: FakeQueryResult,
): {
  builder: FakeQueryBuilder;
} {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => selectResult),
    then: (onFulfilled, onRejected) => Promise.resolve(deleteResult).then(onFulfilled, onRejected),
  };
  return { builder };
}

function fakeAdminClient(
  selectResult: FakeQueryResult,
  deleteResult: FakeQueryResult = { data: null, error: null },
): { from: ReturnType<typeof vi.fn>; builder: FakeQueryBuilder } {
  const { builder } = fakeBuilder(selectResult, deleteResult);
  return {
    from: vi.fn((table: string) => {
      if (table !== "characters") throw new Error(`Test did not stub table "${table}"`);
      return builder;
    }),
    builder,
  };
}

afterEach(() => {
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(removeStorageObjects).mockReset();
});

describe("removeCharacter", () => {
  it("deletes nothing when the caller is not an admin", async () => {
    class AuthorizationError extends Error {}
    vi.mocked(requireAdmin).mockRejectedValue(new AuthorizationError("User x is not an admin."));

    const admin = fakeAdminClient({ data: { storage_key: "key-1" }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    await expect(removeCharacter("character-1")).rejects.toThrow(/not an admin/);

    expect(admin.from).not.toHaveBeenCalled();
    expect(removeStorageObjects).not.toHaveBeenCalled();
  });

  it("removes the Storage object before deleting the row", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1" },
      profile: { role: "admin" },
    } as never);

    const admin = fakeAdminClient({ data: { storage_key: "key-1" }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const callOrder: string[] = [];
    vi.mocked(removeStorageObjects).mockImplementation(async () => {
      callOrder.push("storage");
    });
    admin.builder.delete.mockImplementation(() => {
      callOrder.push("row-delete");
      return admin.builder;
    });

    await removeCharacter("character-1");

    expect(removeStorageObjects).toHaveBeenCalledWith(["key-1"]);
    expect(admin.builder.delete).toHaveBeenCalled();
    expect(callOrder).toEqual(["storage", "row-delete"]);
  });

  it("leaves the row alive when storage removal fails — the delete must never be reached", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1" },
      profile: { role: "admin" },
    } as never);

    const admin = fakeAdminClient({ data: { storage_key: "key-1" }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    vi.mocked(removeStorageObjects).mockRejectedValue(
      new Error("removeStorageObjects: failed to delete from storage: boom"),
    );

    await expect(removeCharacter("character-1")).rejects.toThrow(/failed to delete from storage/);

    expect(admin.builder.delete).not.toHaveBeenCalled();
  });
});
