import { describe, expect, it } from "vitest";
import { supportsPromptOnlyVideo } from "./prompt-only-video";

describe("prompt-only video endpoints", () => {
  it.each([
    "seedance-2.5",
    "seedance-2",
    "seedance-2-fast",
    "seedance-2-mini",
    "kling-3.0-pro",
    "wan-3.0",
  ])("allows %s without images", (id) => expect(supportsPromptOnlyVideo(id)).toBe(true));
  it.each(["hailuo-2.3-pro", "gemini-omni-video", "kling-4.0", "unknown"])(
    "keeps the reference requirement for %s",
    (id) => expect(supportsPromptOnlyVideo(id)).toBe(false),
  );
});
