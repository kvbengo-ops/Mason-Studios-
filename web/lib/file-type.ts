// Pure predicate factored out of components/reference-dropzone.tsx so the
// accept/reject rule for a dropped file is unit-testable without mounting a
// component or faking DragEvent — same reasoning as enqueue-guard.ts's
// split from the render action.

const ACCEPTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const ACCEPTED_IMAGE_EXTENSIONS: readonly string[] = [".jpg", ".jpeg", ".png", ".webp"];

/**
 * Spec §3.1's Reference Image dropzone accepts "JPG, PNG, WebP". Some OS
 * file managers hand drag-and-drop payloads to the browser with a blank or
 * `application/octet-stream` MIME type (the browser only sniffs it
 * reliably for a real file picker selection), so a MIME miss falls back to
 * the extension rather than rejecting a genuine image outright.
 */
export function isAcceptedReferenceImage(file: { type: string; name: string }): boolean {
  if (ACCEPTED_IMAGE_MIME_TYPES.has(file.type)) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return ACCEPTED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// A real phone photo routinely runs 8-12MB. This is the number the client
// check (reference-dropzone.tsx) and the server-side check
// (actions/character.ts) both compare against — single source, so they
// cannot silently drift apart. It must also stay comfortably under
// next.config.ts's `serverActions.bodySizeLimit`: that limit is what
// actually produced this bug (a file the dropzone would have accepted
// still got rejected by Next before our code ever ran, as a redacted
// error #441). Keeping this constant below that ceiling, with the
// multipart envelope's overhead as headroom, is what makes "too large" a
// message the operator reads instead of a second flavor of the same
// production incident.
//
// 10MB, not equal to next.config.ts's bodySizeLimit: a Server Action's body
// is this file PLUS the rest of the multipart envelope (boundary strings,
// headers, the field name), so a file sized exactly at the body limit is
// guaranteed to overflow it and get rejected by Next before this constant
// is ever consulted — the same #441 this file exists to prevent, just moved
// one byte over. bodySizeLimit is deliberately set higher (see
// next.config.ts) to leave that headroom.
export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Human-readable size for an error message, e.g. "12.3MB". */
export function formatFileSizeMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * A voice reference: WAV or MP3, per kie's schema for bytedance/seedance-2-5
 * (`reference_audio_urls`, docs read 2026-09-04).
 *
 * Same MIME-then-extension fallback as the image predicate above, and for a
 * sharper reason here: browsers are markedly worse at typing audio. A .wav
 * arrives as `audio/wav`, `audio/x-wav`, `audio/wave` or nothing at all
 * depending on the OS and how the file got there, so the extension is not a
 * courtesy fallback — it is the reliable half.
 */
const ACCEPTED_AUDIO_MIME_TYPES: ReadonlySet<string> = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
]);

const ACCEPTED_AUDIO_EXTENSIONS: readonly string[] = [".mp3", ".wav"];

export function isAcceptedReferenceAudio(file: { type: string; name: string }): boolean {
  if (ACCEPTED_AUDIO_MIME_TYPES.has(file.type)) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return ACCEPTED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * kie's own ceiling for one reference audio file, not ours.
 *
 * 15 MB per file, and separately 2-30 seconds each with 30 seconds total
 * across every file in the request. Only the byte limit is checkable here —
 * a duration needs the file decoded, which is the dropzone's job in the
 * browser, not this module's.
 *
 * THIS NUMBER CURRENTLY EXCEEDS next.config.ts's serverActions.bodySizeLimit
 * (12mb as of this writing) — a live bug: a 13-15MB audio file this constant
 * accepts still gets rejected by Next before the upload action ever runs,
 * the same #441 failure mode MAX_REFERENCE_IMAGE_BYTES's comment describes.
 * It is fixed alongside this file in the same PR that adds video references,
 * by raising bodySizeLimit to 28mb — since lowered to 18mb when
 * MAX_REFERENCE_VIDEO_BYTES came down to 15MB (next.config.ts's own comment
 * has that story). See MAX_REFERENCE_VIDEO_BYTES below for the invariant
 * either fix restores: every reference-file ceiling in this module must sit
 * strictly BELOW bodySizeLimit, never equal to or above it.
 */
export const MAX_REFERENCE_AUDIO_BYTES = 15 * 1024 * 1024;

export function isAcceptedReferenceAudioSize(file: { size: number }): boolean {
  return file.size <= MAX_REFERENCE_AUDIO_BYTES;
}

/** kie refuses a reference audio outside this range; see MAX_REFERENCE_AUDIO_BYTES. */
export const MIN_REFERENCE_AUDIO_SECONDS = 2;
export const MAX_REFERENCE_AUDIO_SECONDS = 30;

/**
 * Whether a measured duration is one kie will accept.
 *
 * Split from the measuring so the rule is testable without an AudioContext:
 * the browser reads the number, this decides what it means. A file that
 * cannot be measured at all is NOT rejected here — see the dropzone for why
 * an unreadable duration is passed through to kie rather than refused
 * locally on a guess.
 */
export function isAcceptedReferenceAudioDuration(seconds: number): boolean {
  return (
    Number.isFinite(seconds) &&
    seconds >= MIN_REFERENCE_AUDIO_SECONDS &&
    seconds <= MAX_REFERENCE_AUDIO_SECONDS
  );
}

/** True when a file is under the reference-image size ceiling (see `MAX_REFERENCE_IMAGE_BYTES`). */
export function isAcceptedReferenceImageSize(file: { size: number }): boolean {
  return file.size <= MAX_REFERENCE_IMAGE_BYTES;
}

/**
 * A video reference: .mp4 only, per the naming plan's explicit rejection of
 * .mov — a QuickTime container does not reliably play in a browser <video>
 * preview, so admitting it here would let an operator upload a file the
 * elements library could never show back to them.
 *
 * MIME-then-extension fallback, same shape and same reason as the audio
 * predicate above: an OS file picker or drag-and-drop payload does not
 * reliably type media, so the extension is the fallback that actually
 * catches a genuine .mp4 the browser mistyped.
 */
const ACCEPTED_VIDEO_MIME_TYPES: ReadonlySet<string> = new Set(["video/mp4"]);

const ACCEPTED_VIDEO_EXTENSIONS: readonly string[] = [".mp4"];

export function isAcceptedReferenceVideo(file: { type: string; name: string }): boolean {
  if (ACCEPTED_VIDEO_MIME_TYPES.has(file.type)) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return ACCEPTED_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Our own ceiling for one video reference upload — a vendor limit now, just
 * not the render one. 0093_video_reference_elements.sql still holds: a video
 * element never produces a scene_references row and never reaches kie's
 * render endpoint, kind's CHECK constraint enforces that unchanged. But
 * lib/kie-video-describe.ts now sends this file's bytes to kie's Gemini pass
 * at save time, to WRITE the description, and that call has a ceiling of its
 * own kie will not tell you when you cross: MAX_DESCRIBABLE_VIDEO_BYTES
 * there is 15MB because kie's media part silently vanishes above 25 MiB of
 * base64 (18.75MB raw) and answers from the instruction text alone — a
 * confident, entirely invented description, still HTTP 200, still billed.
 * That file's header has the receipts (four different fabrications for one
 * random-noise clip, all 200, all charged).
 *
 * This constant moved from 25MB down to 15MB to match, on purpose: ONE cap,
 * not two. Every video an operator can upload through this check is a video
 * small enough that the describer's first guard (reject before the call) is
 * the only one that can ever fire, never the second one (an accepted-but-
 * invented response slipping through on token count alone). Raising this
 * back toward 25MB without also raising MAX_DESCRIBABLE_VIDEO_BYTES would
 * not restore the old behaviour — it would let an operator upload a clip
 * this app then silently describes with fiction. The two constants must
 * move together, and MAX_DESCRIBABLE_VIDEO_BYTES's own comment carries the
 * same warning pointed back at this one.
 *
 * MUST ALSO stay strictly BELOW next.config.ts's serverActions.bodySizeLimit,
 * the same invariant MAX_REFERENCE_AUDIO_BYTES's comment names, and for the
 * same #441 reason: a Server Action's body is this file PLUS the rest of the
 * multipart envelope, so a file sized at or above the limit is rejected by
 * Next before this constant is ever consulted.
 */
export const MAX_REFERENCE_VIDEO_BYTES = 15 * 1024 * 1024;

export function isAcceptedReferenceVideoSize(file: { size: number }): boolean {
  return file.size <= MAX_REFERENCE_VIDEO_BYTES;
}
