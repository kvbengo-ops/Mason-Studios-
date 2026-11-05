import { describe, expect, it } from "vitest";
import { preserveTalkingHead } from "./talking-head";

describe("preserveTalkingHead", () => {
  it("keeps the original's is_talking_head when the generated value agrees", () => {
    const result = preserveTalkingHead(
      { is_talking_head: true },
      { is_talking_head: true, video_prompt: "a prompt", duration_s: 8 },
    );
    expect(result.is_talking_head).toBe(true);
  });

  it("overrides a generated true back to the operator's existing false", () => {
    // The exact shape of the MOCK_CLAUDE=1 bug: mockScene() always returns
    // is_talking_head: true, which must never be allowed to flip a B-roll
    // scene to A-roll on a plain Apply.
    const result = preserveTalkingHead(
      { is_talking_head: false },
      { is_talking_head: true, video_prompt: "a prompt", duration_s: 8 },
    );
    expect(result.is_talking_head).toBe(false);
  });

  it("overrides a generated false back to the operator's existing true", () => {
    const result = preserveTalkingHead(
      { is_talking_head: true },
      { is_talking_head: false, video_prompt: "a prompt", duration_s: 8 },
    );
    expect(result.is_talking_head).toBe(true);
  });

  it("leaves every other field on the generated scene untouched", () => {
    const generated = { is_talking_head: true, video_prompt: "a prompt", duration_s: 12 };
    const result = preserveTalkingHead({ is_talking_head: false }, generated);
    expect(result.video_prompt).toBe("a prompt");
    expect(result.duration_s).toBe(12);
  });
});
