import { describe, expect, it } from "vitest";
import { usableReferenceDrop } from "./file-type";

const png = { type: "image/png", name: "face.png" };
const webp = { type: "image/webp", name: "face.webp" };
const mp3 = { type: "audio/mpeg", name: "voice.mp3" };
const mp4 = { type: "video/mp4", name: "clip.mp4" };
const txt = { type: "text/plain", name: "notes.txt" };
const gif = { type: "image/gif", name: "anim.gif" };

describe("usableReferenceDrop", () => {
  it("keeps pictures, voice clips and videos, drops the rest", () => {
    expect(usableReferenceDrop([png, txt, mp3, gif, mp4, webp], false)).toEqual([
      png,
      mp3,
      mp4,
      webp,
    ]);
  });

  it("keeps only pictures when imagesOnly", () => {
    expect(usableReferenceDrop([png, mp3, mp4, txt, webp], true)).toEqual([png, webp]);
  });

  it("returns nothing for a drop with no usable file", () => {
    expect(usableReferenceDrop([txt, gif], false)).toEqual([]);
  });
});
