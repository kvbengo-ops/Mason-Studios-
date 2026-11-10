// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { manilaDayKeys } from "@/lib/burn";
import { TeamBurnStrip } from "./team-burn-strip";

afterEach(cleanup);

// Wednesday 12:00 Manila: three days into the week, four to go.
const WED = new Date("2026-11-11T04:00:00Z");
const DATES = manilaDayKeys(WED, 7);

describe("TeamBurnStrip", () => {
  it("states the week so far, the daily average and the projection", () => {
    render(<TeamBurnStrip dates={DATES} days={[10, 10, 10, 10, 10, 10, 10]} now={WED} />);
    // Mon-Wed = $30; avg $70 / 7 = $10; 30 + 10 x 4 days left = $70.
    expect(screen.getByText("$30.00 this week")).toBeTruthy();
    expect(screen.getByText(/\$10\.00\/day avg/)).toBeTruthy();
    expect(screen.getByText(/on pace for \$70\.00 by Sunday/)).toBeTruthy();
  });

  it("links the whole strip to Accounts Control", () => {
    render(<TeamBurnStrip dates={DATES} days={[0, 0, 0, 0, 5, 5, 5]} now={WED} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/accounts-control");
    expect(link.contains(screen.getByRole("img", { name: /^Daily spend/ }))).toBe(true);
  });

  it("draws one bar per day", () => {
    const { container } = render(
      <TeamBurnStrip dates={DATES} days={[1, 2, 3, 4, 5, 6, 7]} now={WED} />,
    );
    expect(container.querySelectorAll("rect")).toHaveLength(7);
  });

  it("says unavailable, not $0, when the read failed", () => {
    render(<TeamBurnStrip dates={DATES} days={null} now={WED} />);
    expect(screen.getByText("Team spend is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
