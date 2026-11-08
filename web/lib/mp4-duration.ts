/**
 * Zero-dependency ISO Base Media File Format (MP4 / QuickTime) movie header
 * (`moov -> mvhd`) duration parser.
 *
 * Used by server-side reference video ingestion (`registerElement` and
 * `/api/v1/elements`) so `assets.duration_s` is derived from the uploaded
 * binary rather than trusting client-supplied form fields.
 *
 * Supported layouts:
 *   - `mvhd` version 0 (32-bit creation/modification/duration fields)
 *   - `mvhd` version 1 (64-bit creation/modification/duration fields)
 *   - Faststart (`moov` before `mdat`) and trailing-`moov` (`moov` after `mdat`)
 *   - Standard 32-bit box sizes, 64-bit `largesize` (`size === 1`), and
 *     to-EOF boxes (`size === 0`)
 *
 * Unsupported / rejected layouts (returns `null` so callers fail closed):
 *   - Truncated or malformed box headers
 *   - Compressed movie headers (`cmov`)
 *   - Fragmented MP4s (`fMP4`) where `mvhd.duration === 0`
 *   - Zero `timescale`, zero `duration`, or all-ones unknown duration sentinel
 */
export function parseMp4DurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const readBox = (
    offset: number,
    limit: number,
  ): { type: string; headerSize: number; end: number } | null => {
    if (offset + 8 > limit) return null;
    const size32 = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );

    let boxSize = size32;
    let headerSize = 8;

    if (size32 === 1) {
      if (offset + 16 > limit) return null;
      const hi = view.getUint32(offset + 8, false);
      const lo = view.getUint32(offset + 12, false);
      boxSize = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = limit - offset;
    }

    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || offset + boxSize > limit) {
      return null;
    }

    return { type, headerSize, end: offset + boxSize };
  };

  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const box = readBox(offset, bytes.byteLength);
    if (!box) return null;

    if (box.type === "moov") {
      let inner = offset + box.headerSize;
      while (inner + 8 <= box.end) {
        const child = readBox(inner, box.end);
        if (!child) return null;

        if (child.type === "cmov") {
          return null;
        }

        if (child.type === "mvhd") {
          const payloadOffset = inner + child.headerSize;
          if (payloadOffset + 4 > child.end) return null;
          const version = bytes[payloadOffset]!;

          let timescale = 0;
          let duration = 0;

          if (version === 0) {
            // version(1) + flags(3) + creation_time(4) + modification_time(4)
            // + timescale(4) + duration(4) = 20 bytes minimum payload
            if (payloadOffset + 20 > child.end) return null;
            timescale = view.getUint32(payloadOffset + 12, false);
            const rawDuration = view.getUint32(payloadOffset + 16, false);
            if (rawDuration === 0xffffffff) return null;
            duration = rawDuration;
          } else if (version === 1) {
            // version(1) + flags(3) + creation_time(8) + modification_time(8)
            // + timescale(4) + duration(8) = 32 bytes minimum payload
            if (payloadOffset + 32 > child.end) return null;
            timescale = view.getUint32(payloadOffset + 20, false);
            const hi = view.getUint32(payloadOffset + 24, false);
            const lo = view.getUint32(payloadOffset + 28, false);
            if (hi === 0xffffffff && lo === 0xffffffff) return null;
            duration = hi * 4294967296 + lo;
          } else {
            return null;
          }

          if (timescale === 0 || duration === 0) return null;
          const seconds = duration / timescale;
          return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
        }

        inner = child.end;
      }
      return null;
    }

    offset = box.end;
  }

  return null;
}
