// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import UsersPage from "./page";
import { createClient } from "@/lib/supabase/server";
import { UserPresenceStrip } from "@/components/user-presence-strip";

vi.mock("@/actions/guard", () => ({
  requireAdmin: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@example.com" },
    profile: { id: "admin-1", role: "admin", status: "active" },
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(() => {
    const query = {
      select: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    return { from: vi.fn(() => query) };
  }),
}));

vi.mock("@/lib/db-aggregates", () => ({
  getUserActiveGrantsTotals: vi.fn(async () => new Map()),
}));

vi.mock("@/components/live-search", () => ({
  LiveSearch: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/daily-cap-switch", () => ({
  DailyCapSwitch: () => null,
}));

vi.mock("@/components/accounts-control-live-refresh", () => ({
  AccountsControlLiveRefresh: () => null,
}));

vi.mock("@/components/all-editors-allowance-dialog", () => ({
  AllEditorsAllowanceDialog: () => null,
}));

vi.mock("@/components/user-row-actions", () => ({
  UserRowActions: ({ userId, allowanceOnly }: { userId: string; allowanceOnly?: boolean }) => (
    <span
      data-testid={`user-row-actions-${userId}`}
      data-allowance-only={String(allowanceOnly ?? false)}
    />
  ),
}));

vi.mock("@/components/page-size-control", () => ({
  PageSizeControl: () => null,
}));

vi.mock("@/components/pagination-controls", () => ({
  PaginationControls: () => null,
}));

vi.mock("@/components/sortable-table-head", () => ({
  SortableTableHead: ({ label }: { label: string }) => <th>{label}</th>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UsersPage row actions", () => {
  it("renders a View creations link for editor and trusted_editor rows, but not for admin rows", async () => {
    const directoryRows = [
      {
        id: "editor-1",
        email: "editor@example.com",
        username: "editor_one",
        role: "editor",
        created_at: "2026-10-30T00:00:00Z",
        project_count: 2,
        spend_usd: 1.5,
        status: "active",
      },
      {
        id: "trusted-1",
        email: "trusted@example.com",
        username: "trusted_one",
        role: "trusted_editor",
        created_at: "2026-10-30T00:00:00Z",
        project_count: 4,
        spend_usd: 5.0,
        status: "active",
      },
      {
        id: "admin-1",
        email: "admin@example.com",
        username: "admin_one",
        role: "admin",
        created_at: "2026-10-30T00:00:00Z",
        project_count: 0,
        spend_usd: 0,
        status: "active",
      },
    ];

    vi.mocked(createClient).mockResolvedValue({
      from: vi.fn((table: string) => {
        let onlineOnly = false;
        const builder = {
          select: vi.fn(() => builder),
          or: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          neq: vi.fn(() => builder),
          gte: vi.fn(() => {
            onlineOnly = true;
            return builder;
          }),
          in: vi.fn(() => builder),
          not: vi.fn(() => builder),
          order: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          range: vi.fn(async () => ({
            data: table === "user_directory" ? directoryRows : [],
            error: null,
            count: directoryRows.length,
          })),
          then: (resolve: (value: { data: unknown[]; error: null; count: number }) => unknown) =>
            Promise.resolve({
              data:
                table === "profiles"
                  ? (onlineOnly ? directoryRows.slice(0, 2) : directoryRows).map(
                      ({ id, username, email }) => ({
                        id,
                        username,
                        email,
                        daily_cap_override_usd: null,
                        weekly_cap_override_usd: null,
                      }),
                    )
                  : [],
              error: null,
              count: onlineOnly ? 2 : 8,
            }).then(resolve),
        };
        return builder;
      }),
    } as never);

    const element = await UsersPage({ searchParams: Promise.resolve({}) });
    render(element);

    // Totals cover all accounts, not just the three rows on this page.
    const activity = screen.getByRole("region", { name: "User presence" });
    expect(within(activity).getByText("2 online")).toBeTruthy();
    expect(within(activity).getByText("of 8")).toBeTruthy();
    expect(within(activity).getByText("6 offline")).toBeTruthy();
    expect(within(activity).getByRole("img", { name: "2 of 8 users online" })).toBeTruthy();
    expect(within(activity).getByTitle("editor_one")).toBeTruthy();

    const editorLink = screen.getByRole("link", {
      name: /view creations for editor@example\.com/i,
    });
    expect(editorLink.getAttribute("href")).toBe("/users/editor-1/creations");

    const trustedLink = screen.getByRole("link", {
      name: /view creations for trusted@example\.com/i,
    });
    expect(trustedLink.getAttribute("href")).toBe("/users/trusted-1/creations");

    expect(
      screen.queryByRole("link", { name: /view creations for admin@example\.com/i }),
    ).toBeNull();
    expect(screen.getByTestId("user-row-actions-admin-1").getAttribute("data-allowance-only")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("user-row-actions-editor-1").getAttribute("data-allowance-only"),
    ).toBe("false");
  });
});

describe("UserPresenceStrip", () => {
  it("shows at most six named avatars and the remaining online count", () => {
    const users = Array.from({ length: 11 }, (_, index) => ({
      id: String(index),
      username: `editor_${index}`,
      email: `editor${index}@example.com`,
    }));
    render(<UserPresenceStrip total={45} online={11} users={users} />);
    expect(screen.getAllByTitle(/^editor_/)).toHaveLength(6);
    expect(screen.getByText("+5")).toBeTruthy();
    expect(screen.getByRole("img", { name: "11 of 45 users online" })).toBeTruthy();
  });

  it("shows the empty state and an empty bar when nobody is online", () => {
    render(<UserPresenceStrip total={0} online={0} users={[]} />);
    expect(screen.getByText("Nobody online right now")).toBeTruthy();
    const bar = screen.getByRole("img", { name: "0 of 0 users online" });
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("0%");
  });

  it("keeps failed counts unavailable instead of displaying zero", () => {
    render(<UserPresenceStrip total={null} online={null} users={[]} />);
    expect(screen.getByText("User activity is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
