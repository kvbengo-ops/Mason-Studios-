import { describe, expect, it } from "vitest";
import { byteplusResolutionRefusal } from "@/lib/ugc-model-rules";

describe("byteplusResolutionRefusal", () => {
  it("accepts 480p and refuses the rest, for BytePlus Seedance only", () => {
    expect(byteplusResolutionRefusal("seedance-2.5-byteplus", "480p")).toBeNull();
    expect(byteplusResolutionRefusal("seedance-2.5-byteplus", "720p")).toMatch(/480p only/);
    expect(byteplusResolutionRefusal("kling-4.0", "1080p")).toBeNull();
    // Kie Seedance 2.5 is its own choice, at its own tiers.
    expect(byteplusResolutionRefusal("seedance-2.5", "720p")).toBeNull();
  });
});
