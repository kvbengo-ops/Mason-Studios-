// @vitest-environment jsdom
//
// The plain subscribe/get/set functions behind ugc-pending-scene-tile.tsx
// and ugc-new-scene-tile.tsx — see that file's own header for why this is a
// module-level store keyed by projectId rather than transition/optimistic
// state. Tested directly (no React) because the store's own contract —
// what begin/resolve/clear do to the snapshot, and that it is scoped per
// project — has nothing to do with how a component reads it.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetAllGeneratePendingForTests,
  beginGeneratePending,
  clearGeneratePending,
  getSnapshot,
  resolveGeneratePending,
  subscribe,
} from "./ugc-generate-pending-store";

afterEach(() => {
  __resetAllGeneratePendingForTests();
  vi.useRealTimers();
});

describe("ugc-generate-pending-store", () => {
  it("is null for a project nothing has begun", () => {
    expect(getSnapshot("proj-1")).toBeNull();
  });

  it("begin sets a pending state with no sceneId yet, and notifies subscribers", () => {
    const listener = vi.fn();
    subscribe("proj-1", listener);

    beginGeneratePending("proj-1");

    expect(getSnapshot("proj-1")).toEqual({ sceneId: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("resolve records the sceneId without clearing the pending state", () => {
    beginGeneratePending("proj-1");
    resolveGeneratePending("proj-1", "scene-42");

    expect(getSnapshot("proj-1")).toEqual({ sceneId: "scene-42" });
  });

  it("resolve is a no-op once the entry has already been cleared", () => {
    // A second press, or the safety timeout, may have cleared this before a
    // slow generateClip call from an earlier press comes back — that late
    // arrival must not resurrect a placeholder nothing is showing anymore.
    beginGeneratePending("proj-1");
    clearGeneratePending("proj-1");

    resolveGeneratePending("proj-1", "scene-42");

    expect(getSnapshot("proj-1")).toBeNull();
  });

  it("clear removes the entry and notifies subscribers", () => {
    const listener = vi.fn();
    beginGeneratePending("proj-1");
    subscribe("proj-1", listener);

    clearGeneratePending("proj-1");

    expect(getSnapshot("proj-1")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clear on a project with nothing pending does not notify", () => {
    const listener = vi.fn();
    subscribe("proj-1", listener);

    clearGeneratePending("proj-1");

    expect(listener).not.toHaveBeenCalled();
  });

  it("scopes state per projectId — beginning one project never notifies another's subscribers", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    subscribe("proj-a", listenerA);
    subscribe("proj-b", listenerB);

    beginGeneratePending("proj-a");

    expect(getSnapshot("proj-a")).toEqual({ sceneId: null });
    expect(getSnapshot("proj-b")).toBeNull();
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe("proj-1", listener);
    unsubscribe();

    beginGeneratePending("proj-1");

    expect(listener).not.toHaveBeenCalled();
  });

  it("clears itself after the safety timeout if nobody else does", () => {
    vi.useFakeTimers();
    beginGeneratePending("proj-1");
    expect(getSnapshot("proj-1")).toEqual({ sceneId: null });

    vi.advanceTimersByTime(30_000);

    expect(
      getSnapshot("proj-1"),
      "a request that never comes back left a placeholder stuck on 'Queued' forever",
    ).toBeNull();
  });

  it("resolve re-arms a fresh safety window instead of leaving the original one running", () => {
    // If resolve did not touch the timer at all, one scheduled at t=0 would
    // still fire at t=30000 regardless of when resolve happened — this
    // proves it is a NEW 30s window from the resolve, not the stale one
    // from begin: advancing to just past begin's original deadline must not
    // wipe a sceneId that was only just recorded.
    vi.useFakeTimers();
    beginGeneratePending("proj-1");
    vi.advanceTimersByTime(29_000);
    resolveGeneratePending("proj-1", "scene-42");

    vi.advanceTimersByTime(2_000); // past the original 30s mark, not past the new one

    expect(getSnapshot("proj-1")).toEqual({ sceneId: "scene-42" });
  });
});
