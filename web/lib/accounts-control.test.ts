import { describe, expect, it } from "vitest";
import {
  buildDailySpendSeries,
  buildModelUsage,
  mergeAccountSpendRanking,
  parseWindowDays,
  type AccountControlDirectoryRow,
} from "./accounts-control";

describe("buildDailySpendSeries", () => {
  it("buckets runs into renderUsd (scene_id present) and iterateUsd (scene_id null) across the window", () => {
    const now = new Date("2026-10-31T15:00:00.000Z");
    const series = buildDailySpendSeries(
      [
        { created_at: "2026-10-30T10:00:00.000Z", cost_usd: 0.56, scene_id: "scene-1" },
        { created_at: "2026-10-30T12:00:00.000Z", cost_usd: 0.04, scene_id: null },
        { created_at: "2026-10-31T08:00:00.000Z", cost_usd: 1.12, scene_id: "scene-2" },
      ],
      7,
      now,
    );

    expect(series).toHaveLength(7);
    const oct30 = series.find((d) => d.date === "2026-10-30");
    const oct31 = series.find((d) => d.date === "2026-10-31");
    expect(oct30?.renderUsd).toBeCloseTo(0.56, 5);
    expect(oct30?.iterateUsd).toBeCloseTo(0.04, 5);
    expect(oct30?.totalUsd).toBeCloseTo(0.6, 5);
    expect(oct31?.renderUsd).toBeCloseTo(1.12, 5);
    expect(oct31?.iterateUsd).toBe(0);
  });

  it("buckets by the 05:00 Manila spend day the caps reset on (0138)", () => {
    // 2026-11-01 06:00 Manila (22:00 UTC Oct 31): spend day Nov 1 is open.
    const now = new Date("2026-10-31T22:00:00.000Z");
    const series = buildDailySpendSeries(
      [
        { created_at: "2026-10-31T21:30:00.000Z", cost_usd: 2, scene_id: "s" }, // Nov 1 05:30: Nov 1
        { created_at: "2026-10-31T19:00:00.000Z", cost_usd: 1, scene_id: "s" }, // Nov 1 03:00: still Oct 31
        { created_at: "2026-10-30T22:00:00.000Z", cost_usd: 4, scene_id: "s" }, // Oct 31 06:00: Oct 31
      ],
      7,
      now,
    );
    expect(series.at(-1)).toMatchObject({ date: "2026-11-01", label: "Nov 1", totalUsd: 2 });
    expect(series.find((d) => d.date === "2026-10-31")?.totalUsd).toBe(5);
    expect(series[0]?.date).toBe("2026-10-26");
  });

  it("before 05:00 the open spend day is still yesterday's", () => {
    // 2026-11-12 04:00 Manila (20:00 UTC Nov 11).
    const series = buildDailySpendSeries([], 7, new Date("2026-11-11T20:00:00.000Z"));
    expect(series.at(-1)?.date).toBe("2026-11-11");
  });
});

describe("mergeAccountSpendRanking", () => {
  it("includes admins and orders accounts by range spend then username", () => {
    const directory: AccountControlDirectoryRow[] = [
      {
        id: "admin-1",
        email: "admin@example.com",
        username: "admin",
        role: "admin",
        status: "active",
        created_at: "2026-10-01T00:00:00Z",
        last_seen_at: null,
        avatar_storage_key: null,
      },
      {
        id: "ed-1",
        email: "ed1@example.com",
        username: "alice",
        role: "editor",
        status: "active",
        created_at: "2026-10-01T00:00:00Z",
        last_seen_at: null,
        avatar_storage_key: null,
      },
      {
        id: "ed-2",
        email: "ed2@example.com",
        username: "bob",
        role: "trusted_editor",
        status: "active",
        created_at: "2026-10-01T00:00:00Z",
        last_seen_at: null,
        avatar_storage_key: null,
      },
    ];

    const ranked = mergeAccountSpendRanking(directory, [
      { userId: "admin-1", email: "admin@example.com", iterateUsd: 0, renderUsd: 2, totalUsd: 2 },
      { userId: "ed-2", email: "ed2@example.com", iterateUsd: 0.5, renderUsd: 3.5, totalUsd: 4.0 },
      { userId: "ed-1", email: "ed1@example.com", iterateUsd: 0.2, renderUsd: 1.0, totalUsd: 1.2 },
    ]);

    expect(ranked.map((r) => r.id)).toEqual(["ed-2", "admin-1", "ed-1"]);
    expect(ranked[0]?.rangeRenderUsd).toBe(3.5);
    expect(ranked[0]?.rangeIterateUsd).toBe(0.5);
  });
});

describe("mergeAccountSpendRanking keeps every role", () => {
  it("lists Hybrid Editors and AI Animators, so their runs get a name", () => {
    const row = (
      id: string,
      role: AccountControlDirectoryRow["role"],
    ): AccountControlDirectoryRow => ({
      id,
      email: `${id}@example.com`,
      username: id,
      role,
      status: "active",
      created_at: "2026-10-01T00:00:00Z",
      last_seen_at: null,
      avatar_storage_key: null,
    });
    const ranked = mergeAccountSpendRanking(
      [row("hybrid-1", "hybrid_editor"), row("animator-1", "ai_animator")],
      [],
    );
    expect(ranked.map((r) => r.email).sort()).toEqual([
      "animator-1@example.com",
      "hybrid-1@example.com",
    ]);
  });
});

describe("buildModelUsage", () => {
  it("labels runs by model, merges ids with one label, and ranks by run count", () => {
    const usage = buildModelUsage([
      { model: "kling-3.0/video", cost_usd: 0.5 },
      { model: "seedance-2.5", cost_usd: 0.56 },
      { model: "kling-3.0-pro", cost_usd: 0.5 },
      { model: "mystery-model", cost_usd: 0.1 },
    ]);

    expect(usage.map((u) => [u.label, u.runs])).toEqual([
      ["Kling 3.0", 2],
      ["Seedance 2.5", 1],
      ["mystery-model", 1],
    ]);
    expect(usage[0]?.costUsd).toBeCloseTo(1.0, 5);
  });
});

describe("parseWindowDays", () => {
  it("defaults to 14 days and accepts 7 or 30", () => {
    expect(parseWindowDays(undefined)).toBe(14);
    expect(parseWindowDays("7")).toBe(7);
    expect(parseWindowDays("30")).toBe(30);
    expect(parseWindowDays("99")).toBe(14);
  });
});

describe("Spend chart granularity", () => {
  it("buckets the last 24 Manila hours, ending with the current one", async () => {
    const { buildHourlySpendSeries } = await import("./accounts-control");
    // 2026-11-12 15:30 Manila = 07:30 UTC.
    const now = new Date("2026-11-12T07:30:00Z");
    const series = buildHourlySpendSeries(
      [
        { created_at: "2026-11-12T07:05:00Z", cost_usd: 2, scene_id: "s1" }, // 15:05 Manila
        { created_at: "2026-11-12T07:10:00Z", cost_usd: 0.5, scene_id: null }, // same hour, image
        { created_at: "2026-11-11T07:59:00Z", cost_usd: 9, scene_id: "s2" }, // 15:59 yesterday: outside
        { created_at: "2026-11-11T08:00:00Z", cost_usd: 1, scene_id: "s3" }, // 16:00 yesterday: first bucket
      ],
      now,
    );
    expect(series).toHaveLength(24);
    expect(series[0]).toMatchObject({ date: "2026-11-11T16", label: "4 PM", totalUsd: 1 });
    expect(series[23]).toMatchObject({
      date: "2026-11-12T15",
      label: "3 PM",
      renderUsd: 2,
      iterateUsd: 0.5,
      totalUsd: 2.5,
    });
    expect(series.reduce((sum, p) => sum + p.totalUsd, 0)).toBe(3.5);
  });

  it("splits the last 12 Manila months into [start, end) windows, oldest first", async () => {
    const { manilaMonthWindows } = await import("./accounts-control");
    const now = new Date("2026-11-12T07:30:00Z");
    const windows = manilaMonthWindows(now, 12);
    expect(windows).toHaveLength(12);
    expect(windows[11]).toMatchObject({ date: "2026-11", startIso: "2026-10-31T16:00:00.000Z" });
    expect(windows[0]).toMatchObject({ date: "2025-12", label: "Dec 25" });
    // Contiguous: each month ends where the next one starts.
    for (let i = 0; i < 11; i++) expect(windows[i]!.endIso).toBe(windows[i + 1]!.startIso);
  });

  it("reads the chart param, defaulting to daily", async () => {
    const { parseSpendGranularity } = await import("./accounts-control");
    expect(parseSpendGranularity("hourly")).toBe("hourly");
    expect(parseSpendGranularity(["monthly"])).toBe("monthly");
    expect(parseSpendGranularity("weekly")).toBe("daily");
    expect(parseSpendGranularity(undefined)).toBe("daily");
  });
});
