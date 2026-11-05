import { describe, expect, it } from "vitest";
import { DEFAULT_DIRECTION, DirectionSchema } from "./direction";

describe("DirectionSchema", () => {
  it("fills in the column defaults for an empty submission", () => {
    const parsed = DirectionSchema.parse({});
    expect(parsed).toEqual(DEFAULT_DIRECTION);
  });

  it("accepts a fully populated direction", () => {
    const parsed = DirectionSchema.parse({
      shooting_mode: "mirror",
      camera_movement: false,
      visual_idea: "Lock the camera position completely.",
      voice_profile: "warm, inspiring",
      pronunciation_guide: "Seranova → seh-rah-NOH-vah",
      ugc_style: "testimonial",
    });
    expect(parsed.shooting_mode).toBe("mirror");
    expect(parsed.visual_idea).toBe("Lock the camera position completely.");
    expect(parsed.ugc_style).toBe("testimonial");
  });

  it("refuses a shooting_mode outside the wizard's own vocabulary", () => {
    // Not a vendor enum (see 0013_project_direction.sql) — this is OUR
    // vocabulary, so an unrecognized value is a bug (typo, stale client),
    // not a value a future integration is expected to add.
    expect(() => DirectionSchema.parse({ shooting_mode: "handheld" })).toThrow();
  });

  it("refuses a ugc_style outside the wizard's own vocabulary", () => {
    expect(() => DirectionSchema.parse({ ugc_style: "viral" })).toThrow();
  });

  it("trims whitespace-only free text down to the empty-string default", () => {
    const parsed = DirectionSchema.parse({ visual_idea: "   " });
    expect(parsed.visual_idea).toBe("");
  });

  // The control that sets camera_movement is not rendered in the UI unless
  // shooting_mode is static (spec §3.1: "conditional on Static mode; not
  // rendered under Selfie"). This is the one rule DirectionSchema itself
  // enforces rather than leaving to the UI, so a stray `true` left over
  // from switching shooting_mode client-side can never reach the compiler.
  it("normalizes camera_movement to false when shooting_mode is not static", () => {
    const parsed = DirectionSchema.parse({
      shooting_mode: "selfie",
      camera_movement: true,
    });
    expect(parsed.camera_movement).toBe(false);
  });

  it("keeps camera_movement true when shooting_mode is static", () => {
    const parsed = DirectionSchema.parse({
      shooting_mode: "static",
      camera_movement: true,
    });
    expect(parsed.camera_movement).toBe(true);
  });

  it("normalizes camera_movement to false under mirror too", () => {
    const parsed = DirectionSchema.parse({
      shooting_mode: "mirror",
      camera_movement: true,
    });
    expect(parsed.camera_movement).toBe(false);
  });

  // Spec §3.3: "Include Visual Idea" is checked by default — the one
  // boolean on this schema whose default is true rather than false, since
  // an absent FormData entry (a checkbox the operator never touched) must
  // read the same as "still checked," not "turned off."
  it("defaults include_visual_idea to true, unlike every other boolean here", () => {
    const parsed = DirectionSchema.parse({});
    expect(parsed.include_visual_idea).toBe(true);
  });

  it("respects an explicit include_visual_idea: false", () => {
    const parsed = DirectionSchema.parse({ include_visual_idea: false });
    expect(parsed.include_visual_idea).toBe(false);
  });
});
