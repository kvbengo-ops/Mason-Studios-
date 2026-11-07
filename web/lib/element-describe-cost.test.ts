import { describe, expect, it } from "vitest";
import { elementDescribeEstimateUsd } from "./element-describe-cost";

describe("element description estimates", () => {
  it("prices each explicit description from the same estimate used by the spend guard", () => {
    expect(elementDescribeEstimateUsd("image")).toBe(0.001);
    expect(elementDescribeEstimateUsd("audio")).toBe(0.001);
    expect(elementDescribeEstimateUsd("video")).toBe(0.0002);
  });
});
