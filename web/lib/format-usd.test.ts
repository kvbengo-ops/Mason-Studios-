import { describe, expect, it } from "vitest";
import {
  CREDITS_PER_USD,
  USD_PER_CREDIT,
  creditsToUsd,
  estimatedGenerations,
  formatAllowanceAmount,
  formatCredits,
  formatDual,
  usdToCredits,
} from "./format-usd";

describe("credit display conversion", () => {
  it("pins one credit to half a cent", () => {
    expect(USD_PER_CREDIT).toBe(0.005);
    expect(CREDITS_PER_USD).toBe(200);
  });

  it("converts at the display boundary in both directions", () => {
    expect(usdToCredits(30)).toBe(6000);
    expect(creditsToUsd(6000)).toBe(30);
  });

  it("formats grouped whole credits without presenting them as a wallet", () => {
    expect(formatCredits(30)).toBe("6,000 cr");
    expect(formatAllowanceAmount(30, "credits")).toBe("6,000 cr");
    expect(formatAllowanceAmount(30, "usd")).toBe("$30.00");
    expect(formatDual(30)).toBe("6,000 cr ($30.00)");
    expect(formatAllowanceAmount(30, "dual")).toBe("6,000 cr ($30.00)");
  });
});

describe("generation estimates from weekly allowance", () => {
  it("rounds down and clamps exhausted allowance", () => {
    expect(estimatedGenerations(1.2, 0.56)).toBe(2);
    expect(estimatedGenerations(-0.1, 0.02)).toBe(0);
    expect(() => estimatedGenerations(1, 0)).toThrow("Generation cost must be positive");
  });
});
