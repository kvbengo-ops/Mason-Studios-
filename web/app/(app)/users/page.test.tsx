// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import UsersPage from "./page";
import { createClient } from "@/lib/supabase/server";
import { manilaDayKey, spendDay } from "@/lib/burn";

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

vi.mock("@/lib/sidebar-budget", () => ({
  getDecidableRequestCount: vi.fn(async () => 0),
}));

vi.mock("@/lib/kie-balance", () => ({
  getKieAccountBalanceUsd: vi.fn(async () => null),
}));

vi.mock("@/lib/byteplus-balance", () => ({
  getBytePlusBalanceUsd: vi.fn(async () => null),
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
        burn_usd: 10,
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
      // spend_daily_by_user: editor-1 spent $70 today, nobody else spent anything.
      rpc: vi.fn(async () => ({
        data: [{ user_id: "editor-1", day: manilaDayKey(spendDay(new Date())), total_usd: 70 }],
        error: null,
      })),
      from: vi.fn((table: string) => {
        const builder = {
          select: vi.fn(() => builder),
          or: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          neq: vi.fn(() => builder),
          gte: vi.fn(() => builder),
          in: vi.fn(() => builder),
          not: vi.fn(() => builder),
          order: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          range: vi.fn(async () => ({
            data: table === "user_directory_burn" ? directoryRows : [],
            error: null,
            count: directoryRows.length,
          })),
          then: (resolve: (value: { data: unknown[]; error: null; count: number }) => unknown) =>
            Promise.resolve({
              data:
                table === "profiles"
                  ? directoryRows.map(({ id, username, email, role, status }, index) => ({
                      id,
                      username,
                      email,
                      role,
                      status,
                      avatar_storage_key: null,
                      // The first two were seen just now: online.
                      last_seen_at: index < 2 ? new Date().toISOString() : null,
                      daily_cap_override_usd: null,
                      weekly_cap_override_usd: null,
                    }))
                  : [],
              error: null,
              count: 0,
            }).then(resolve),
        };
        return builder;
      }),
    } as never);

    const element = await UsersPage({ searchParams: Promise.resolve({}) });
    render(element);

    // Online now counts the whole (non-archived) team, with its avatar stack.
    const overview = screen.getByRole("region", { name: "Team overview" });
    const online = within(overview).getByRole("link", { name: /Online now/ });
    expect(online.textContent).toContain("2 of 3");
    expect(online.getAttribute("href")).toBe("/users?filter=online");
    expect(within(online).getByTitle("editor_one")).toBeTruthy();
    expect(screen.getByText("Nothing needs attention.")).toBeTruthy();

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

  it("shows a Burn cell for an account with spend and a dash for one without", async () => {
    const row = (id: string, burn: number): Record<string, unknown> => ({
      id,
      email: `${id}@example.com`,
      username: id,
      role: "editor",
      created_at: "2026-10-30T00:00:00Z",
      project_count: 0,
      spend_usd: 0,
      burn_usd: burn,
      status: "active",
    });
    const rows = [row("editor-1", 10), row("editor-2", 0)];
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(async () => ({
        data: [{ user_id: "editor-1", day: manilaDayKey(spendDay(new Date())), total_usd: 70 }],
        error: null,
      })),
      from: vi.fn((table: string) => {
        const builder = {
          select: vi.fn(() => builder),
          or: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          neq: vi.fn(() => builder),
          gte: vi.fn(() => builder),
          in: vi.fn(() => builder),
          order: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          range: vi.fn(async () => ({
            data: table === "user_directory_burn" ? rows : [],
            error: null,
            count: rows.length,
          })),
          then: (resolve: (value: { data: unknown[]; error: null; count: number }) => unknown) =>
            Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
        };
        return builder;
      }),
    } as never);

    render(await UsersPage({ searchParams: Promise.resolve({ sort: "burn", dir: "desc" }) }));

    expect(screen.getByRole("columnheader", { name: "Burn" })).toBeTruthy();
    // $70 over 7 days.
    expect(screen.getByText("$10.00/day")).toBeTruthy();
    // One sparkline for the row; the team chart is the 14-day area chart.
    expect(screen.getAllByRole("img", { name: /^Daily spend/ })).toHaveLength(1);
    expect(screen.getByRole("img", { name: /^Team daily spend, last 14 days/ })).toBeTruthy();
    // The same rpc row is today's team spend: $70 this week, nothing last week.
    const spent = screen.getByRole("link", { name: /Spent this week/ });
    expect(spent.textContent).toContain("$70.00 vs same days last week");
  });
});

describe("UsersPage filters", () => {
  // Records every call made on the user_directory_burn query.
  function mockClient(): { directoryCalls: [string, unknown[]][] } {
    const directoryCalls: [string, unknown[]][] = [];
    const rows = [
      {
        id: "editor-1",
        email: "editor@example.com",
        username: "editor_one",
        role: "editor",
        created_at: "2026-10-30T00:00:00Z",
        project_count: 0,
        spend_usd: 70,
        burn_usd: 10,
        status: "active",
      },
    ];
    const profile = (id: string, username: string, email: string): Record<string, unknown> => ({
      id,
      username,
      email,
      role: "editor",
      status: "active",
      avatar_storage_key: null,
      last_seen_at: null,
      daily_cap_override_usd: null,
      weekly_cap_override_usd: 50,
    });
    vi.mocked(createClient).mockResolvedValue({
      rpc: vi.fn(async () => ({ data: [], error: null })),
      from: vi.fn((table: string) => {
        const builder: Record<string, unknown> = {};
        const record =
          (name: string) =>
          (...args: unknown[]): unknown => {
            if (table === "user_directory_burn") directoryCalls.push([name, args]);
            return builder;
          };
        for (const name of ["select", "or", "eq", "neq", "gte", "in", "not", "order", "limit"]) {
          builder[name] = vi.fn(record(name));
        }
        builder.range = vi.fn(async () => ({ data: rows, error: null, count: rows.length }));
        builder.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data:
              table === "profiles"
                ? [
                    profile("editor-1", "editor_one", "editor@example.com"),
                    profile("editor-2", "editor_two", "two@example.com"),
                  ]
                : table === "account_spend_windows"
                  ? [
                      // 80% of a $50 cap is $40: editor-1 is near, editor-2 is not.
                      { user_id: "editor-1", spent_today_usd: 0, spent_this_week_usd: 40 },
                      { user_id: "editor-2", spent_today_usd: 0, spent_this_week_usd: 39.99 },
                    ]
                  : [],
            error: null,
            count: 0,
          }).then(resolve);
        return builder;
      }),
    } as never);
    return { directoryCalls };
  }

  it("near-cap narrows the table to accounts at 80%+ of weekly cap + grants", async () => {
    const { directoryCalls } = mockClient();
    render(await UsersPage({ searchParams: Promise.resolve({ filter: "near-cap", q: "ed" }) }));
    expect(directoryCalls).toContainEqual(["in", ["id", ["editor-1"]]]);
    // Search still applies alongside the filter.
    expect(directoryCalls.some(([name]) => name === "or")).toBe(true);
    const tile = screen.getByRole("link", { name: /Near weekly cap/ });
    expect(tile.textContent).toContain("1");
    expect(tile.getAttribute("aria-current")).toBe("true");
    // Clicking the active tile clears the filter but keeps the search.
    expect(tile.getAttribute("href")).toBe("/users?q=ed");
    expect(screen.getByRole("link", { name: "Clear filter" }).getAttribute("href")).toBe(
      "/users?q=ed",
    );
  });

  it("pending filters on status, and tile links keep sort and size", async () => {
    const { directoryCalls } = mockClient();
    render(await UsersPage({ searchParams: Promise.resolve({ filter: "pending", size: "50" }) }));
    expect(directoryCalls).toContainEqual(["eq", ["status", "pending"]]);
    expect(screen.getByRole("link", { name: /Online now/ }).getAttribute("href")).toBe(
      "/users?filter=online&size=50",
    );
  });
});
