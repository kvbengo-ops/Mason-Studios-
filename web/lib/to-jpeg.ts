import "server-only";

// Every picture an operator uploads is stored as JPEG. A closed list, not
// "any image/* that isn't JPEG": these are exactly the formats the upload
// dialogs accept (lib/file-type.ts), so anything else — audio, video, or a
// format nobody decided to support — passes through untouched rather than
// being handed to a decoder on a guess.
const CONVERTIBLE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/webp"]);

const JPEG_QUALITY = 90;

/**
 * Re-encodes a PNG or WebP upload as JPEG; returns every other file as-is.
 * `.rotate()` applies the EXIF orientation before metadata is dropped, and
 * transparency is flattened onto white because JPEG has no alpha channel.
 */
export async function toJpeg(file: File): Promise<File> {
  if (!CONVERTIBLE_IMAGE_TYPES.has(file.type)) return file;

  // Loaded on demand, never at module scope: storage.ts imports this file and
  // nearly every server page imports storage.ts, so a top-level import that
  // fails to resolve takes the whole app down (#148), not just uploads.
  const { default: sharp } = await import("sharp");
  const input = Buffer.from(await file.arrayBuffer());
  const output = await sharp(input)
    .rotate()
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  const name = file.name.replace(/\.[^./]+$/, "") || "image";
  return new File([new Uint8Array(output)], `${name}.jpg`, { type: "image/jpeg" });
}
