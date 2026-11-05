import { afterEach, expect, it, vi } from "vitest";
import { requireUser } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { removeStorageObjects } from "@/lib/storage";
import { purgePersonalImage, restorePersonalImage } from "./image-bin";

vi.mock("@/actions/guard", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/storage", () => ({ removeStorageObjects: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

afterEach(() => vi.resetAllMocks());

function imageForm(): FormData {
  const form = new FormData();
  form.set("assetId", "4ec211e4-4b30-43aa-a542-57d503332229");
  return form;
}

it("refuses an unauthenticated purge before reaching the database or storage", async () => {
  vi.mocked(requireUser).mockRejectedValue(new Error("Sign in"));
  await expect(purgePersonalImage(imageForm())).rejects.toThrow("Sign in");
  expect(createClient).not.toHaveBeenCalled();
  expect(removeStorageObjects).not.toHaveBeenCalled();
});

it("preserves storage when the database refuses a purge", async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: "image unavailable" } }));
  vi.mocked(createClient).mockResolvedValue({ rpc } as never);
  await expect(purgePersonalImage(imageForm())).rejects.toThrow("unavailable");
  expect(removeStorageObjects).not.toHaveBeenCalled();
});

it("removes only the storage key returned by the owner-scoped purge", async () => {
  const rpc = vi.fn(async () => ({ data: "users/owner/image.png", error: null }));
  vi.mocked(createClient).mockResolvedValue({ rpc } as never);
  vi.mocked(removeStorageObjects).mockResolvedValue(undefined);
  await purgePersonalImage(imageForm());
  expect(rpc).toHaveBeenCalledWith("manage_personal_image", {
    p_asset_id: imageForm().get("assetId"), p_operation: "purge",
  });
  expect(removeStorageObjects).toHaveBeenCalledWith(["users/owner/image.png"]);
});

it("restores without removing any image bytes", async () => {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  vi.mocked(createClient).mockResolvedValue({ rpc } as never);
  await restorePersonalImage(imageForm());
  expect(rpc).toHaveBeenCalledWith("manage_personal_image", {
    p_asset_id: imageForm().get("assetId"), p_operation: "restore",
  });
  expect(removeStorageObjects).not.toHaveBeenCalled();
});
