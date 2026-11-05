import { afterEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { markAllNotificationsRead, markNotificationRead } from "./notifications";

vi.mock("@/actions/guard", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
});

describe("notification read actions", () => {
  it("guards and marks only the requested notification through the scoped RPC", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: { id: "user-1" }, profile: {} } as never);
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await markNotificationRead("notification-1");

    expect(requireUser).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("mark_notifications_read", {
      notification_ids: ["notification-1"],
    });
    expect(revalidatePath).toHaveBeenCalledWith("/notifications");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("uses null to mark all of the caller's notifications read", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: { id: "user-1" }, profile: {} } as never);
    const rpc = vi.fn(async () => ({ data: 3, error: null }));
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await markAllNotificationsRead();

    expect(rpc).toHaveBeenCalledWith("mark_notifications_read", {
      notification_ids: null,
    });
  });

  it("surfaces a database failure", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: { id: "user-1" }, profile: {} } as never);
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(async () => ({ data: null, error: { message: "connection reset" } })),
    } as never);

    await expect(markNotificationRead("notification-1")).rejects.toThrow(/connection reset/);
  });
});
