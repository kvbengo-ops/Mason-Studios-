import { describe, expect, it } from "vitest";
import { formatAverageBitrate } from "./average-bitrate";

describe("formatAverageBitrate", () => {
  it("formats average video bitrate from file size and duration", () => {
    expect(formatAverageBitrate(2_500_000, 10)).toBe("2.0 Mbps");
    expect(formatAverageBitrate(125_000, 10)).toBe("100 kbps");
    expect(formatAverageBitrate(500, 10)).toBe("400 bps");
  });

  it("omits bitrate when the file size or duration is unavailable", () => {
    expect(formatAverageBitrate(0, 10)).toBeNull();
    expect(formatAverageBitrate(100, 0)).toBeNull();
  });
});
