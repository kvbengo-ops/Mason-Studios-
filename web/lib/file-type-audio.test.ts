import { describe, expect, it } from "vitest";
import {
  isAcceptedReferenceAudio,
  isAcceptedReferenceAudioDuration,
  isAcceptedReferenceAudioSize,
  isAcceptedReferenceImage,
  MAX_REFERENCE_AUDIO_BYTES,
} from "./file-type";

// kie's rules for reference_audio_urls, read off its own schema page on
// 2026-09-04: WAV or MP3, 15 MB per file, 2-30 seconds each. These are the
// vendor's numbers, not ours, and the only reason to check them here rather
// than let kie answer is that kie answers AFTER the render is submitted.

describe("isAcceptedReferenceAudio", () => {
  it("takes the MIME types browsers actually produce for a WAV", () => {
    // Not pedantry: the same file arrives as audio/wav on one OS, audio/x-wav
    // on another and audio/wave on a third. Naming one of them is how a valid
    // upload gets greyed out with no explanation.
    for (const type of ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]) {
      expect(isAcceptedReferenceAudio({ type, name: "v.wav" }), type).toBe(true);
    }
  });

  it("takes both MIME spellings of an MP3", () => {
    expect(isAcceptedReferenceAudio({ type: "audio/mpeg", name: "v.mp3" })).toBe(true);
    expect(isAcceptedReferenceAudio({ type: "audio/mp3", name: "v.mp3" })).toBe(true);
  });

  it("falls back to the extension when the browser says nothing", () => {
    // A drag-and-drop payload routinely carries a blank or octet-stream type;
    // the extension is the reliable half for audio, not a courtesy.
    expect(isAcceptedReferenceAudio({ type: "", name: "voice.mp3" })).toBe(true);
    expect(isAcceptedReferenceAudio({ type: "application/octet-stream", name: "v.WAV" })).toBe(true);
  });

  it("refuses a video, and does not confuse the two reference kinds", () => {
    expect(isAcceptedReferenceAudio({ type: "video/mp4", name: "clip.mp4" })).toBe(false);
    expect(isAcceptedReferenceAudio({ type: "image/png", name: "a.png" })).toBe(false);
    expect(isAcceptedReferenceImage({ type: "audio/mpeg", name: "v.mp3" })).toBe(false);
  });
});

describe("isAcceptedReferenceAudioSize", () => {
  it("allows a file exactly at kie's ceiling and refuses one byte more", () => {
    expect(isAcceptedReferenceAudioSize({ size: MAX_REFERENCE_AUDIO_BYTES })).toBe(true);
    expect(isAcceptedReferenceAudioSize({ size: MAX_REFERENCE_AUDIO_BYTES + 1 })).toBe(false);
  });

  it("is a different ceiling from the image one", () => {
    // 15 MB for audio against 10 MB for a picture. Sharing a constant would
    // have refused a legal voice clip.
    expect(MAX_REFERENCE_AUDIO_BYTES).toBe(15 * 1024 * 1024);
  });
});

describe("isAcceptedReferenceAudioDuration", () => {
  it("accepts the endpoints kie documents", () => {
    expect(isAcceptedReferenceAudioDuration(2)).toBe(true);
    expect(isAcceptedReferenceAudioDuration(30)).toBe(true);
  });

  it("refuses just outside them", () => {
    expect(isAcceptedReferenceAudioDuration(1.9)).toBe(false);
    expect(isAcceptedReferenceAudioDuration(30.1)).toBe(false);
  });

  it("refuses a duration the browser could not determine", () => {
    // An <audio> element reports Infinity for a stream it cannot seek and NaN
    // for one it cannot decode. Neither is a length, and treating either as
    // one would pass an unmeasured file off as checked.
    expect(isAcceptedReferenceAudioDuration(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isAcceptedReferenceAudioDuration(Number.NaN)).toBe(false);
  });
});
