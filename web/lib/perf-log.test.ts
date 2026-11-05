import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh module per test: isColdRender's per-route clock (lastSeenAtByRoute)
// is module-level state, and several assertions below depend on a route
// name being genuinely "never seen before" in this process.
async function freshPerfLog() {
  vi.resetModules();
  return import("./perf-log");
}

describe("isPerfLoggingEnabled", () => {
  const original = process.env.PERF_LOGGING_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PERF_LOGGING_ENABLED;
    } else {
      process.env.PERF_LOGGING_ENABLED = original;
    }
  });

  it('is true only for the literal value "1"', async () => {
    const { isPerfLoggingEnabled } = await freshPerfLog();

    delete process.env.PERF_LOGGING_ENABLED;
    expect(isPerfLoggingEnabled()).toBe(false);

    process.env.PERF_LOGGING_ENABLED = "true";
    expect(isPerfLoggingEnabled()).toBe(false);

    process.env.PERF_LOGGING_ENABLED = "0";
    expect(isPerfLoggingEnabled()).toBe(false);

    process.env.PERF_LOGGING_ENABLED = "1";
    expect(isPerfLoggingEnabled()).toBe(true);
  });
});

describe("RenderTimer.step", () => {
  const original = process.env.PERF_LOGGING_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PERF_LOGGING_ENABLED;
    } else {
      process.env.PERF_LOGGING_ENABLED = original;
    }
  });

  it("resolves to the exact same value the wrapped promise resolved with, flag on", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { RenderTimer } = await freshPerfLog();
    const timer = new RenderTimer("test-route-a");

    const value = { hello: "world" };
    const result = await timer.step("thing", Promise.resolve(value));

    expect(result).toBe(value); // same reference, not a deep-equal copy
  });

  it("rejects with the exact same error the wrapped promise rejected with, flag on", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { RenderTimer } = await freshPerfLog();
    const timer = new RenderTimer("test-route-b");

    const err = new Error("boom");
    await expect(timer.step("thing", Promise.reject(err))).rejects.toBe(err);
  });

  it("never throws synchronously and never adds its own rejection, flag on", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { RenderTimer } = await freshPerfLog();
    const timer = new RenderTimer("test-route-c");

    // Calling step() itself must not throw, regardless of what's inside.
    expect(() => timer.step("ok", Promise.resolve(1))).not.toThrow();
    expect(() =>
      timer.step(
        "fails",
        Promise.reject(new Error("x")).catch(() => null),
      ),
    ).not.toThrow();

    // A genuinely rejecting wrapped promise must still be awaitable exactly
    // once (no double-handling, no unhandled rejection warning) — awaiting
    // it here is the assertion that it settles normally.
    await expect(timer.step("thing", Promise.reject(new Error("x")))).rejects.toThrow("x");
  });

  it("returns the exact same promise instance when the flag is off (zero overhead)", async () => {
    delete process.env.PERF_LOGGING_ENABLED;
    const { RenderTimer } = await freshPerfLog();
    const timer = new RenderTimer("test-route-d");

    const promise = Promise.resolve(42);
    const result = timer.step("thing", promise);

    expect(result).toBe(promise);
    await expect(result).resolves.toBe(42);
  });
});

describe("RenderTimer.finish", () => {
  const original = process.env.PERF_LOGGING_ENABLED;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (original === undefined) {
      delete process.env.PERF_LOGGING_ENABLED;
    } else {
      process.env.PERF_LOGGING_ENABLED = original;
    }
  });

  it("emits nothing when the flag is off", async () => {
    delete process.env.PERF_LOGGING_ENABLED;
    const { RenderTimer } = await freshPerfLog();
    const timer = new RenderTimer("test-route-e");

    await timer.step("thing", Promise.resolve(1));
    timer.finish({ userId: "user-1" });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("emits one line with route, cold, every recorded step, and total when the flag is on", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { RenderTimer } = await freshPerfLog();
    const timer = new RenderTimer("test-route-f");

    await timer.step("require_user", Promise.resolve("a"));
    await timer.step("budget", Promise.resolve("b"));
    timer.finish({ userId: "user-123" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("perf_render: route=test-route-f");
    expect(line).toContain("cold=true"); // first render of this route in this fresh module
    expect(line).toMatch(/require_user_ms=\d+/);
    expect(line).toMatch(/budget_ms=\d+/);
    expect(line).toMatch(/total_ms=\d+/);
    expect(line).toContain("user=user-123");
  });

  it("omits user= when userId is null, and never logs anything else user-authored", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { RenderTimer } = await freshPerfLog();
    const timer = new RenderTimer("test-route-g");

    timer.finish({ userId: null });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("user=");
  });

  it("reports cold=false on a second render of the same route immediately after the first", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { RenderTimer } = await freshPerfLog();

    new RenderTimer("test-route-h").finish({ userId: null });
    logSpy.mockClear();

    new RenderTimer("test-route-h").finish({ userId: null });

    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("cold=false");
  });

  it("never throws, even if the underlying console.log call fails", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { RenderTimer } = await freshPerfLog();
    logSpy.mockImplementation(() => {
      throw new Error("log sink is down");
    });

    const timer = new RenderTimer("test-route-i");
    expect(() => timer.finish({ userId: null })).not.toThrow();
  });
});

describe("logColdStartMarker", () => {
  const original = process.env.PERF_LOGGING_ENABLED;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (original === undefined) {
      delete process.env.PERF_LOGGING_ENABLED;
    } else {
      process.env.PERF_LOGGING_ENABLED = original;
    }
  });

  it("logs a perf_boot line when the flag is on", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { logColdStartMarker } = await freshPerfLog();

    logColdStartMarker();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("perf_boot:");
  });

  it("logs nothing when the flag is off", async () => {
    delete process.env.PERF_LOGGING_ENABLED;
    const { logColdStartMarker } = await freshPerfLog();

    logColdStartMarker();

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("never throws, even if console.log fails", async () => {
    process.env.PERF_LOGGING_ENABLED = "1";
    const { logColdStartMarker } = await freshPerfLog();
    logSpy.mockImplementation(() => {
      throw new Error("log sink is down");
    });

    expect(() => logColdStartMarker()).not.toThrow();
  });
});
