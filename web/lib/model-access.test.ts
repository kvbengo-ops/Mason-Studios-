import { describe, expect, it } from "vitest";
import { canUseVideoModel, isAssignableRole } from "@/lib/model-access";

describe("canUseVideoModel (owner's role table, 2026-11-09)", () => {
  it("lets a Hybrid Editor use every model except Wan 3.0", () => {
    expect(canUseVideoModel("hybrid_editor", "wan-3.0")).toBe(false);
    for (const id of ["seedance-2.5", "kling-4.0", "gemini-omni-video"]) {
      expect(canUseVideoModel("hybrid_editor", id), id).toBe(true);
    }
  });

  it("lets an AI Animator use every model, Wan 3.0 included", () => {
    expect(canUseVideoModel("ai_animator", "wan-3.0")).toBe(true);
    expect(canUseVideoModel("ai_animator", "kling-4.0")).toBe(true);
  });

  it("keeps Seedance 2.5 BytePlus to trusted editors and admins", () => {
    for (const role of ["trusted_editor", "admin"] as const) {
      expect(canUseVideoModel(role, "seedance-2.5-byteplus"), role).toBe(true);
    }
    for (const role of ["editor", "hybrid_editor", "ai_animator", null] as const) {
      expect(canUseVideoModel(role, "seedance-2.5-byteplus"), String(role)).toBe(false);
    }
    expect(canUseVideoModel("editor", "seedance-2.5"), "Seedance 2.5 · Kie stays open").toBe(true);
  });

  it("does not restrict models for the other roles", () => {
    for (const role of ["editor", "trusted_editor", "admin", null] as const) {
      expect(canUseVideoModel(role, "wan-3.0"), String(role)).toBe(true);
    }
  });
});

describe("isAssignableRole", () => {
  it("accepts the four non-admin roles and refuses admin or junk", () => {
    for (const role of ["editor", "trusted_editor", "hybrid_editor", "ai_animator"]) {
      expect(isAssignableRole(role), role).toBe(true);
    }
    expect(isAssignableRole("admin")).toBe(false);
    expect(isAssignableRole("team_lead")).toBe(false);
    expect(isAssignableRole(null)).toBe(false);
  });
});
