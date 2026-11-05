import { describe, expect, it } from "vitest";
import { readAppBannerConfig } from "./app-banner";

const configured = {
  APP_BANNER_ID: "model-launch-2026-09",
  APP_BANNER_TEXT: "New models unlocked: Kling 3.0 + Gemini Omni Video",
  APP_BANNER_CTA: "Create now",
  APP_BANNER_HREF: "/projects",
};

describe("readAppBannerConfig", () => {
  it("uses the id as the opt-in switch", () => {
    expect(readAppBannerConfig({ ...configured, APP_BANNER_ID: "" })).toBeNull();
  });

  it("returns a complete in-app announcement", () => {
    expect(readAppBannerConfig(configured)).toEqual({
      id: "model-launch-2026-09",
      text: "New models unlocked: Kling 3.0 + Gemini Omni Video",
      cta: "Create now",
      href: "/projects",
    });
  });

  it("hides partial or externally linked campaigns", () => {
    expect(readAppBannerConfig({ ...configured, APP_BANNER_CTA: "" })).toBeNull();
    expect(
      readAppBannerConfig({ ...configured, APP_BANNER_HREF: "https://example.com" }),
    ).toBeNull();
    expect(readAppBannerConfig({ ...configured, APP_BANNER_HREF: "//example.com" })).toBeNull();
    expect(readAppBannerConfig({ ...configured, APP_BANNER_HREF: "/\\example.com" })).toBeNull();
  });
});
