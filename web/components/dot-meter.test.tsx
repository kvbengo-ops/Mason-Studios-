// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DotMeter } from "./dot-meter";

afterEach(cleanup);

const fills = (): number[] =>
  Array.from(screen.getByRole("img").children).map((dot) =>
    Number(dot.getAttribute("data-fill")),
  );

describe("DotMeter", () => {
  it("lights the share of dots the ratio covers", () => {
    render(<DotMeter ratio={0.5} count={10} />);
    expect(fills()).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it("shows a fraction of a dot, not a rounded one", () => {
    render(<DotMeter ratio={0.73} count={10} />);
    expect(fills()).toEqual([1, 1, 1, 1, 1, 1, 1, 0.3, 0, 0]);
  });

  it("never reads as empty while something is left", () => {
    render(<DotMeter ratio={0.004} count={20} />);
    expect(fills()[0]).toBeGreaterThan(0);
  });

  it("is empty at zero and full at one, and clamps out-of-range ratios", () => {
    render(<DotMeter ratio={-1} count={4} />);
    expect(fills()).toEqual([0, 0, 0, 0]);
    cleanup();
    render(<DotMeter ratio={5} count={4} />);
    expect(fills()).toEqual([1, 1, 1, 1]);
    cleanup();
    render(<DotMeter ratio={Number.NaN} count={4} />);
    expect(fills()).toEqual([0, 0, 0, 0]);
  });

  it("says how much is left to a screen reader", () => {
    render(<DotMeter ratio={0.7} count={10} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("70% left");
  });
});
