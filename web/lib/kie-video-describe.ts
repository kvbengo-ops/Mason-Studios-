// kie's Gemini vision pass, pointed at a saved VIDEO reference this time —
// the sibling of lib/kie-audio-describe.ts, same vendor, same model, same
// shape, one different medium.
//
// WHY THIS EXISTS. PR #112 (commit 6a78469) added video reference elements:
// upload to storage, auto-name new_video1, taggable as @new_video1. They
// shipped with description = null and NO describe call, because at the time
// no vendor reachable from this codebase could read a video — that file's
// header says so explicitly, and worker/internal/loop/dispatch.go's
// bindUITags still deletes a video tag outright the same way it deletes an
// audio tag, because a video element still never produces a
// scene_references row and never reaches kie's render endpoint (kind's CHECK
// constraint enforces that, and this module changes NONE of it). What this
// module changes is the other half: actions/ugc.ts's resolveElementTags
// already substitutes ANY element's `description` into a prompt regardless
// of kind, so an @new_video1 tag has had somewhere to resolve to since day
// one — nothing had ever written the description. This is what writes one.
//
// VERIFIED against kie's live API on 2026-09-09, against real clips, not a
// guess:
//   POST https://api.kie.ai/gemini/v1/models/gemini-3-8-flash:generateContent
// — the exact endpoint, model and auth as the audio describer — ACCEPTS
// video/mp4 as inlineData and returns 200. It reads the WHOLE clip across
// time, not one frame: a clip that was solid red, then green, then blue
// came back with the colours in the correct order and an estimated
// duration, which a one-frame reader cannot produce. responseSchema /
// responseMimeType: application/json works with video exactly as it does
// with audio. Cost: credits_consumed measured 0.01 to 0.03 per call —
// see VIDEO_DESCRIBE_ESTIMATE_USD. Latency: 11s to 23s for clips of 0.7MB
// to 19.4MB. Body limit: HTTP 413 "request body exceeds edge limit of
// 31457280 bytes" (30 MiB) for the whole request — but see the finding
// below for why that number is NOT the one this module guards against.
//
// THE DANGEROUS FINDING, and the reason MAX_DESCRIBABLE_VIDEO_BYTES and
// MIN_PROMPT_TOKENS_FOR_A_REAL_READ both exist. There is a band, comfortably
// below the 413 limit, where kie returns 200, silently DROPS the video part
// of the request, and answers from the instruction text alone with a
// confident, entirely invented description. Measured, clean re-encodes of
// the SAME random-noise clip:
//     19.4MB raw (25.9MB base64) -> 200, promptTokenCount 200, correct:
//                                   "full-screen digital static"
//     20.2MB raw (26.9MB base64) -> 200, promptTokenCount 11,  INVENTED
//     21.0MB raw (28.0MB base64) -> 200, promptTokenCount 11,  INVENTED
//     21.9MB raw (29.2MB base64) -> 200, promptTokenCount 11,  INVENTED
// One 21.2MB file probed four times returned four unrelated fabrications —
// a woman spinning in a sunlit bedroom, a dashboard-view road, an airplane
// cabin at night, a baby with a spoon — for a clip that was random static
// every time. Every one of those was HTTP 200 and every one consumed
// credits. The threshold sits at 25 MiB of BASE64 (26214400 bytes), which is
// 18.75MB of raw video (26214400 * 3/4) — that arithmetic explains every row
// above exactly. Above it the media part is dropped; the 30 MiB body limit
// only starts refusing at ~23.6MB raw, nearly 5MB later. THE ONLY SIGNAL
// that tells a real reading apart from an invention is
// usageMetadata.promptTokenCount: instruction-only responses measured 11 and
// 33; genuinely-read clips measured 137 and 200. Nothing else differs — not
// the status code, not the response shape, not the schema validity, not the
// billing.
//
// THE JSON IS A STRING, exactly as lib/kie-audio-describe.ts's header
// explains: Gemini's structured-output shape serializes the schema's fields
// as TEXT inside candidates[0].content.parts[0].text, so it has to be
// JSON.parse'd and validated here rather than read as a nested object.
//
// UNLIKE describeReferenceImage (lib/claude.ts), which hands Claude a URL
// and lets Claude fetch it, this endpoint was only ever verified with
// inlineData bytes, so this module downloads the clip itself before calling
// out — same reasoning as the audio module, one medium later.

import { z } from "zod";
import { describeRoleLine } from "./describe-role-line";
import { isDev } from "./mode";

const BASE_URL = "https://api.kie.ai";

/**
 * kie's own id for the model this module calls. Measured identical to
 * AUDIO_DESCRIBE_MODEL today, but kept as this module's OWN constant rather
 * than imported from lib/kie-audio-describe.ts: if kie ever splits a
 * video-specific model (or a video-specific price), this is the one name
 * that changes, and nothing about the audio path has to be touched, read,
 * or re-verified to make that change. Also what recordRun's `model` column
 * gets, so a ledger row names what actually ran.
 */
export const VIDEO_DESCRIBE_MODEL = "gemini-3-8-flash";

/**
 * kie's published credit rate — $0.005/credit. This is its FOURTH local
 * copy in this codebase (lib/kie.ts, lib/kie-balance.ts,
 * lib/kie-audio-describe.ts, now this file) rather than one shared export —
 * see lib/kie-audio-describe.ts's comment on CREDIT_USD for why: four
 * unrelated concerns, and importing the constant from whichever module
 * happened to define it first would tie them together for no reason. If
 * kie's rate ever moves, all four copies are found by grepping for the
 * number, which is exactly as reliable as grepping for an import and does
 * not require deciding which of four unrelated files should own it.
 */
const CREDIT_USD = 0.005;

/**
 * The spend-cap ESTIMATE checked BEFORE this module is ever called — same
 * role as AUDIO_DESCRIBE_ESTIMATE_USD, and the same reasoning: the real
 * bill only exists after the money is spent.
 *
 * MEASURED, not guessed, from the 2026-09-09 probe in this file's header:
 * the highest credits_consumed observed across every genuine (non-invented)
 * call was 0.03, which is 0.03 * CREDIT_USD = $0.00015. Rounded up to
 * $0.0002 for the same reason audio rounds up to a full tenth of a cent —
 * one afternoon's receipts, not a table relating credits to clip length,
 * and a cap check has to sit comfortably above what a longer clip within
 * MAX_DESCRIBABLE_VIDEO_BYTES actually costs rather than assume every clip
 * prices like the sampled ones.
 */
export const VIDEO_DESCRIBE_ESTIMATE_USD = 0.0002;

/**
 * The hard ceiling on a clip this module will even ATTEMPT to send to kie,
 * checked against the clip's RAW byte length before any network call.
 *
 * THIS EXISTS TO STAY AWAY FROM A SILENT FAILURE, NOT TO STAY UNDER A
 * DOCUMENTED API LIMIT. Read the header's dangerous finding again before
 * touching this number: kie's media part silently vanishes above 25 MiB of
 * base64 (18.75MB raw, 26214400 * 3/4 bytes) and kie does NOT error when it
 * does — it returns 200 and fabricates a description with no signal in the
 * HTTP response that anything went wrong. The real, DOCUMENTED body limit
 * (30 MiB total, HTTP 413) sits nearly 5MB past that and would let this
 * constant climb all the way to ~23.6MB raw if it were the only thing being
 * respected here. It is not the thing being respected here.
 *
 * 15MB leaves 3.75MB of margin below the 18.75MB invention line, and
 * matches MAX_REFERENCE_AUDIO_BYTES (lib/file-type.ts) so an operator has
 * ONE number to remember for "how big can a reference file be", not two
 * nearly-equal numbers with different origins and different failure modes.
 *
 * DO NOT raise this toward 18.75MB "to allow bigger clips" — every byte of
 * margin given back is a byte closer to the band where kie invents a
 * description that reads as confidently as a real one, gets written to
 * elements.description, gets substituted into every prompt that tags that
 * element, and gets paid for in a render of a video that was never looked
 * at. MIN_PROMPT_TOKENS_FOR_A_REAL_READ below is the second guard against
 * that same failure, not a substitute for keeping this number where it is.
 */
export const MAX_DESCRIBABLE_VIDEO_BYTES = 15 * 1024 * 1024;

/**
 * The ONLY available signal that separates a clip kie genuinely watched
 * from a clip whose media part it silently dropped and answered from the
 * instruction text alone — see the header's dangerous finding.
 *
 * MEASURED populations, same probe: instruction-only (invented) responses
 * carried usageMetadata.promptTokenCount of 11 and 33; genuinely-read clips
 * carried 137 and 200. 100 sits clear of both clusters with room on either
 * side. The HTTP status is 200 either way, the response shape is identical
 * either way, the JSON parses either way, the schema validates either way,
 * and credits are charged either way — this count is the one field that
 * tells the two cases apart, which is why describeReferenceVideo checks it
 * before touching anything else in the response, and why it is a named,
 * exported constant rather than a bare `100` buried in an if-statement: a
 * test needs to assert against this exact line, and the next person reading
 * this file needs to find the number without re-deriving it from the probe
 * above.
 */
export const MIN_PROMPT_TOKENS_FOR_A_REAL_READ = 100;

/**
 * The clip was reached and BILLED (or, for the size guard, never sent at
 * all) and is still not usable. Mirrors AudioDescribeUnusableError exactly,
 * including why costUsd is carried rather than left for the caller's catch
 * block to record as null: when kie answered and charged, the exact figure
 * came back in the same response as the refusal, and null would be a
 * thrown-away receipt. Every other failure in this module stays a plain
 * Error, so the caller keeps recording null for the cases where null is
 * the truth — a network failure, an unparseable body, or (below) a clip
 * that never left this process because it failed the size guard before any
 * request was made.
 */
export class VideoDescribeUnusableError extends Error {
  readonly costUsd: number | null;
  constructor(message: string, costUsd: number | null) {
    super(message);
    this.name = "VideoDescribeUnusableError";
    this.costUsd = costUsd;
  }
}

const VideoDescriptionSchema = z.object({
  subject: z.string(),
  setting: z.string(),
  motion: z.string(),
  camera: z.string(),
  usable: z.boolean(),
  problem: z.string().optional(),
});
type VideoDescriptionJson = z.infer<typeof VideoDescriptionSchema>;

export interface DescribeReferenceVideoArgs {
  /**
   * Signed URL to the stored mp4, for a clip already in storage — the
   * redescribe path, mirroring DescribeReferenceAudioArgs.videoUrl's sibling
   * field. This module downloads the bytes itself rather than handing kie
   * the URL — see file header, "UNLIKE describeReferenceImage."
   */
  videoUrl?: string;
  /**
   * The clip itself, base64-encoded, for a file that has NOT been uploaded
   * yet — the describe-on-save path, while the bytes are still an in-memory
   * File, before uploadFile ever runs. Ignored when videoUrl is set.
   */
  videoBase64?: string;
  /** Required with videoBase64: the clip's own content type, e.g. "video/mp4". */
  mediaType?: string;
  /** The element's own name, for context only. Never quoted back. */
  name?: string;
  /**
   * 'video' since 0093_video_reference_elements.sql.
   *
   * NOTHING BRANCHES ON IT, AND THAT IS NOT THE SAME AS "CONTEXT ONLY" — see
   * DescribeReferenceAudioArgs.category's identical warning:
   * describeRoleLine interpolates it into `instruction`, and `instruction`
   * is parts[0].text in the POST below. The word travels to kie inside a
   * request body on every video upload.
   */
  category?: string | null;
}

export interface DescribeReferenceVideoResult {
  description: string;
  /**
   * The REAL amount this call is known to have cost, in USD — from the
   * response's own credits_consumed, never the estimate above. Null when
   * the response carried no usable credits_consumed figure, OR when no
   * request was ever made (the size guard rejected the clip first) — mirrors
   * lib/kie-audio-describe.ts's DescribeReferenceAudioResult.costUsd
   * contract exactly, including on a successful call: an unreported charge
   * is unknown, not zero.
   */
  costUsd: number | null;
}

// Test seam — mirrors lib/kie-audio-describe.ts's own
// __setKieAudioFetchForTests. A separate module-local variable rather than
// importing that one, even though both modules call the exact same kie
// endpoint and model: a test faking one describe call must not be able to
// accidentally intercept the other's, and this module owning its own seam
// means nothing about it can drift by editing lib/kie-audio-describe.ts.
let fetchImpl: typeof fetch = fetch;

export function __setKieVideoFetchForTests(impl: typeof fetch): void {
  fetchImpl = impl;
}

export function __resetKieVideoTestSeams(): void {
  fetchImpl = fetch;
}

function apiKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) {
    throw new Error("KIE_API_KEY is not set — cannot describe a video reference.");
  }
  return key;
}

/**
 * Downloads the clip itself, since kie's Gemini endpoint takes bytes, not a
 * URL it fetches on our behalf (see file header). The stored content-type
 * (set at upload time by lib/storage.ts's uploadFile) comes back on the
 * signed URL's own response; falls back to video/mp4 only when that header
 * is missing or generic — file-type.ts's isAcceptedReferenceVideo only ever
 * admits .mp4, so a generic fallback is always the correct guess, never a
 * mistyped .mov or similar.
 *
 * Returns rawBytes alongside the encoded string so the size guard below can
 * check the clip's ACTUAL byte length rather than the base64 string's
 * length (which is ~4/3 larger and would silently shrink the effective
 * ceiling if ever compared directly against MAX_DESCRIBABLE_VIDEO_BYTES).
 */
async function downloadVideoAsBase64(
  videoUrl: string,
): Promise<{ base64: string; mediaType: string; rawBytes: number }> {
  let response: Response;
  try {
    response = await fetch(videoUrl);
  } catch (err) {
    throw new Error(
      `Could not download that video clip: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Could not download that video clip (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("content-type");
  const mediaType =
    contentType && contentType !== "application/octet-stream" ? contentType : "video/mp4";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { base64: buffer.toString("base64"), mediaType, rawBytes: buffer.length };
}

/**
 * The one set of bytes this module ever hands to kie, from whichever source
 * the caller supplied — mirrors lib/kie-audio-describe.ts's
 * resolveAudioBytes exactly, including the throw for "neither field was
 * set", a shape TS cannot rule out because both fields on
 * DescribeReferenceVideoArgs are optional so either call site compiles.
 *
 * The videoBase64 branch DECODES the string once to get rawBytes — the
 * caller already holds the encoded string, not the original File, by the
 * time this runs (describe-on-save calls this while uploadFile has not
 * run yet, so there is no File.size sitting nearby to read instead). A
 * clip small enough to pass the size guard is small enough that decoding it
 * once, here, costs nothing next to the 11-23s network round trip the
 * caller is about to make.
 */
async function resolveVideoBytes(
  args: DescribeReferenceVideoArgs,
): Promise<{ base64: string; mediaType: string; rawBytes: number }> {
  if (args.videoUrl) return downloadVideoAsBase64(args.videoUrl);
  if (args.videoBase64 && args.mediaType) {
    return {
      base64: args.videoBase64,
      mediaType: args.mediaType,
      rawBytes: Buffer.from(args.videoBase64, "base64").byteLength,
    };
  }
  throw new Error("describeReferenceVideo: needs either videoUrl, or videoBase64 with mediaType.");
}

/** Drops one trailing period so clauses can be joined without a full stop between them. */
function asClause(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

/**
 * subject + setting + motion + camera, joined into ONE PHRASE rather than
 * four sentences — same reasoning as lib/kie-audio-describe.ts's
 * composeDescription, copied here because the constraint is identical: this
 * text is spliced in at the position of the operator's @new_video1 tag,
 * mid-sentence, not appended as its own paragraph. Four short sentences with
 * full stops would read as a caption dropped into the middle of somebody
 * else's clause; four clauses joined by commas read as one continuous
 * description, which is what a render prompt needs it to be.
 *
 * All four fields are required by the schema and re-checked non-empty below
 * (the "usable but empty" guard) before this ever runs, so there is no
 * empty-clause case here to filter out.
 */
function composeDescription(data: VideoDescriptionJson): string {
  return `${asClause(data.subject)}, ${asClause(data.setting)}, ${asClause(data.motion)}, ${asClause(data.camera)}`;
}

/**
 * Describes one saved video reference by watching it, once. Cached by the
 * caller on elements.ai_description (0072), same as describeReferenceAudio
 * and describeReferenceImage — this is the AI step; every prompt that later
 * types "@new_video1" is plain string substitution against what this wrote.
 */
export async function describeReferenceVideo(
  args: DescribeReferenceVideoArgs,
): Promise<DescribeReferenceVideoResult> {
  if (isDev()) {
    return {
      description:
        `a ${args.category ?? "reference"} video, described from the attached clip ` +
        "(MOCK_KIE fixture)",
      costUsd: null,
    };
  }

  const { base64, mediaType, rawBytes } = await resolveVideoBytes(args);

  // THE FIRST GUARD, and cheaper than the second: reject before kie is ever
  // called, so a clip in the invention band never has the chance to be
  // invented about. See MAX_DESCRIBABLE_VIDEO_BYTES for the arithmetic. This
  // does not depend on kie's honesty in any way — it is checked against
  // bytes this process already holds, before the network call that could
  // silently mishandle them.
  if (rawBytes > MAX_DESCRIBABLE_VIDEO_BYTES) {
    throw new VideoDescribeUnusableError(
      "That video is too large to read reliably — write the description yourself.",
      null,
    );
  }

  const roleLine = describeRoleLine(args.category);

  const instruction =
    "Watch this video clip, all the way through, and describe it for a scene-generation " +
    "model that will never see it — only the words you write. Cover the subject (who or " +
    "what is in frame), the setting, what happens over time (any action or motion), and any " +
    "camera movement (static, pan, zoom, handheld, or similar). Also say whether the clip is " +
    "usable as a visual reference at all — a black or blank frame, a corrupted or unreadable " +
    "file, or a clip with nothing distinguishable in it is not. " +
    `${roleLine}One or two sentences per field. No preamble.`;

  let response: Response;
  try {
    response = await fetchImpl(
      `${BASE_URL}/gemini/v1/models/${VIDEO_DESCRIBE_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: instruction }, { inlineData: { mimeType: mediaType, data: base64 } }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                subject: { type: "STRING" },
                setting: { type: "STRING" },
                motion: { type: "STRING" },
                camera: { type: "STRING" },
                usable: { type: "BOOLEAN" },
                problem: { type: "STRING" },
              },
              required: ["subject", "setting", "motion", "camera", "usable"],
            },
          },
        }),
      },
    );
  } catch (err) {
    throw new Error(
      `kie Gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`kie Gemini HTTP ${response.status}: ${body || response.statusText}`);
  }

  const envelope = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number };
    credits_consumed?: number;
  };

  const credits = envelope.credits_consumed;
  const costUsd = typeof credits === "number" ? credits * CREDIT_USD : null;

  // THE SECOND GUARD, and the most important code in this file — see this
  // file's header ("THE DANGEROUS FINDING") and MIN_PROMPT_TOKENS_FOR_A_REAL_READ
  // for the measured populations behind the number below. Checked BEFORE any
  // other field of this response is read: the HTTP status is 200, the JSON
  // will parse, and the schema will validate whether or not kie actually
  // looked at the video, so none of those checks can catch what this one
  // catches. A clip that fails this check is billed (costUsd above is
  // already computed) and gets nothing written to elements.description —
  // the alternative is a vivid, confident, entirely fabricated description
  // of a video nobody watched, silently promoted into every prompt that
  // later tags this element and into a paid render built on it.
  const promptTokenCount = envelope.usageMetadata?.promptTokenCount;
  if (
    typeof promptTokenCount !== "number" ||
    promptTokenCount < MIN_PROMPT_TOKENS_FOR_A_REAL_READ
  ) {
    throw new VideoDescribeUnusableError(
      "That video could not be read — write the description yourself.",
      costUsd,
    );
  }

  const raw = envelope.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    throw new Error("kie Gemini returned no describable content for that clip.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error("kie Gemini's response was not parseable JSON.");
  }

  const parsed = VideoDescriptionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `kie Gemini's response did not match the expected shape: ${parsed.error.message}`,
    );
  }

  if (!parsed.data.usable) {
    throw new VideoDescribeUnusableError(
      `That clip could not be used as a visual reference` +
        `${parsed.data.problem ? ` (${parsed.data.problem})` : ""} — write the description yourself.`,
      costUsd,
    );
  }

  // USABLE BUT EMPTY, which the schema alone cannot catch: z.string() accepts
  // "", so a response of usable:true with blank fields parses cleanly and
  // would compose into a description that is mostly commas — a billed call
  // writing near-nothing into ai_description, and from there into every
  // prompt that ever tags this video. Nothing said so. Same failure,
  // same fix, as lib/kie-audio-describe.ts's identical guard on voice and
  // delivery; checked AFTER `usable` so a well-formed refusal still reports
  // its own `problem` string rather than this generic one.
  if (
    !asClause(parsed.data.subject) ||
    !asClause(parsed.data.setting) ||
    !asClause(parsed.data.motion) ||
    !asClause(parsed.data.camera)
  ) {
    throw new VideoDescribeUnusableError(
      "That clip came back described as usable but with nothing written about it — " +
        "write the description yourself, or try again.",
      costUsd,
    );
  }

  return { description: composeDescription(parsed.data), costUsd };
}
