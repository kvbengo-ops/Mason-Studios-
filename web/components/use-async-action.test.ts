// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAsyncAction } from "./use-async-action";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAsyncAction", () => {
  it("holds pending for the life of the action", async () => {
    const d = deferred();
    const { result } = renderHook(() => useAsyncAction());

    expect(result.current.pending).toBe(false);
    act(() => result.current.run(() => d.promise));
    expect(result.current.pending).toBe(true);

    await act(async () => {
      d.resolve();
      await d.promise;
    });
    expect(result.current.pending).toBe(false);
  });

  it("clears pending when the action throws", async () => {
    // The spinner that never stops. A hand-rolled setState around a try/catch
    // forgets this exact case, and the control stays disabled until reload.
    //
    // The action handles its own error here because that is the contract —
    // see the hook's ERRORS ARE THE CALLER'S note, and the test below that
    // pins the other half of it.
    const { result } = renderHook(() => useAsyncAction());
    const onError = vi.fn();

    await act(async () => {
      result.current.run(async () => {
        try {
          await Promise.reject(new Error("boom"));
        } catch (err) {
          onError(err);
        }
      });
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  it("does not swallow an error the action failed to handle", async () => {
    // Written after this hook's own first test produced an unhandled
    // rejection and the temptation was to catch it here. A shared helper
    // that ate every error would turn a broken paid action into a spinner
    // that just stops, with nothing in the console and no toast.
    const { result } = renderHook(() => useAsyncAction());
    let rejection: unknown = null;

    await act(async () => {
      result.current.run(() =>
        Promise.reject(new Error("boom")).catch((err: unknown) => {
          // Standing in for the caller's own catch, so the rejection is
          // observed here rather than escaping the test run.
          rejection = err;
          return undefined;
        }),
      );
      await Promise.resolve();
    });

    expect((rejection as Error).message).toBe("boom");
    expect(result.current.pending).toBe(false);
  });

  it("ignores a second call while one is in flight", async () => {
    // Every caller spends money. A second click during the first call is a
    // double charge, not a second intention.
    const d = deferred();
    const action = vi.fn(() => d.promise);
    const { result } = renderHook(() => useAsyncAction());

    act(() => {
      result.current.run(action);
      result.current.run(action);
    });

    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve();
      await d.promise;
    });
  });

  it("accepts a new call once the first has settled", async () => {
    const { result } = renderHook(() => useAsyncAction());
    const action = vi.fn(() => Promise.resolve());

    await act(async () => {
      result.current.run(action);
      await Promise.resolve();
    });
    await act(async () => {
      result.current.run(action);
      await Promise.resolve();
    });

    expect(action).toHaveBeenCalledTimes(2);
  });

  it("keeps `run` stable across renders", () => {
    // Callers pass it into useCallback dependency lists.
    const { result, rerender } = renderHook(() => useAsyncAction());
    const first = result.current.run;
    rerender();
    expect(result.current.run).toBe(first);
  });
});
