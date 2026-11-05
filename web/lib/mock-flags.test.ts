import { afterEach, describe, expect, it, vi } from "vitest";
import { hasMockVideoEvidence, mockDelayMs } from "./mock-flags";

// isMockClaude/isMockFalImage used to live here — see lib/mode.test.ts for
// their replacement (mode()/isDev()/isProd()) and lib/mode.ts's header for
// why three independent per-vendor flags were collapsed into that one
// switch.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasMockVideoEvidence", () => {
  it("is false for an empty scene list", () => {
    expect(hasMockVideoEvidence([])).toBe(false);
  });

  it("is false when no scene has a kie_task_id yet", () => {
    expect(hasMockVideoEvidence([{ kie_task_id: null }])).toBe(false);
  });

  it("is false for a real fal request id", () => {
    expect(hasMockVideoEvidence([{ kie_task_id: "abcdef12-3456-7890" }])).toBe(false);
  });

  it("is true when any scene's kie_task_id carries the worker mock client's prefix", () => {
    expect(
      hasMockVideoEvidence([
        { kie_task_id: "abcdef12-3456-7890" },
        { kie_task_id: "mock-1700000000000-42" },
      ]),
    ).toBe(true);
  });
});

describe("mockDelayMs", () => {
  const original = process.env.MOCK_DELAY_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.MOCK_DELAY_MS;
    else process.env.MOCK_DELAY_MS = original;
  });

  it("defaults to 500ms when unset", () => {
    delete process.env.MOCK_DELAY_MS;
    expect(mockDelayMs()).toBe(500);
  });

  it("takes a set value", () => {
    process.env.MOCK_DELAY_MS = "30000";
    expect(mockDelayMs()).toBe(30_000);
  });

  it("caps at two minutes", () => {
    // An extra zero in a .env is otherwise a request that appears to hang
    // forever. The point is to make waiting observable, not indefinite.
    process.env.MOCK_DELAY_MS = "300000";
    expect(mockDelayMs()).toBe(120_000);
  });

  it("falls back to the default on junk, never to zero", () => {
    // A mock that returns instantly is the one shape guaranteed to hide the
    // bugs this exists to surface, so a typo must not produce it.
    for (const junk of ["", "   ", "abc", "-1", "NaN"]) {
      process.env.MOCK_DELAY_MS = junk;
      expect(mockDelayMs()).toBe(500);
    }
  });

  it("accepts an explicit zero, which is a choice rather than a typo", () => {
    process.env.MOCK_DELAY_MS = "0";
    expect(mockDelayMs()).toBe(0);
  });
});
