import { describe, expect, it } from "vitest";
import { IN_CHUNK_SIZE, selectInChunks } from "./in-chunks";

describe("selectInChunks", () => {
  it("never sends more than IN_CHUNK_SIZE ids in one request and keeps every row", async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `id-${i}`);
    const sent: number[] = [];
    const { data, error } = await selectInChunks(ids, async (chunk) => {
      sent.push(chunk.length);
      return { data: chunk.map((id) => ({ id })), error: null };
    });
    expect(error).toBeNull();
    expect(Math.max(...sent)).toBeLessThanOrEqual(IN_CHUNK_SIZE);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1201);
    expect(data.map((row) => row.id)).toEqual(ids);
  });

  it("returns the first error like a single query would", async () => {
    const { data, error } = await selectInChunks(
      ["a", "b", "c"],
      async (chunk) =>
        chunk[0] === "b" ? { data: null, error: { message: "boom" } } : { data: [chunk[0]], error: null },
      1,
    );
    expect(error?.message).toBe("boom");
    expect(data).toEqual([]);
  });

  it("makes no request for no ids", async () => {
    let calls = 0;
    const { data } = await selectInChunks([], async () => {
      calls += 1;
      return { data: [], error: null };
    });
    expect(calls).toBe(0);
    expect(data).toEqual([]);
  });
});
