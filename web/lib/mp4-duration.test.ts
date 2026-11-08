import { describe, expect, it } from "vitest";
import { parseMp4DurationSeconds } from "./mp4-duration";

function makeBox(type: string, payload: Uint8Array, useLargeSize = false): Uint8Array {
  const headerSize = useLargeSize ? 16 : 8;
  const totalSize = headerSize + payload.byteLength;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  if (useLargeSize) {
    view.setUint32(0, 1, false);
    view.setUint32(8, Math.floor(totalSize / 4294967296), false);
    view.setUint32(12, totalSize >>> 0, false);
  } else {
    view.setUint32(0, totalSize, false);
  }

  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(payload, headerSize);
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function makeMvhdV0(timescale: number, duration: number): Uint8Array {
  const payload = new Uint8Array(100);
  const view = new DataView(payload.buffer);
  payload[0] = 0; // version 0
  view.setUint32(12, timescale, false);
  view.setUint32(16, duration, false);
  return makeBox("mvhd", payload);
}

function makeMvhdV1(timescale: number, duration: bigint): Uint8Array {
  const payload = new Uint8Array(112);
  const view = new DataView(payload.buffer);
  payload[0] = 1; // version 1
  view.setUint32(20, timescale, false);
  view.setUint32(24, Number((duration >> 32n) & 0xffffffffn), false);
  view.setUint32(28, Number(duration & 0xffffffffn), false);
  return makeBox("mvhd", payload);
}

describe("parseMp4DurationSeconds", () => {
  describe("valid supported MP4 layouts", () => {
    it("parses mvhd version 0 (32-bit) and rounds up fractional seconds with Math.ceil", () => {
      const ftyp = makeBox("ftyp", new Uint8Array(16));
      const moov = makeBox("moov", makeMvhdV0(1000, 4200)); // 4.2s -> 5s
      const mdat = makeBox("mdat", new Uint8Array(64));
      const mp4 = concatBytes(ftyp, moov, mdat);

      expect(parseMp4DurationSeconds(mp4)).toBe(5);
    });

    it("parses mvhd version 1 (64-bit)", () => {
      const ftyp = makeBox("ftyp", new Uint8Array(16));
      const moov = makeBox("moov", makeMvhdV1(90000, 900000n)); // 10.0s -> 10s
      const mp4 = concatBytes(ftyp, moov);

      expect(parseMp4DurationSeconds(mp4)).toBe(10);
    });

    it("parses trailing-moov layout where moov appears after mdat", () => {
      const ftyp = makeBox("ftyp", new Uint8Array(16));
      const mdat = makeBox("mdat", new Uint8Array(256));
      const udta = makeBox("udta", new Uint8Array(12));
      const mvhd = makeMvhdV0(600, 3600); // 6.0s -> 6s
      const moov = makeBox("moov", concatBytes(udta, mvhd));
      const mp4 = concatBytes(ftyp, mdat, moov);

      expect(parseMp4DurationSeconds(mp4)).toBe(6);
    });

    it("parses 64-bit largesize (size === 1) boxes", () => {
      const ftyp = makeBox("ftyp", new Uint8Array(16), true);
      const mvhd = makeMvhdV0(1000, 7001); // 7.001s -> 8s
      const moov = makeBox("moov", mvhd, true);
      const mp4 = concatBytes(ftyp, moov);

      expect(parseMp4DurationSeconds(mp4)).toBe(8);
    });
  });

  describe("malformed and truncated files", () => {
    it("returns null for empty or < 8 byte buffers", () => {
      expect(parseMp4DurationSeconds(new Uint8Array(0))).toBeNull();
      expect(parseMp4DurationSeconds(new Uint8Array([0, 1, 2, 3]))).toBeNull();
    });

    it("returns null when box size is smaller than the 8-byte header", () => {
      const bad = new Uint8Array(16);
      const view = new DataView(bad.buffer);
      view.setUint32(0, 4, false); // invalid size < 8
      expect(parseMp4DurationSeconds(bad)).toBeNull();
    });

    it("returns null when box size exceeds buffer length (truncated file)", () => {
      const ftyp = makeBox("ftyp", new Uint8Array(16));
      const moov = makeBox("moov", makeMvhdV0(1000, 5000));
      const truncated = concatBytes(ftyp, moov).subarray(0, ftyp.byteLength + 18);

      expect(parseMp4DurationSeconds(truncated)).toBeNull();
    });

    it("returns null when timescale is 0, duration is 0, or duration is 0xFFFFFFFF", () => {
      expect(parseMp4DurationSeconds(makeBox("moov", makeMvhdV0(0, 5000)))).toBeNull();
      expect(parseMp4DurationSeconds(makeBox("moov", makeMvhdV0(1000, 0)))).toBeNull();
      expect(parseMp4DurationSeconds(makeBox("moov", makeMvhdV0(1000, 0xffffffff)))).toBeNull();
    });
  });

  describe("unsupported layouts fail closed (null)", () => {
    it("returns null for fragmented MP4 (fMP4) where mvhd duration is 0", () => {
      const ftyp = makeBox("ftyp", new Uint8Array(16));
      const mvhdZero = makeMvhdV0(1000, 0);
      const mvex = makeBox("mvex", new Uint8Array(16));
      const moov = makeBox("moov", concatBytes(mvhdZero, mvex));
      const moof = makeBox("moof", new Uint8Array(32));

      expect(parseMp4DurationSeconds(concatBytes(ftyp, moov, moof))).toBeNull();
    });

    it("returns null for compressed movie headers (cmov)", () => {
      const cmov = makeBox("cmov", new Uint8Array(24));
      const moov = makeBox("moov", cmov);

      expect(parseMp4DurationSeconds(moov)).toBeNull();
    });

    it("returns null for unknown mvhd version", () => {
      const mvhd = makeMvhdV0(1000, 5000);
      mvhd[8] = 2; // version 2
      const moov = makeBox("moov", mvhd);

      expect(parseMp4DurationSeconds(moov)).toBeNull();
    });
  });
});
