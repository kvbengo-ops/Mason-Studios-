import { describe, expect, it } from "vitest";
import { canUseVideoModel, isTeam } from "@/lib/model-access";

describe("canUseVideoModel", () => {
  it("keeps Wan 3.0 from a Hybrid Editor and nothing else", () => {
    expect(canUseVideoModel("hybrid_editor", "wan-3.0")).toBe(false);
    for (const id of ["seedance-2.5-byteplus", "kling-4.0", "kling-4.0-reference", "gemini-omni-video"]) {
      expect(canUseVideoModel("hybrid_editor", id), id).toBe(true);
    }
  });

  it("gives an AI Animator every model", () => {
    expect(canUseVideoModel("ai_animator", "wan-3.0")).toBe(true);
    expect(canUseVideoModel("ai_animator", "kling-4.0")).toBe(true);
  });

  it("gives an account with no team every model, so nobody loses access on deploy", () => {
    expect(canUseVideoModel(null, "wan-3.0")).toBe(true);
    expect(canUseVideoModel(undefined, "wan-3.0")).toBe(true);
  });
});

describe("isTeam", () => {
  it("accepts the two teams and nothing else", () => {
    expect(isTeam("hybrid_editor")).toBe(true);
    expect(isTeam("ai_animator")).toBe(true);
    expect(isTeam("admin")).toBe(false);
    expect(isTeam(null)).toBe(false);
  });
});
