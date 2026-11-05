import { describe, expect, it } from "vitest";
import { APP_TIME_ZONE, dateFormatter, dateTimeFormatter, weekdayFormatter } from "@/lib/datetime";

describe("the app's clock is pinned, not inherited", () => {
  // THE BUG THIS REPLACES. Every formatter was built without a `timeZone`,
  // which resolves against the running process — UTC on Render for a server
  // component, the viewer's own zone in the browser. A project created at
  // 09:48 in Manila rendered as "1:45 AM" on the projects list while the
  // version picker, a client component, showed the right time. Same instant,
  // two screens, two answers.
  //
  // 2026-09-04T01:48:55Z is the real row that showed it: 09:48 in Manila.
  const instant = new Date("2026-09-04T01:48:55.000Z");

  it("formats a UTC instant in Manila time, not the process's", () => {
    expect(dateTimeFormatter.format(instant)).toBe("Sep 4, 2026, 9:48 AM");
  });

  it("keeps the date on the right side of midnight", () => {
    // 16:30Z is already the NEXT day in Manila, and a date-only format is
    // where that slip hides: it is wrong for eight hours either side of
    // midnight and looks right the rest of the day.
    expect(dateFormatter.format(new Date("2026-09-04T16:30:00.000Z"))).toBe("Sep 5, 2026");
  });

  it("names the weekday the operator is actually having", () => {
    // Still Friday in UTC, already Saturday in Manila — which is the whole
    // point for a grant that says "expires Sat".
    expect(weekdayFormatter.format(new Date("2026-09-04T16:30:00.000Z"))).toBe("Sat");
  });

  it("says which zone it is pinned to, so changing it is one line", () => {
    expect(APP_TIME_ZONE).toBe("Asia/Manila");
    for (const f of [dateTimeFormatter, dateFormatter, weekdayFormatter]) {
      expect(f.resolvedOptions().timeZone).toBe(APP_TIME_ZONE);
    }
  });
});
