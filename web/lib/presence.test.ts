import { describe, expect, it } from "vitest";
import { isOnline, lastSeenLabel } from "@/lib/presence";

const NOW = new Date("2026-11-09T10:00:00Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe("isOnline", () => {
  it("is green within 2 minutes and red after", () => {
    expect(isOnline(ago(30_000), NOW)).toBe(true);
    expect(isOnline(ago(120_000), NOW)).toBe(true);
    expect(isOnline(ago(120_001), NOW)).toBe(false);
  });

  it("is red for an account never seen or a bad value", () => {
    expect(isOnline(null, NOW)).toBe(false);
    expect(isOnline("nonsense", NOW)).toBe(false);
  });
});

describe("lastSeenLabel", () => {
  it.each([
    [null, "Never seen"],
    [ago(10_000), "Online now"],
    [ago(5 * 60_000), "Last seen 5 min ago"],
    [ago(3 * 3_600_000), "Last seen 3 h ago"],
    [ago(2 * 86_400_000), "Last seen 2 d ago"],
  ])("%s -> %s", (seen, label) => {
    expect(lastSeenLabel(seen, NOW)).toBe(label);
  });
});
