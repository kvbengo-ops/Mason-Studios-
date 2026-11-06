import { describe, expect, it } from "vitest";
import { estimatedGenerations, formatUsd } from "./format-usd";

describe("formatUsd", () => {
  it("shows dollars with cents and grouped thousands", () => {
    expect(formatUsd(30)).toBe("$30.00");
    expect(formatUsd(12345.678)).toBe("$12,345.68");
  });
});

describe("generation estimates from weekly allowance", () => {
  it("rounds down and clamps exhausted allowance", () => {
    expect(estimatedGenerations(1.2, 0.56)).toBe(2);
    expect(estimatedGenerations(-0.1, 0.02)).toBe(0);
    expect(() => estimatedGenerations(1, 0)).toThrow("Generation cost must be positive");
  });
});
