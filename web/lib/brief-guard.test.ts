import { describe, expect, it } from "vitest";
import { assertScenesComplete } from "./brief-guard";

describe("assertScenesComplete", () => {
  it("allows an empty scene list", () => {
    expect(() => assertScenesComplete([])).not.toThrow();
  });

  it("allows every scene having both a script line and a video prompt", () => {
    expect(() =>
      assertScenesComplete([
        { idx: 0, script_line: "Hey there", video_prompt: "Close up, product in hand" },
        { idx: 1, script_line: "Buy now", video_prompt: "Wide shot, smiling" },
      ]),
    ).not.toThrow();
  });

  // The motivating case: addScene leaves a scene with script_line/video_prompt
  // both set to "" (not null), and it stays editable — the old approveBrief
  // only checked scene status, so this survived approval and only failed
  // later at the render gate.
  it("refuses a scene with an empty (not null) video prompt", () => {
    expect(() =>
      assertScenesComplete([{ idx: 0, script_line: "Hey there", video_prompt: "" }]),
    ).toThrow(/scene 1/i);
  });

  it("refuses a scene with a null script line", () => {
    expect(() =>
      assertScenesComplete([{ idx: 0, script_line: null, video_prompt: "Close up" }]),
    ).toThrow(/scene 1/i);
  });

  it("names 1-based scene numbers, matching what the Scene table shows", () => {
    expect(() =>
      assertScenesComplete([
        { idx: 0, script_line: "ok", video_prompt: "ok" },
        { idx: 1, script_line: "", video_prompt: "" },
      ]),
    ).toThrow(/scene 2/i);
  });

  it("names every offending scene once, so one message covers the batch", () => {
    expect(() =>
      assertScenesComplete([
        { idx: 0, script_line: "", video_prompt: "" },
        { idx: 1, script_line: "ok", video_prompt: "ok" },
        { idx: 2, script_line: "ok", video_prompt: "" },
      ]),
    ).toThrow(/scenes 1, 3/i);
  });
});
