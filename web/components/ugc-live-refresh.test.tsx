// @vitest-environment jsdom
//
// The /ugc console had no live update of any kind. Generate revalidated once,
// the tile appeared as `queued`, and then the screen stopped — while the render
// finished 45-90s later and nothing told the page. The operator watched a
// stale tile until they thought to refresh.
//
// Both halves are tested, and the second is the one that gets deleted by
// accident: it must poll while something is in flight, and it must make NO
// requests when nothing is. This is a route an operator leaves open between
// sessions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { UgcLiveRefresh } from "./ugc-live-refresh";

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("UgcLiveRefresh", () => {
  it("refreshes while a clip is rendering", () => {
    render(<UgcLiveRefresh inFlight />);

    expect(refresh, "refreshed before the first interval elapsed").not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("makes no requests when nothing is in flight", () => {
    // The half worth guarding. A console showing only finished clips is a page
    // nobody is waiting on, and a permanent 10s heartbeat against Supabase for
    // it is a cost with no reader.
    render(<UgcLiveRefresh inFlight={false} />);

    vi.advanceTimersByTime(60_000);
    expect(
      refresh,
      "polled a screen where nothing can change on its own",
    ).not.toHaveBeenCalled();
  });

  it("stops when the last render finishes", () => {
    const { rerender } = render(<UgcLiveRefresh inFlight />);
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(<UgcLiveRefresh inFlight={false} />);
    vi.advanceTimersByTime(60_000);

    expect(
      refresh,
      "kept polling after everything finished — the interval outlived its reason",
    ).toHaveBeenCalledTimes(1);
  });

  it("stops when the operator leaves the page", () => {
    const { unmount } = render(<UgcLiveRefresh inFlight />);
    unmount();

    vi.advanceTimersByTime(60_000);
    expect(refresh, "the interval survived unmount").not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    const { container } = render(<UgcLiveRefresh inFlight />);
    expect(container.firstChild).toBeNull();
  });
});
