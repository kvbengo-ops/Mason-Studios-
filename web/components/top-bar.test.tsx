// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { markNotificationRead } from "@/actions/notifications";
import { TopBar } from "./top-bar";
import type { Notification } from "@/lib/notifications";

const channel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
};
const removeChannel = vi.fn(async () => undefined);

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => channel,
    removeChannel,
  }),
}));
vi.mock("@/actions/auth", () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock("@/actions/notifications", () => ({
  markNotificationRead: vi.fn(async () => undefined),
  markAllNotificationsRead: vi.fn(async () => undefined),
}));
vi.mock("@/actions/transfer", () => ({ passAllowance: vi.fn(async () => undefined) }));
vi.mock("@/actions/allowance", () => ({
  requestAllowance: vi.fn(async () => undefined),
  cancelAllowanceRequest: vi.fn(async () => undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TopBar", () => {
  it("places the notification icon and account together at the top right", () => {
    const notifications: Notification[] = Array.from({ length: 6 }, (_, index) => ({
      id: `notification-${index + 1}`,
      kind: "scene_completed",
      title: `Notification ${index + 1}`,
      body: `Update ${index + 1}`,
      metadata: { project_id: "project-1", project_kind: "scripted" },
      created_at: new Date(2026, 8, 13, 12, index).toISOString(),
      read_at: index === 1 ? new Date(2026, 8, 13, 13).toISOString() : null,
      scene_id: `scene-${index + 1}`,
      allowance_request_id: null,
    }));
    render(
      <TopBar
        unreadNotificationCount={12}
        initialNotifications={notifications}
        currentUserId="user-1"
        email="admin@admin.com"
        roleLabel="Admin"
        avatarUrl={null}
        isAdmin={true}
        budget={null}
      />,
    );

    const notificationLink = screen.getByRole("link", { name: "Notifications" });
    const badge = screen.getByLabelText("12 unread notifications");
    const accountButton = screen.getByRole("button", {
      name: "Account menu — admin@admin.com",
    });

    expect(notificationLink.getAttribute("href")).toBe("/notifications");
    expect(notificationLink.closest("header")?.className).toContain("bg-sidebar/95");
    expect(badge.textContent).toBe("9+");
    expect(badge.className).toContain("bg-destructive");
    expect(badge.className).not.toContain("animate-pulse");
    expect(within(accountButton).queryByText("admin@admin.com")).toBeNull();
    for (const notification of notifications.slice(0, 5)) {
      expect(
        screen.getByRole("link", { name: new RegExp(notification.title) }).getAttribute("href"),
      ).toBe(`/projects/project-1/scenes/${notification.scene_id}`);
    }
    expect(screen.queryByText("Notification 6")).toBeNull();
    expect(screen.getByRole("link", { name: "See all notifications" }).getAttribute("href")).toBe(
      "/notifications",
    );
    expect(channel.subscribe).toHaveBeenCalledOnce();
  });

  it("filters credit notices and opens the selected notice from the hover panel", async () => {
    const user = userEvent.setup();
    const notification: Notification = {
      id: "renewal-notification",
      kind: "credit_renewed",
      title: "Weekly credit period reset",
      body: "The weekly credit period has reset.",
      metadata: { week_start: "2026-11-02" },
      created_at: "2026-11-02T00:00:00.000Z",
      read_at: null,
      scene_id: null,
      allowance_request_id: null,
    };

    render(
      <TopBar
        unreadNotificationCount={1}
        initialNotifications={[notification]}
        currentUserId="user-1"
        email="editor@example.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Allowance" }));
    const link = screen.getByRole("link", { name: /Weekly credit period reset/ });
    expect(link.getAttribute("href")).toBe("/profile");
    await user.click(link);
    expect(markNotificationRead).toHaveBeenCalledWith("renewal-notification");
  });
});
