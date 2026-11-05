import { describe, expect, it } from "vitest";
import {
  formatFileSizeMB,
  isAcceptedReferenceImage,
  isAcceptedReferenceImageSize,
  MAX_REFERENCE_IMAGE_BYTES,
} from "./file-type";

describe("isAcceptedReferenceImage", () => {
  it("accepts JPG, PNG, and WebP by MIME type", () => {
    expect(isAcceptedReferenceImage({ type: "image/jpeg", name: "photo.jpg" })).toBe(true);
    expect(isAcceptedReferenceImage({ type: "image/png", name: "photo.png" })).toBe(true);
    expect(isAcceptedReferenceImage({ type: "image/webp", name: "photo.webp" })).toBe(true);
  });

  it("falls back to the file extension when the MIME type is blank", () => {
    // Observed from some OS file managers on drag-and-drop.
    expect(isAcceptedReferenceImage({ type: "", name: "photo.PNG" })).toBe(true);
    expect(isAcceptedReferenceImage({ type: "application/octet-stream", name: "photo.jpeg" })).toBe(
      true,
    );
  });

  it("rejects non-image files even with an image-like name prefix", () => {
    expect(isAcceptedReferenceImage({ type: "application/pdf", name: "photo.pdf" })).toBe(false);
  });

  it("rejects video and other unsupported MIME types with no matching extension", () => {
    expect(isAcceptedReferenceImage({ type: "video/mp4", name: "clip.mp4" })).toBe(false);
  });
});

describe("isAcceptedReferenceImageSize", () => {
  // The exact production incident this pair of functions exists to catch:
  // a normal phone photo (8-12MB) cleared Next's old 1MB Server Action body
  // limit and threw a redacted #441 instead of a message naming the limit.
  it("accepts a file at or under the limit", () => {
    expect(isAcceptedReferenceImageSize({ size: MAX_REFERENCE_IMAGE_BYTES })).toBe(true);
    expect(isAcceptedReferenceImageSize({ size: 1024 })).toBe(true);
  });

  it("rejects a file over the limit", () => {
    expect(isAcceptedReferenceImageSize({ size: MAX_REFERENCE_IMAGE_BYTES + 1 })).toBe(false);
  });
});

describe("formatFileSizeMB", () => {
  // Only used to name the actual limit and the actual file size in a
  // returned ActionResult, so the precision (one decimal place) is what
  // matters here, not the rounding rule.
  it("formats bytes as a one-decimal MB string", () => {
    expect(formatFileSizeMB(12.3 * 1024 * 1024)).toBe("12.3MB");
    expect(formatFileSizeMB(MAX_REFERENCE_IMAGE_BYTES)).toBe("10.0MB");
  });
});
