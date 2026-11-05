import { describe, expect, it } from "vitest";
import { ugcTierLabel } from "./ugc-tier-label";

describe("ugcTierLabel", () => {
  it("shows Kling's std tier (the real 720p) as 480p — the 2026-09-10 operator decision", () => {
    expect(ugcTierLabel("kling-3.0-pro", "720p")).toBe("480p");
  });

  it("shows Kling's pro tier honestly, as 1080p", () => {
    expect(ugcTierLabel("kling-3.0-pro", "1080p")).toBe("1080p");
  });

  it("shows Seedance's 480p honestly — nothing to relabel", () => {
    expect(ugcTierLabel("seedance-2.5", "480p")).toBe("480p");
    expect(ugcTierLabel("seedance-2", "480p")).toBe("480p");
    expect(ugcTierLabel("seedance-2-fast", "480p")).toBe("480p");
  });

  it("shows any other model at 720p honestly — the relabel is Kling-specific, not a blanket 720p->480p rule", () => {
    expect(ugcTierLabel("seedance-2.5", "720p")).toBe("720p");
    expect(ugcTierLabel("seedance-2", "720p")).toBe("720p");
    expect(ugcTierLabel("hailuo-2.3-pro", "720p")).toBe("720p");
  });
});
