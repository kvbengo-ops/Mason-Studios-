// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AccountsControlPage from "./page";
import { createClient } from "@/lib/supabase/server";
import {
  loadAccountControlDeleted,
  loadAccountsControlOverview,
  parseWindowDays,
} from "@/lib/accounts-control";
import { loadEditorImages, loadEditorVideos } from "@/lib/admin-creations";
import { DEFAULT_GLOBAL_SPEND_CAP_USD } from "@/lib/spend";
import type { ProfileRole } from "@/types/db";
import type * as AccountsControlModule from "@/lib/accounts-control";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/actions/ugc", () => ({
  reapExpiredBinEntries: vi.fn(async () => undefined),
  purgeDeletedScene: vi.fn(async () => undefined),
  purgeDeletedVersion: vi.fn(async () => undefined),
}));

vi.mock("@/lib/accounts-control", async (importOriginal) => {
  const actual = await importOriginal<typeof AccountsControlModule>();
  return {
    ...actual,
    loadAccountsControlOverview: vi.fn(),
    loadAccountControlDeleted: vi.fn(),
    loadAccountsRunLog: vi.fn(async () => ({ rows: [], total: 0 })),
    parseWindowDays: actual.parseWindowDays,
  };
});

vi.mock("@/lib/anthropic-spend", () => ({
  getAnthropicMonthlySpend: vi.fn(async () => ({ status: "not_configured" })),
}));

vi.mock("@/lib/admin-creations", () => ({
  loadEditorVideos: vi.fn(),
  loadEditorImages: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  useRouter: () => ({ refresh: vi.fn() }),
}));

interface FakeProfile {
  id: string;
  email: string;
  username: string;
  role: ProfileRole;
  status: "active" | "pending" | "rejected" | "deactivated";
}

function fakeSupabaseForCaller(caller: FakeProfile) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: caller.id, email: caller.email } },
      })),
    },
    from: vi.fn((table: string) => {
      if (table !== "profiles") {
        throw new Error(`Unexpected table "${table}" in AccountsControlPage guard test`);
      }
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        single: vi.fn(async () => ({ data: caller, error: null })),
      };
      return builder;
    }),
  };
}

const ADMIN_CALLER: FakeProfile = {
  id: "admin-1",
  email: "admin@example.com",
  username: "admin_user",
  role: "admin",
  status: "active",
};

const EDITOR_CALLER: FakeProfile = {
  id: "editor-1",
  email: "editor@example.com",
  username: "maya_editor",
  role: "editor",
  status: "active",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AccountsControlPage", () => {
  it("refuses a non-admin caller via requireAdmin", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseForCaller(EDITOR_CALLER) as never);

    await expect(
      AccountsControlPage({
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(/not an admin/i);
  });

  it("opens on Spending, and shows the selected account's videos on the Accounts view", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseForCaller(ADMIN_CALLER) as never);
    vi.mocked(loadAccountsControlOverview).mockResolvedValue({
      windowDays: 14,
      todaySpendUsd: 2.5,
      teamGlobalSpendUsd: DEFAULT_GLOBAL_SPEND_CAP_USD + 5,
      globalSpendCap: { enabled: true, capUsd: DEFAULT_GLOBAL_SPEND_CAP_USD, period: "daily" },
      weekSpendUsd: 12.0,
      monthSpendUsd: 45.0,
      kieBalanceUsd: 60.0,
      runwayEstimate: { status: "ok", days: 35 },
      rangeCategoryTotals: {
        renderUsd: 10.0,
        iterateUsd: 2.0,
        totalUsd: 12.0,
      },
      modelUsage: [],
      dailySeries: [
        {
          date: "2026-10-30",
          label: "Oct 30",
          renderUsd: 1.5,
          iterateUsd: 0.5,
          totalUsd: 2.0,
        },
        {
          date: "2026-10-31",
          label: "Oct 31",
          renderUsd: 2.0,
          iterateUsd: 0.5,
          totalUsd: 2.5,
        },
      ],
      accounts: [
        {
          id: "editor-1",
          email: "editor@example.com",
          username: "maya_editor",
          role: "editor",
          status: "active",
          projectCount: 3,
          rangeRenderUsd: 10.0,
          rangeIterateUsd: 2.0,
          rangeTotalUsd: 12.0,
          allTimeSpendUsd: 30.0,
        },
      ],
    });
    vi.mocked(loadEditorVideos).mockResolvedValue({
      clips: [
        {
          key: "ver-1",
          versionId: "ver-1",
          sceneId: "scene-12345678",
          projectId: "proj-1",
          projectTitle: "Summer Campaign",
          personal: false,
          n: 1,
          prompt: "Skincare bottle on marble counter",
          modelLabel: "Seedance 2.5",
          durationS: 8,
          costUsd: 1.12,
          createdAt: "2026-10-31T10:00:00Z",
          url: "https://signed.example/clip-1.mp4?token=abc",
        },
      ],
      runs: [],
    });

    render(await AccountsControlPage({ searchParams: Promise.resolve({}) }));

    expect(parseWindowDays(undefined)).toBe(14);
    expect(screen.getByRole("heading", { name: "Accounts and Spending Control" })).toBeTruthy();
    const dailySpendBar = screen.getByRole("progressbar", {
      name: "Team spending toward daily global cap",
    });
    expect(dailySpendBar.getAttribute("aria-valuenow")).toBe(String(DEFAULT_GLOBAL_SPEND_CAP_USD));
    expect(dailySpendBar.getAttribute("aria-valuemax")).toBe(String(DEFAULT_GLOBAL_SPEND_CAP_USD));
    expect(screen.getByText("500 cr")).toBeTruthy(); // $2.50 today = 500 cr
    expect(loadEditorVideos).not.toHaveBeenCalled();
    cleanup();

    render(await AccountsControlPage({ searchParams: Promise.resolve({ view: "accounts" }) }));

    expect(screen.getAllByText("maya_editor").length).toBeGreaterThan(0);
    expect(screen.getByText("Skincare bottle on marble counter")).toBeTruthy();
    expect(screen.getByRole("link", { name: /download/i })).toBeTruthy();
  });

  it("renders the Deleted (2-Week Bin) tab with video preview, Download, and Delete permanently controls", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseForCaller(ADMIN_CALLER) as never);
    vi.mocked(loadAccountsControlOverview).mockResolvedValue({
      windowDays: 14,
      todaySpendUsd: 0,
      teamGlobalSpendUsd: 10.0,
      globalSpendCap: { enabled: true, capUsd: DEFAULT_GLOBAL_SPEND_CAP_USD, period: "daily" },
      weekSpendUsd: 5.0,
      monthSpendUsd: 15.0,
      kieBalanceUsd: 50.0,
      runwayEstimate: { status: "ok", days: 70 },
      rangeCategoryTotals: { renderUsd: 5.0, iterateUsd: 0, totalUsd: 5.0 },
      modelUsage: [],
      dailySeries: [],
      accounts: [
        {
          id: "editor-1",
          email: "editor@example.com",
          username: "maya_editor",
          role: "editor",
          status: "active",
          projectCount: 1,
          rangeRenderUsd: 5.0,
          rangeIterateUsd: 0,
          rangeTotalUsd: 5.0,
          allTimeSpendUsd: 15.0,
        },
      ],
    });
    vi.mocked(loadAccountControlDeleted).mockResolvedValue({
      scenes: [
        {
          sceneId: "del-scene-1",
          projectId: "proj-1",
          idx: 2,
          prompt: "Deleted scene preview prompt",
          modelLabel: "Seedance 2.5",
          deletedAt: "2026-10-30T10:00:00Z",
          expiresLabel: "13d left",
          versionCount: 2,
          thumbnail: {
            kind: "video",
            url: "https://signed.example/del-scene-1.mp4?token=xyz",
            posterUrl: null,
          },
          downloadUrl: "https://signed.example/del-scene-1.mp4?token=xyz",
          downloadFilename: "deleted-scene-02.mp4",
        },
      ],
      versions: [],
      images: [],
    });

    const element = await AccountsControlPage({
      searchParams: Promise.resolve({ view: "accounts", user: "editor-1", tab: "deleted" }),
    });
    render(element);

    expect(loadAccountControlDeleted).toHaveBeenCalledWith("editor-1");
    expect(screen.getByText("Deleted scene preview prompt")).toBeTruthy();
    expect(screen.getByText(/13d left/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /download/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete permanently/i })).toBeTruthy();
  });

  it("renders the Images tab with generated images and Download links", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabaseForCaller(ADMIN_CALLER) as never);
    vi.mocked(loadAccountsControlOverview).mockResolvedValue({
      windowDays: 14,
      todaySpendUsd: 0.04,
      teamGlobalSpendUsd: 3.0,
      globalSpendCap: { enabled: true, capUsd: DEFAULT_GLOBAL_SPEND_CAP_USD, period: "daily" },
      weekSpendUsd: 0.04,
      monthSpendUsd: 0.04,
      kieBalanceUsd: 50.0,
      runwayEstimate: { status: "ok", days: 70 },
      rangeCategoryTotals: { renderUsd: 0, iterateUsd: 0.04, totalUsd: 0.04 },
      modelUsage: [],
      dailySeries: [],
      accounts: [
        {
          id: "editor-1",
          email: "editor@example.com",
          username: "maya_editor",
          role: "editor",
          status: "active",
          projectCount: 1,
          rangeRenderUsd: 0,
          rangeIterateUsd: 0.04,
          rangeTotalUsd: 0.04,
          allTimeSpendUsd: 0.04,
        },
      ],
    });
    vi.mocked(loadEditorImages).mockResolvedValue({
      images: [
        {
          assetId: "img-asset-1",
          createdAt: "2026-10-31T08:00:00Z",
          url: "https://signed.example/img-1.jpg?token=abc",
          prompt: "Product bottle studio shot",
          modelLabel: "Nano Banana",
          costUsd: 0.04,
        },
      ],
      nextCursor: null,
    });

    const element = await AccountsControlPage({
      searchParams: Promise.resolve({ view: "accounts", user: "editor-1", tab: "images" }),
    });
    render(element);

    expect(loadEditorImages).toHaveBeenCalledWith("editor-1", null);
    expect(screen.getByText("Product bottle studio shot")).toBeTruthy();
    expect(screen.getByRole("link", { name: /download/i })).toBeTruthy();
  });
});
