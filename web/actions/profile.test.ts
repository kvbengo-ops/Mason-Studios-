import { afterEach, describe, expect, it, vi } from "vitest";
import { changePassword, updateUsername, uploadAvatar, removeAvatar } from "./profile";
import { requireUser } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { uploadAvatarFile, removeStorageObjects } from "@/lib/storage";

// Same fakes-over-the-two-boundaries approach as actions/allowance.test.ts:
// the ownership guard (actions/guard.ts), the admin Supabase client
// factory, and lib/storage.ts (the only file allowed to touch
// supabase.storage — see its own header) are mocked; next/cache's
// revalidatePath is a no-op outside a real request.
vi.mock("@/actions/guard", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  resolveStagedUploads: vi.fn(),
  uploadAvatarFile: vi.fn(),
  removeStorageObjects: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

/** Minimal chainable Supabase query builder stand-in — same shape as actions/allowance.test.ts's own. */
function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    update: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeClient(tables: Record<string, FakeQueryBuilder>): { from: ReturnType<typeof vi.fn> } {
  return {
    from: vi.fn((table: string) => {
      const builder = tables[table];
      if (!builder) {
        throw new Error(`Unexpected table in test: ${table}`);
      }
      return builder;
    }),
  };
}

const USER = { id: "user-1", email: "editor@example.com" };

afterEach(() => {
  vi.resetAllMocks();
});

describe("updateUsername", () => {
  it("returns (does not throw) a validation error for an invalid username", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });

    const formData = new FormData();
    formData.set("username", "a"); // too short
    const result = await updateUsername(formData);

    expect(result).toEqual({ error: expect.any(String) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("updates only the username column, scoped to the caller's own id — role is never in the payload", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const updateBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ profiles: updateBuilder }) as never);

    const formData = new FormData();
    formData.set("username", "new_handle");
    // A tampered client could still append a `role` field; updateUsername
    // must never read it — see actions/profile.ts's own header for why.
    formData.set("role", "admin");

    const result = await updateUsername(formData);

    expect(result).toBeUndefined();
    expect(updateBuilder.update).toHaveBeenCalledWith({ username: "new_handle" });
    expect(updateBuilder.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: expect.anything() }),
    );
    expect(updateBuilder.eq).toHaveBeenCalledWith("id", USER.id);
  });

  it("turns a duplicate-username unique-violation (profiles_username_lower_idx, 0015) into a RETURNED error, not a throw", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const updateBuilder = fakeBuilder({
      data: null,
      error: { message: "duplicate key value violates unique constraint", code: "23505" },
    });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ profiles: updateBuilder }) as never);

    const formData = new FormData();
    formData.set("username", "taken_handle");

    const result = await updateUsername(formData);

    expect(result).toEqual({ error: expect.stringMatching(/already taken/i) });
  });

  it("throws (does not return) on any other database error", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const updateBuilder = fakeBuilder({ data: null, error: { message: "connection reset" } });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ profiles: updateBuilder }) as never);

    const formData = new FormData();
    formData.set("username", "valid_handle");

    await expect(updateUsername(formData)).rejects.toThrow(/connection reset/);
  });
});

describe("uploadAvatar", () => {
  function avatarFormData(file: File): FormData {
    const formData = new FormData();
    formData.set("file", file);
    return formData;
  }

  it("returns (does not throw) an error for a non-image file", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });

    const result = await uploadAvatar(
      avatarFormData(new File(["x"], "notes.txt", { type: "text/plain" })),
    );

    expect(result).toEqual({ error: expect.stringMatching(/JPG, PNG, or WebP/i) });
    expect(uploadAvatarFile).not.toHaveBeenCalled();
  });

  it("returns (does not throw) an error for an oversized file", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const oversized = new File([new Uint8Array(11 * 1024 * 1024)], "photo.jpg", {
      type: "image/jpeg",
    });

    const result = await uploadAvatar(avatarFormData(oversized));

    expect(result).toEqual({ error: expect.stringMatching(/limit/i) });
    expect(uploadAvatarFile).not.toHaveBeenCalled();
  });

  it("deletes the OLD storage object after committing the new key — never before", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const selectBuilder = fakeBuilder({
      data: { avatar_storage_key: "avatars/user-1/old.jpg" },
      error: null,
    });
    const updateBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ profiles: selectBuilder }) as never);
    // Both select and update run through admin.from("profiles") in this
    // action — the fake client dispatches by table name only, so the
    // second call (`.update(...)`) needs the same builder to also resolve
    // successfully for the update chain. Re-point "profiles" at a builder
    // that answers both maybeSingle() (the select) and the bare await (the
    // update) with the right shape for each call in sequence.
    let call = 0;
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => {
        call += 1;
        return call === 1 ? selectBuilder : updateBuilder;
      }),
    } as never);

    vi.mocked(uploadAvatarFile).mockResolvedValue({ storageKey: "avatars/user-1/new.jpg" });

    const callOrder: string[] = [];
    updateBuilder.update.mockImplementation(() => {
      callOrder.push("update-row");
      return updateBuilder;
    });
    vi.mocked(removeStorageObjects).mockImplementation(async (keys) => {
      callOrder.push(`remove:${keys[0]}`);
    });

    const file = new File([new Uint8Array(10)], "photo.jpg", { type: "image/jpeg" });
    const result = await uploadAvatar(avatarFormData(file));

    expect(result).toBeUndefined();
    expect(updateBuilder.update).toHaveBeenCalledWith({
      avatar_storage_key: "avatars/user-1/new.jpg",
    });
    expect(removeStorageObjects).toHaveBeenCalledWith(["avatars/user-1/old.jpg"]);
    // The new key was written to the row BEFORE the old object was deleted
    // — see actions/profile.ts's own comment on why this order (not
    // removeCharacter's delete-then-update-row order) is the one that
    // never leaves a broken pointer behind.
    expect(callOrder).toEqual(["update-row", "remove:avatars/user-1/old.jpg"]);
  });

  it("does not delete anything when there was no previous avatar", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const selectBuilder = fakeBuilder({ data: { avatar_storage_key: null }, error: null });
    const updateBuilder = fakeBuilder({ data: null, error: null });
    let call = 0;
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => {
        call += 1;
        return call === 1 ? selectBuilder : updateBuilder;
      }),
    } as never);
    vi.mocked(uploadAvatarFile).mockResolvedValue({ storageKey: "avatars/user-1/new.jpg" });

    const file = new File([new Uint8Array(10)], "photo.jpg", { type: "image/jpeg" });
    const result = await uploadAvatar(avatarFormData(file));

    expect(result).toBeUndefined();
    expect(removeStorageObjects).not.toHaveBeenCalled();
  });
});

describe("removeAvatar", () => {
  it("is a no-op when the account has no avatar", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const selectBuilder = fakeBuilder({ data: { avatar_storage_key: null }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ profiles: selectBuilder }) as never);

    const result = await removeAvatar();

    expect(result).toBeUndefined();
    expect(removeStorageObjects).not.toHaveBeenCalled();
  });

  it("deletes the storage object and clears the column, scoped to the caller's own id", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const selectBuilder = fakeBuilder({
      data: { avatar_storage_key: "avatars/user-1/old.jpg" },
      error: null,
    });
    const updateBuilder = fakeBuilder({ data: null, error: null });
    let call = 0;
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => {
        call += 1;
        return call === 1 ? selectBuilder : updateBuilder;
      }),
    } as never);

    const result = await removeAvatar();

    expect(result).toBeUndefined();
    expect(removeStorageObjects).toHaveBeenCalledWith(["avatars/user-1/old.jpg"]);
    expect(updateBuilder.update).toHaveBeenCalledWith({ avatar_storage_key: null });
    expect(updateBuilder.eq).toHaveBeenCalledWith("id", USER.id);
  });
});

describe("changePassword", () => {
  it("refuses a wrong current password and does not call updateUser", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });

    const signInWithPasswordMock = vi.fn(async () => ({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials" },
    }));
    const signOutMock = vi.fn(async () => ({ error: null }));
    vi.mocked(createSupabaseClient).mockReturnValue({
      auth: {
        signInWithPassword: signInWithPasswordMock,
        signOut: signOutMock,
      },
    } as never);

    const updateUserMock = vi.fn(async () => ({ error: null }));
    vi.mocked(createClient).mockResolvedValue({
      auth: { updateUser: updateUserMock },
    } as never);

    const formData = new FormData();
    formData.set("currentPassword", "wrongcurrentpassword");
    formData.set("password", "newvalidpassword");
    formData.set("confirmPassword", "newvalidpassword");

    const result = await changePassword(formData);

    expect(result).toEqual({ error: "Current password is incorrect." });
    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: USER.email,
      password: "wrongcurrentpassword",
    });
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("updates the password when the current password is verified", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });

    const signInWithPasswordMock = vi.fn(async () => ({
      data: { user: USER, session: {} },
      error: null,
    }));
    const signOutMock = vi.fn(async () => ({ error: null }));
    vi.mocked(createSupabaseClient).mockReturnValue({
      auth: {
        signInWithPassword: signInWithPasswordMock,
        signOut: signOutMock,
      },
    } as never);

    const updateUserMock = vi.fn(async () => ({ error: null }));
    vi.mocked(createClient).mockResolvedValue({
      auth: { updateUser: updateUserMock },
    } as never);

    const formData = new FormData();
    formData.set("currentPassword", "correctcurrentpassword");
    formData.set("password", "newvalidpassword");
    formData.set("confirmPassword", "newvalidpassword");

    const result = await changePassword(formData);

    expect(result).toBeUndefined();
    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: USER.email,
      password: "correctcurrentpassword",
    });
    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
    expect(updateUserMock).toHaveBeenCalledWith({ password: "newvalidpassword" });
  });
});
