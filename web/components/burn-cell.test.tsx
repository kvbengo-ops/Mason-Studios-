// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BurnCell, type UserBurn } from "./burn-cell";

afterEach(cleanup);

const DATES = [
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
];

function burn(pace: UserBurn["pace"], days = [0, 0, 5, 10, 20, 0, 35]): UserBurn {
  return { dates: DATES, days, avgPerDay: 10, pace };
}

describe("BurnCell", () => {
  it("shows an em dash and no chart when there is no spend", () => {
    render(<BurnCell burn={burn("none", [0, 0, 0, 0, 0, 0, 0])} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows an em dash when the read failed", () => {
    render(<BurnCell burn={null} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("draws seven bars and the average per day", () => {
    const { container } = render(<BurnCell burn={burn("normal")} />);
    expect(container.querySelectorAll("rect")).toHaveLength(7);
    expect(screen.getByText("$10.00/day")).toBeTruthy();
  });

  it("describes every day in the chart's aria-label", () => {
    render(<BurnCell burn={burn("normal")} />);
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toContain("Nov 5 $0.00");
    expect(label).toContain("Nov 11 $35.00");
  });

  it.each([
    ["normal", "text-muted-foreground"],
    ["amber", "text-warning"],
    ["red", "text-destructive"],
  ] as const)("colours a %s pace with %s", (pace, cls) => {
    render(<BurnCell burn={burn(pace)} />);
    expect(screen.getByRole("img").getAttribute("class")).toContain(cls);
  });
});
