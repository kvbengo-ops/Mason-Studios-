import { describe, expect, it } from "vitest";
import { geminiVoiceFor } from "./gemini-voices";

describe("geminiVoiceFor", () => {
  it("keeps a known preset on Gemini only", () => {
    expect(geminiVoiceFor("gemini-omni-video", "achernar")).toBe("achernar");
    expect(geminiVoiceFor("seedance-2.5", "achernar")).toBeUndefined();
  });

  it("drops unknown, capitalized, and missing voices", () => {
    expect(geminiVoiceFor("gemini-omni-video", "Achernar")).toBeUndefined();
    expect(geminiVoiceFor("gemini-omni-video", "c6SfcYrb2t09NHXiT80T")).toBeUndefined();
    expect(geminiVoiceFor("gemini-omni-video", null)).toBeUndefined();
  });
});
