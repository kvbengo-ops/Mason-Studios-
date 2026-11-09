/**
 * Zero-dependency WAV / MP3 duration reader, the audio twin of mp4-duration.ts.
 *
 * Used by `/api/v1/elements` so a voice clip's 2-30 s rule (lib/file-type.ts) is
 * checked on the server; the app checks it in the browser instead. Returns
 * `null` when the length can't be read with confidence, and callers pass that
 * through rather than refuse on a guess — the same policy as the app's dropzone.
 *
 * WAV: `fmt ` byte rate and `data` chunk size.
 * MP3 (MPEG-1/2/2.5 Layer III): the Xing/Info or VBRI frame count when present,
 * otherwise constant-bitrate size / bitrate.
 * shortcut: a VBR MP3 with no Xing/VBRI header is read as CBR at its first frame's
 * bitrate, so its length can be off; decode every frame if that ever matters.
 */
export function parseAudioDurationSeconds(
  bytes: Uint8Array,
  extension: "wav" | "mp3",
): number | null {
  const seconds = extension === "wav" ? parseWav(bytes) : parseMp3(bytes);
  return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  return [...value].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
}

function parseWav(bytes: Uint8Array): number | null {
  if (bytes.length < 12 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let byteRate: number | null = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (ascii(bytes, offset, "fmt ") && body + 12 <= bytes.length) {
      byteRate = view.getUint32(body + 8, true);
    } else if (ascii(bytes, offset, "data")) {
      if (!byteRate) return null;
      // A streamed WAV may leave the size unset (0 or 0xFFFFFFFF); count what is there.
      const dataBytes = size === 0 || body + size > bytes.length ? bytes.length - body : size;
      return dataBytes / byteRate;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

const MP3_BITRATES_KBPS = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES = [44100, 48000, 32000];

function parseMp3(bytes: Uint8Array): number | null {
  let start = 0;
  if (bytes.length >= 10 && ascii(bytes, 0, "ID3")) {
    const tagSize =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    start = 10 + tagSize + (bytes[5]! & 0x10 ? 10 : 0);
  }
  while (
    start + 4 <= bytes.length &&
    !(bytes[start] === 0xff && (bytes[start + 1]! & 0xe0) === 0xe0)
  ) {
    start++;
  }
  if (start + 4 > bytes.length) return null;

  const versionBits = (bytes[start + 1]! >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layerBits = (bytes[start + 1]! >> 1) & 3; // 1 = Layer III
  const bitrateIndex = bytes[start + 2]! >> 4;
  const sampleRateIndex = (bytes[start + 2]! >> 2) & 3;
  const mono = bytes[start + 3]! >> 6 === 3;
  if (versionBits === 1 || layerBits !== 1 || sampleRateIndex === 3) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;

  const mpeg1 = versionBits === 3;
  const sampleRate = MP3_SAMPLE_RATES[sampleRateIndex]! / (mpeg1 ? 1 : versionBits === 2 ? 2 : 4);
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const xing = start + 4 + sideInfo;
  if (xing + 12 <= bytes.length && (ascii(bytes, xing, "Xing") || ascii(bytes, xing, "Info"))) {
    if (view.getUint32(xing + 4) & 1) {
      return (view.getUint32(xing + 8) * samplesPerFrame) / sampleRate;
    }
  }
  const vbri = start + 36;
  if (vbri + 18 <= bytes.length && ascii(bytes, vbri, "VBRI")) {
    return (view.getUint32(vbri + 14) * samplesPerFrame) / sampleRate;
  }

  const kbps = (mpeg1 ? MP3_BITRATES_KBPS.v1 : MP3_BITRATES_KBPS.v2)[bitrateIndex]!;
  return ((bytes.length - start) * 8) / (kbps * 1000);
}
