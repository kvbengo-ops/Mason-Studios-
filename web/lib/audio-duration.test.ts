import { describe, expect, it } from "vitest";
import { parseAudioDurationSeconds } from "./audio-duration";

function wav(seconds: number, byteRate = 16000): Uint8Array {
  const dataBytes = Math.round(seconds * byteRate);
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const tag = (offset: number, s: string): void =>
    [...s].forEach((c, i) => (out[offset + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, byteRate / 2, true); // sample rate (16-bit mono)
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  return out;
}

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 0xFF 0xFB 0x90 0x00, 417-byte frames.
function cbrMp3(seconds: number): Uint8Array {
  const out = new Uint8Array(Math.round((seconds * 128_000) / 8));
  for (let i = 0; i + 4 <= out.length; i += 417) out.set([0xff, 0xfb, 0x90, 0x00], i);
  return out;
}

function xingMp3(frames: number): Uint8Array {
  const out = new Uint8Array(417 * 2);
  out.set([0xff, 0xfb, 0x90, 0x00], 0);
  const xing = 4 + 32;
  [..."Xing"].forEach((c, i) => (out[xing + i] = c.charCodeAt(0)));
  const view = new DataView(out.buffer);
  view.setUint32(xing + 4, 1); // frames field present
  view.setUint32(xing + 8, frames);
  return out;
}

describe("parseAudioDurationSeconds", () => {
  it("reads a WAV's length from its byte rate and data chunk", () => {
    expect(parseAudioDurationSeconds(wav(5), "wav")).toBeCloseTo(5, 3);
    expect(parseAudioDurationSeconds(wav(1), "wav")).toBeCloseTo(1, 3);
  });

  it("reads a constant-bitrate MP3 from size / bitrate", () => {
    expect(parseAudioDurationSeconds(cbrMp3(10), "mp3")).toBeCloseTo(10, 1);
  });

  it("prefers the Xing frame count for a VBR MP3", () => {
    // 1292 frames x 1152 samples / 44100 Hz = 33.75 s
    expect(parseAudioDurationSeconds(xingMp3(1292), "mp3")).toBeCloseTo(33.75, 2);
  });

  it("returns null rather than guessing when the header can't be read", () => {
    expect(parseAudioDurationSeconds(new Uint8Array([1, 2, 3, 4, 5]), "mp3")).toBeNull();
    expect(parseAudioDurationSeconds(new Uint8Array(12), "wav")).toBeNull();
  });
});
