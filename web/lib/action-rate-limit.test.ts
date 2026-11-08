import { describe, expect, it } from "vitest";
import {
  ACTION_LIMIT_PER_MINUTE,
  READ_LIMIT_PER_MINUTE,
  retryAfterSeconds,
  takeActionSlot,
  takeReadSlot,
} from "./action-rate-limit";

describe("takeActionSlot", () => {
  it("allows the limit per minute, refuses the next, and frees up after the window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < ACTION_LIMIT_PER_MINUTE; i++) {
      expect(takeActionSlot("user-a", t0 + i)).toBe(true);
    }
    expect(takeActionSlot("user-a", t0 + 100)).toBe(false);
    // Another user has their own window.
    expect(takeActionSlot("user-b", t0 + 100)).toBe(true);
    // A minute after the first call, its slot is free again.
    expect(takeActionSlot("user-a", t0 + 60_000)).toBe(true);
  });

  it("maintains a separate 120/min read bucket and computes Retry-After seconds", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < READ_LIMIT_PER_MINUTE; i++) {
      expect(takeReadSlot("user-poll", t0 + i)).toBe(true);
    }
    expect(takeReadSlot("user-poll", t0 + 5_000)).toBe(false);
    // Write slot for the same user is unaffected by read polling.
    expect(takeActionSlot("user-poll", t0 + 5_000)).toBe(true);
    expect(retryAfterSeconds("user-poll", "read", t0 + 5_000)).toBe(55);
  });
});
