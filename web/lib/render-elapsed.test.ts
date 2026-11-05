import { describe, expect, it } from "vitest";
import { elapsedLabel, isRenderInFlight, renderOriginMs } from "./render-elapsed";

describe("renderOriginMs", () => {
  it("returns null for an empty scene list — nothing to measure from", () => {
    expect(renderOriginMs([])).toBeNull();
  });

  it("returns null when every scene is still queued (nothing claimed yet)", () => {
    expect(
      renderOriginMs([
        { submitted_at: null, status: "queued" },
        { submitted_at: null, status: "queued" },
      ]),
    ).toBeNull();
  });

  it("returns the earliest submitted_at among in-flight scenes, ignoring terminal ones even when they're older", () => {
    // The terminal scene's submitted_at is the oldest timestamp here — if it
    // won the minimum, a batch's finished scene would keep dragging the
    // origin backwards long after that scene stopped being anyone's concern.
    expect(
      renderOriginMs([
        { submitted_at: "2026-08-14T08:00:00.000Z", status: "done" },
        { submitted_at: "2026-08-14T10:00:05.000Z", status: "rendering" },
        { submitted_at: "2026-08-14T10:00:00.000Z", status: "queued" },
      ]),
    ).toBe(new Date("2026-08-14T10:00:00.000Z").getTime());
  });

  it("returns null once every scene is terminal — no readout, not a frozen one", () => {
    expect(
      renderOriginMs([
        { submitted_at: "2026-08-14T08:00:00.000Z", status: "done" },
        { submitted_at: "2026-08-14T09:00:00.000Z", status: "failed" },
      ]),
    ).toBeNull();
  });

  it("reads from a single in-flight scene's own submitted_at, not the rest of the project (the re-render case)", () => {
    // rerenderScene (actions/enqueue.ts) stamps a fresh submitted_at on just
    // the one scene being redone; the other, long-done scenes must not pull
    // the origin back to when the whole project first started.
    expect(
      renderOriginMs([
        { submitted_at: "2026-08-14T08:00:00.000Z", status: "done" },
        { submitted_at: "2026-08-14T08:00:01.000Z", status: "done" },
        { submitted_at: "2026-08-17T12:00:00.000Z", status: "rendering" },
      ]),
    ).toBe(new Date("2026-08-17T12:00:00.000Z").getTime());
  });

  it("skips a null submitted_at on an in-flight scene rather than letting it poison the minimum", () => {
    // A scene can be `rendering`/`queued` with submitted_at still null for
    // an instant (claimed vs. not-yet-claimed) — Math.min over a NaN from
    // `new Date(null)` would corrupt the result, so nulls must be filtered
    // before taking the minimum, not coerced.
    expect(
      renderOriginMs([
        { submitted_at: null, status: "queued" },
        { submitted_at: "2026-08-17T12:00:00.000Z", status: "rendering" },
      ]),
    ).toBe(new Date("2026-08-17T12:00:00.000Z").getTime());
  });

  it("a submitted_at slightly in the future (clock skew) still resolves to a non-negative elapsedLabel", () => {
    // Worker/browser clocks aren't guaranteed in sync — a submitted_at a
    // few seconds ahead of Date.now() must not surface as "-0:03 elapsed".
    const futureMs = Date.now() + 3_000;
    const origin = renderOriginMs([
      { submitted_at: new Date(futureMs).toISOString(), status: "rendering" },
    ]);
    expect(origin).toBe(futureMs);
    expect(elapsedLabel(Date.now() - origin!)).toBe("0:00");
  });
});

describe("isRenderInFlight", () => {
  it("is true while any scene is queued or rendering", () => {
    expect(isRenderInFlight([{ status: "done" }, { status: "rendering" }])).toBe(true);
    expect(isRenderInFlight([{ status: "queued" }])).toBe(true);
  });

  it("is false once every scene is done or failed", () => {
    expect(isRenderInFlight([{ status: "done" }, { status: "failed" }])).toBe(false);
  });

  it("is false for an empty scene list (nothing left to wait for)", () => {
    expect(isRenderInFlight([])).toBe(false);
  });
});

describe("elapsedLabel", () => {
  it("renders an em dash for a null elapsed value instead of NaN", () => {
    expect(elapsedLabel(null)).toBe("—");
  });

  it("formats sub-minute durations", () => {
    expect(elapsedLabel(4000)).toBe("0:04");
  });

  it("formats multi-minute durations with zero-padded seconds", () => {
    expect(elapsedLabel(125_000)).toBe("2:05");
  });

  it("clamps negative values (e.g. clock skew) to zero rather than a negative readout", () => {
    expect(elapsedLabel(-500)).toBe("0:00");
  });
});

// Regression: the partial-render shape, seen in production. "Test scene 1
// only" renders one scene and leaves the rest at frame_ready. Those scenes
// were counted as still-waiting because they are neither done nor failed —
// but they have never been submitted, so there was nothing to measure and
// the page showed a bare em dash where the wait time belongs.
describe("after a partial render", () => {
  it("is not in flight when the only unrendered scenes were never queued", () => {
    expect(
      isRenderInFlight([{ status: "done" }, { status: "frame_ready" }, { status: "frame_ready" }]),
    ).toBe(false);
  });

  it("is in flight again once one of those scenes is actually queued", () => {
    expect(
      isRenderInFlight([{ status: "done" }, { status: "queued" }, { status: "frame_ready" }]),
    ).toBe(true);
  });

  it("takes its origin from the queued scene, not the already-rendered one", () => {
    const origin = renderOriginMs([
      { status: "done", submitted_at: "2026-08-17T00:00:00.000Z" },
      { status: "queued", submitted_at: "2026-08-17T09:00:00.000Z" },
      { status: "frame_ready", submitted_at: null },
    ]);
    expect(origin).toBe(new Date("2026-08-17T09:00:00.000Z").getTime());
  });

  it("has no origin when nothing is queued, so the readout can be hidden", () => {
    expect(
      renderOriginMs([
        { status: "done", submitted_at: "2026-08-17T00:00:00.000Z" },
        { status: "frame_ready", submitted_at: null },
      ]),
    ).toBeNull();
  });
});
