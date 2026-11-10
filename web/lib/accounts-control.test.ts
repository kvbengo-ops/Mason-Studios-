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
});

describe("mergeAccountSpendRanking", () => {
  it("includes admins and orders accounts by range spend then all-time spend", () => {
    const directory: AccountControlDirectoryRow[] = [
      {
        id: "admin-1",
        email: "admin@example.com",
        username: "admin",
        role: "admin",
        status: "active",
        created_at: "2026-10-01T00:00:00Z",
        project_count: 1,
        spend_usd: 50,
      },
      {
        id: "ed-1",
        email: "ed1@example.com",
        username: "alice",
        role: "editor",
        status: "active",
        created_at: "2026-10-01T00:00:00Z",
        project_count: 2,
        spend_usd: 10,
      },
      {
        id: "ed-2",
        email: "ed2@example.com",
        username: "bob",
        role: "trusted_editor",
        status: "active",
        created_at: "2026-10-01T00:00:00Z",
        project_count: 5,
        spend_usd: 8,
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
      project_count: 0,
      spend_usd: 0,
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
