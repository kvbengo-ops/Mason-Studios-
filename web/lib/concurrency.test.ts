import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./concurrency";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runWithConcurrency", () => {
  it("never has more than `limit` tasks in flight at once", async () => {
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 12 }, (_, i) => async (): Promise<number> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active -= 1;
      return i;
    });

    const results = await runWithConcurrency(tasks, 4);

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(results.map((r) => r.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("does not let one rejection sink the batch", async () => {
    const tasks: (() => Promise<string>)[] = [
      async (): Promise<string> => "a",
      async (): Promise<string> => {
        throw new Error("boom");
      },
      async (): Promise<string> => "c",
    ];

    const results = await runWithConcurrency(tasks, 2);

    expect(results).toHaveLength(3);
    const [first, second, third] = results;
    expect(first).toMatchObject({ index: 0, status: "fulfilled", value: "a" });
    expect(second?.status).toBe("rejected");
    expect((second?.reason as Error).message).toBe("boom");
    expect(third).toMatchObject({ index: 2, status: "fulfilled", value: "c" });
  });

  it("handles an empty task list", async () => {
    const results = await runWithConcurrency([], 4);
    expect(results).toEqual([]);
  });

  it("handles limit larger than the task count", async () => {
    const tasks: (() => Promise<number>)[] = [
      async (): Promise<number> => 1,
      async (): Promise<number> => 2,
    ];
    const results = await runWithConcurrency(tasks, 100);
    expect(results.map((r) => r.value)).toEqual([1, 2]);
  });

  it("handles a limit of 1 by running tasks sequentially", async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) => async (): Promise<number> => {
      order.push(n);
      await sleep(1);
      return n;
    });

    await runWithConcurrency(tasks, 1);
    expect(order).toEqual([1, 2, 3]);
  });
});
