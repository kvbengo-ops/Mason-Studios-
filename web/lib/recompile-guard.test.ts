import { describe, expect, it } from "vitest";
import { assertRecompilable } from "./recompile-guard";

describe("assertRecompilable", () => {
  it("allows an empty scene list", () => {
    expect(() => assertRecompilable([])).not.toThrow();
  });

  it("allows all scenes in draft", () => {
    expect(() =>
      assertRecompilable([{ status: "draft" }, { status: "draft" }]),
    ).not.toThrow();
  });

  it("allows a mix of draft and frame_ready", () => {
    expect(() =>
      assertRecompilable([{ status: "draft" }, { status: "frame_ready" }]),
    ).not.toThrow();
  });

  it("refuses when a scene is queued", () => {
    expect(() =>
      assertRecompilable([{ status: "draft" }, { status: "queued" }]),
    ).toThrow(/already started/i);
  });

  it("refuses when a scene is rendering", () => {
    expect(() => assertRecompilable([{ status: "rendering" }])).toThrow(/already started/i);
  });

  it("refuses when a scene is done", () => {
    expect(() => assertRecompilable([{ status: "done" }])).toThrow(/duplicate/i);
  });

  it("refuses when a scene is failed", () => {
    expect(() => assertRecompilable([{ status: "failed" }])).toThrow(/already started/i);
  });
});
