import { describe, expect, it } from "vitest";
import { byteplusResolutionRefusal, retargetRetiredModel } from "@/lib/ugc-model-rules";

describe("retargetRetiredModel", () => {
  it("moves Kie seedance-2.5 to BytePlus at 480p whatever resolution came with it", () => {
    expect(retargetRetiredModel("seedance-2.5", "1080p")).toEqual({
      modelId: "seedance-2.5-byteplus",
      resolution: "480p",
    });
  });

  it("leaves every other pair alone", () => {
    expect(retargetRetiredModel("kling-4.0", "720p")).toEqual({
      modelId: "kling-4.0",
      resolution: "720p",
    });
  });
});

describe("byteplusResolutionRefusal", () => {
  it("accepts 480p and refuses the rest, for BytePlus Seedance only", () => {
    expect(byteplusResolutionRefusal("seedance-2.5-byteplus", "480p")).toBeNull();
    expect(byteplusResolutionRefusal("seedance-2.5-byteplus", "720p")).toMatch(/480p only/);
    expect(byteplusResolutionRefusal("kling-4.0", "1080p")).toBeNull();
  });
});
