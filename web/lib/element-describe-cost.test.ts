import { describe, expect, it } from "vitest";
import { elementDescribeEstimateUsd, uploadDescribeEstimateUsd } from "./element-describe-cost";

describe("element description estimates", () => {
  it("prices each upload type from the same estimate used by the spend guard", () => {
    expect(elementDescribeEstimateUsd("image")).toBe(0.015);
    expect(
      uploadDescribeEstimateUsd(new File(["voice"], "voice.mp3", { type: "audio/mpeg" })),
    ).toBe(0.001);
    expect(
      uploadDescribeEstimateUsd(new File(["clip"], "clip.mp4", { type: "video/mp4" })),
    ).toBe(0.0002);
  });
});
