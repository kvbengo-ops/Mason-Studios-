import { describe, expect, it } from "vitest";
import {
  computeBurn,
  fillDays,
  manilaDayKey,
  manilaDayKeys,
  manilaWeekPosition,
  manilaWindowEndIso,
  manilaWindowStartIso,
  weekdayLabel,
} from "./burn";

// Wednesday 12:00 Manila. Week = Mon Nov 9 .. Sun Nov 15, so 4 days left.
const WED = new Date("2026-11-11T04:00:00Z");

describe("Manila day boundaries", () => {
  it("rolls the day at 16:00 UTC, not at UTC midnight", () => {
    expect(manilaDayKey(new Date("2026-11-10T15:59:59Z"))).toBe("2026-11-10");
    expect(manilaDayKey(new Date("2026-11-10T16:00:00Z"))).toBe("2026-11-11");
    // UTC date is still the 10th, Manila is already the 11th.
    expect(manilaDayKey(new Date("2026-11-10T20:00:00Z"))).toBe("2026-11-11");
  });

  it("lists the last N days oldest first, ending today", () => {
    expect(manilaDayKeys(WED, 3)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
    expect(manilaDayKeys(WED, 7)[0]).toBe("2026-11-05");
  });

  it("windows start and end on Manila midnight", () => {
    expect(manilaWindowStartIso(WED, 7)).toBe("2026-11-04T16:00:00.000Z");
    expect(manilaWindowEndIso(WED)).toBe("2026-11-11T16:00:00.000Z");
  });

  it("puts Monday 00:00 Manila in the new week and the second before in the old one", () => {
    const monday = manilaWeekPosition(new Date("2026-11-08T16:00:00Z"));
    expect(monday).toEqual({ weekStartKey: "2026-11-09", dayOfWeek: 1, daysLeft: 6 });
    const sunday = manilaWeekPosition(new Date("2026-11-08T15:59:59Z"));
    expect(sunday).toEqual({ weekStartKey: "2026-11-02", dayOfWeek: 7, daysLeft: 0 });
    expect(manilaWeekPosition(WED)).toEqual({
      weekStartKey: "2026-11-09",
      dayOfWeek: 3,
      daysLeft: 4,
    });
  });

  it("zero-fills days with no spend", () => {
    const keys = manilaDayKeys(WED, 3);
    expect(fillDays([{ day: "2026-11-10", total_usd: 4 }], keys)).toEqual([0, 4, 0]);
  });
});

describe("computeBurn", () => {
  const week = (usd: number): number[] => [0, 0, 0, 0, 0, 0, usd];

  it("is 'none' with no spend at all", () => {
    expect(computeBurn({ days: week(0), weekSpentUsd: 0, weekTotalUsd: 100, now: WED })).toEqual({
      avgPerDay: 0,
      projectedWeekUsd: 0,
      reachKey: null,
      pace: "none",
    });
  });

  it("averages over the whole window", () => {
    const { avgPerDay } = computeBurn({
      days: [10, 10, 10, 10, 10, 10, 10],
      weekSpentUsd: 30,
      weekTotalUsd: 700,
      now: WED,
    });
    expect(avgPerDay).toBe(10);
  });

  it("is red when this week's spend is exactly the weekly total", () => {
    const burn = computeBurn({
      days: [10, 10, 10, 10, 10, 10, 10],
      weekSpentUsd: 100,
      weekTotalUsd: 100,
      now: WED,
    });
    expect(burn.pace).toBe("red");
    expect(burn.reachKey).toBe("2026-11-11");
  });

  it("is red when over the weekly total", () => {
    expect(
      computeBurn({ days: week(5), weekSpentUsd: 120, weekTotalUsd: 100, now: WED }).pace,
    ).toBe("red");
  });

  it("is red for any spend against a zero weekly total", () => {
    expect(computeBurn({ days: week(5), weekSpentUsd: 5, weekTotalUsd: 0, now: WED }).pace).toBe(
      "red",
    );
  });

  it("is normal when the projection lands exactly on the total", () => {
    // 60 so far + 10/day x 4 days left = 100.
    const burn = computeBurn({
      days: [10, 10, 10, 10, 10, 10, 10],
      weekSpentUsd: 60,
      weekTotalUsd: 100,
      now: WED,
    });
    expect(burn.projectedWeekUsd).toBe(100);
    expect(burn.pace).toBe("normal");
    expect(burn.reachKey).toBe("2026-11-15"); // lands on Sunday
  });

  it("is amber when the projection passes the total before Monday", () => {
    const burn = computeBurn({
      days: [10, 10, 10, 10, 10, 10, 10],
      weekSpentUsd: 60,
      weekTotalUsd: 90,
      now: WED,
    });
    expect(burn.pace).toBe("amber");
    expect(burn.reachKey).toBe("2026-11-14"); // ceil(30 / 10) = 3 days on
  });

  it("says 'not this week' when the total is out of reach", () => {
    const burn = computeBurn({
      days: [10, 10, 10, 10, 10, 10, 10],
      weekSpentUsd: 60,
      weekTotalUsd: 200,
      now: WED,
    });
    expect(burn.reachKey).toBeNull();
    expect(burn.pace).toBe("normal");
  });

  it("stays normal when the weekly total could not be resolved", () => {
    const burn = computeBurn({
      days: [10, 10, 10, 10, 10, 10, 10],
      weekSpentUsd: 60,
      weekTotalUsd: null,
      now: WED,
    });
    expect(burn.pace).toBe("normal");
    expect(burn.reachKey).toBeNull();
  });

  it("counts last week's spend in the average but not in this week's total", () => {
    // Tuesday: the window reaches back into last week. All $70 was spent then.
    const tuesday = new Date("2026-11-10T04:00:00Z");
    const burn = computeBurn({
      days: [70, 0, 0, 0, 0, 0, 0],
      weekSpentUsd: 0,
      weekTotalUsd: 100,
      now: tuesday,
    });
    expect(burn.avgPerDay).toBe(10);
    expect(burn.projectedWeekUsd).toBe(50); // 0 + 10 x 5 days left
    expect(burn.pace).toBe("normal");
  });

  it("projects nothing more on Sunday", () => {
    const sunday = new Date("2026-11-15T04:00:00Z");
    const burn = computeBurn({
      days: [10, 10, 10, 10, 10, 10, 10],
      weekSpentUsd: 80,
      weekTotalUsd: 100,
      now: sunday,
    });
    expect(burn.projectedWeekUsd).toBe(80);
    expect(burn.reachKey).toBeNull();
    expect(burn.pace).toBe("normal");
  });
});

describe("labels", () => {
  it("names the weekday of a Manila day key", () => {
    expect(weekdayLabel("2026-11-15")).toBe("Sun");
  });
});
