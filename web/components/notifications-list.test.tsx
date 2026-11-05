// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { markAllNotificationsRead, markNotificationRead } from "@/actions/notifications";
import { NotificationsList } from "./notifications-list";
import type { Notification } from "@/lib/notifications";

vi.mock("@/actions/notifications", () => ({
  markAllNotificationsRead: vi.fn(async () => undefined),
  markNotificationRead: vi.fn(async () => undefined),
}));

interface FakeChannel {
  on: (...args: unknown[]) => FakeChannel;
  subscribe: () => void;
}

const fakeChannel: FakeChannel = {
  on: vi.fn((): FakeChannel => fakeChannel),
  subscribe: vi.fn((): void => undefined),
};
const fakeClient = {
  channel: vi.fn((): FakeChannel => fakeChannel),
  removeChannel: vi.fn(async (): Promise<void> => undefined),
};
vi.mock("@/lib/supabase/client", () => ({
  createClient: (): typeof fakeClient => fakeClient,
}));

const NOTIFICATIONS: Notification[] = [
  {
    id: "scene-notification",
    kind: "scene_completed",
    title: "Scene completed",
    body: "Scene 4 is ready to review.",
    metadata: { project_id: "project-1", project_kind: "clip", scene_index: 4 },
    scene_id: "scene-1",
    allowance_request_id: null,
    created_at: "2026-09-13T08:00:00.000Z",
    read_at: null,
  },
  {
    id: "credit-notification",
    kind: "credit_received",
    title: "Credits received",
    body: "A teammate passed you weekly credits.",
    metadata: { amount_usd: 5 },
    scene_id: null,
    allowance_request_id: null,
    created_at: "2026-09-12T08:00:00.000Z",
    read_at: "2026-09-12T09:00:00.000Z",
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NotificationsList", () => {
  it("links image progress to its generator and formats sent credits", () => {
    const base = NOTIFICATIONS[0]!;
    render(<NotificationsList currentUserId="owner-1" displayUnit="credits"
      initialNotifications={[
        { ...base, id: "image-personal", kind: "image_generating", title: "Generating image", metadata: { run_id: "run-1" } },
        { ...base, id: "image-project", kind: "image_completed", title: "Image ready", metadata: { run_id: "run-2", project_id: "image-project" } },
        { ...base, id: "credits-sent", kind: "credit_sent", title: "Credits sent", metadata: { amount_usd: 5 } },
      ]} />);
    expect(screen.getByRole("link", { name: /Generating image/ }).getAttribute("href")).toBe("/image-generator");
    expect(screen.getByRole("link", { name: /Image ready/ }).getAttribute("href")).toBe("/images/image-project");
    expect(screen.getByRole("link", { name: /Credits sent/ }).getAttribute("href")).toBe("/profile");
    expect(screen.getByText("1,000 cr passed to a teammate.")).toBeTruthy();
  });

  it("shows weekly credits and deep-links a completed scene", async () => {
    const user = userEvent.setup();
    render(
      <NotificationsList
        initialNotifications={NOTIFICATIONS}
        displayUnit="credits"
        currentUserId="owner-1"
      />,
    );

    expect(screen.getByText("1,000 cr added to your weekly allowance by a teammate.")).toBeTruthy();
    const sceneLink = screen.getByRole("link", { name: /Scene completed/ });
    expect(sceneLink.getAttribute("href")).toBe("/create?tab=video&scene=scene-1");
    await user.click(sceneLink);
    expect(markNotificationRead).toHaveBeenCalledWith("scene-notification");
  });

  it("shows the weekly renewal and links to the profile allowance", () => {
    render(
      <NotificationsList
        initialNotifications={[
          {
            id: "renewal-notification",
            kind: "credit_renewed",
            title: "Weekly credit period reset",
            body: "The weekly credit period has reset.",
            metadata: { week_start: "2026-11-02" },
            scene_id: null,
            allowance_request_id: null,
            created_at: "2026-11-02T00:00:00.000Z",
            read_at: null,
          },
        ]}
        displayUnit="credits"
        currentUserId="owner-1"
      />,
    );

    expect(screen.getByText("Weekly credit period reset")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Weekly credit period reset/ }).getAttribute("href")).toBe(
      "/profile",
    );
  });

  // Existing task notifications remain visible, with the deleted destination
  // falling back to the projects page.
  it("routes historical task notifications to projects", () => {
    render(
      <NotificationsList
        initialNotifications={[
          {
            id: "task-notification",
            kind: "task_assigned",
            title: "New task assigned",
            body: "A trusted editor assigned you work.",
            metadata: { task_id: "task-1", assignment_id: "assignment-1" },
            scene_id: null,
            allowance_request_id: null,
            created_at: "2026-09-14T08:00:00.000Z",
            read_at: null,
          },
          {
            id: "task-notification-no-id",
            kind: "task_cancelled",
            title: "Task cancelled",
            body: "A task you were assigned was cancelled.",
            metadata: {},
            scene_id: null,
            allowance_request_id: null,
            created_at: "2026-09-14T07:00:00.000Z",
            read_at: null,
          },
        ]}
        displayUnit="credits"
        currentUserId="owner-1"
      />,
    );

    expect(screen.getByRole("link", { name: /New task assigned/ }).getAttribute("href")).toBe(
      "/projects",
    );
    expect(screen.getByRole("link", { name: /Task cancelled/ }).getAttribute("href")).toBe(
      "/projects",
    );
  });

  it("filters to unread and marks every remaining item read", async () => {
    const user = userEvent.setup();
    render(
      <NotificationsList
        initialNotifications={NOTIFICATIONS}
        displayUnit="credits"
        currentUserId="owner-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unread (1)" }));
    expect(screen.getByText("Scene completed")).toBeTruthy();
    expect(screen.queryByText("Credits received")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(screen.getByText("You’re all caught up")).toBeTruthy();
  });
});
