// Bounded-concurrency task runner (docs/architecture.md doesn't specify a
// batch-image API — this is the general primitive `generateFrames`
// (actions/frames.ts) uses to run one `generateImage` call per scene
// without firing all of them at once).
//
// Kept free of any DB/fal/network dependency — like lib/scene-order.ts —
// so the scheduling behaviour (never exceeding the concurrency limit, one
// rejection not sinking the batch) can be unit tested with plain async
// functions instead of real network calls.

/** The outcome of one task, keyed by its position in the input array. */
export interface SettledTask<T> {
  index: number;
  status: "fulfilled" | "rejected";
  value?: T;
  reason?: unknown;
}

/**
 * Runs `tasks` with at most `limit` in flight at any moment, waiting for
 * every task to settle (success or failure) before resolving — like
 * `Promise.allSettled`, but bounded. A rejected task is recorded in the
 * result at its original index and does not stop the remaining tasks from
 * running, so a batch where one item fails still completes the rest.
 */
export async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<SettledTask<T>[]> {
  const results: SettledTask<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      const task = tasks[current];
      if (task === undefined) return;

      try {
        const value = await task();
        results[current] = { index: current, status: "fulfilled", value };
      } catch (reason) {
        results[current] = { index: current, status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
