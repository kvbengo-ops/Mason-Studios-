import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/actions/guard";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { copyStorageObject, removeStorageObjects } from "@/lib/storage";
import { saveSharedElement } from "./save-shared-element";

vi.mock("@/actions/guard", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(), createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  buildUserStorageKey: vi.fn(() => "users/viewer/audio/copy.wav"),
  extFromFilename: vi.fn(() => "wav"),
  copyStorageObject: vi.fn(),
  removeStorageObjects: vi.fn(),
}));

const shared = {
  id: "shared",
  user_id: "owner",
  name: "voice",
  category: "audio",
  description: "Saved description",
  ai_description: "AI description",
  asset_id: "source",
};
const source = {
  storage_key: "users/owner/audio/source.wav",
  kind: "audio",
  bytes: 120,
  duration_s: 8,
};

function builder(result: unknown) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return chain;
}

function setup(
  options: {
    missing?: boolean;
    duplicate?: boolean;
    deniedAsset?: boolean;
    insertError?: boolean;
  } = {},
) {
  const elementRead = builder({ data: options.missing ? null : shared, error: null });
  const namesRead = builder({ data: options.duplicate ? [{ name: "VOICE" }] : [], error: null });
  const assetRead = builder({ data: options.deniedAsset ? null : source, error: null });
  const session = {
    from: vi
      .fn()
      .mockReturnValueOnce(elementRead)
      .mockReturnValueOnce(namesRead)
      .mockReturnValueOnce(assetRead),
  };
  const assetWrite = builder({ data: { id: "copied" }, error: null });
  const elementWrite = builder({
    error: options.insertError ? { code: "23505", message: "duplicate" } : null,
  });
  const cleanup = builder({ error: null });
  const admin = {
    from: vi
      .fn()
      .mockReturnValueOnce(assetWrite)
      .mockReturnValueOnce(elementWrite)
      .mockReturnValueOnce(cleanup),
  };
  vi.mocked(createClient).mockResolvedValue(
    session as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  vi.mocked(createAdminClient).mockReturnValue(
    admin as unknown as ReturnType<typeof createAdminClient>,
  );
  return { session, assetWrite, elementWrite, cleanup };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireUser).mockResolvedValue({ user: { id: "viewer" } } as Awaited<
    ReturnType<typeof requireUser>
  >);
});

describe("saving a shared element to personal tags", () => {
  it("copies media and both descriptions into the authenticated account", async () => {
    const { assetWrite, elementWrite } = setup();
    expect(await saveSharedElement("shared")).toHaveProperty("notice");
    expect(copyStorageObject).toHaveBeenCalledWith(
      source.storage_key,
      "users/viewer/audio/copy.wav",
    );
    expect(assetWrite.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "viewer",
        project_id: null,
        kind: "audio",
        bytes: 120,
        duration_s: 8,
      }),
    );
    expect(elementWrite.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "viewer",
        name: "voice",
        description: shared.description,
        ai_description: shared.ai_description,
        asset_id: "copied",
      }),
    );
  });

  it.each([{ missing: true }, { duplicate: true }, { deniedAsset: true }])(
    "does not copy an unavailable source or conflicting name: %j",
    async (options) => {
      setup(options);
      expect(await saveSharedElement("shared")).toHaveProperty("error");
      expect(copyStorageObject).not.toHaveBeenCalled();
    },
  );

  it("cleans up its copy when another save wins the name race", async () => {
    const { cleanup } = setup({ insertError: true });
    expect(await saveSharedElement("shared")).toHaveProperty("error");
    expect(removeStorageObjects).toHaveBeenCalledWith(["users/viewer/audio/copy.wav"]);
    expect(cleanup.eq).toHaveBeenCalledWith("id", "copied");
  });

  it("checks approval before reading a reference", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not approved"));
    await expect(saveSharedElement("shared")).rejects.toThrow("Not approved");
    expect(createClient).not.toHaveBeenCalled();
  });
});
