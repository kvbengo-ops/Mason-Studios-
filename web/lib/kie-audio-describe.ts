// kie's Gemini vision-audio pass — the one place this codebase asks a model
// to LISTEN to a saved voice reference and say what it heard.
//
// WHY THIS EXISTS. A /ugc scene can carry an audio reference
// (scene_references.kind = 'audio', an @voice1-style tag). The worker
// already sends that mp3 to Seedance as a `reference_audio_urls` timbre
// reference — that half worked from the start. What never existed is a
// word of PROSE about it: worker/internal/loop/dispatch.go's bindUITags
// DELETES an audio tag outright rather than leaving the bare word behind
// (an image tag degrades to its bare name; kie has no positional syntax for
// audio, so there is nothing to degrade to), which left prompts reading
// "Dialogue audio sourced entirely from ." — a sentence with a hole where
// the voice should have been described.
//
// actions/ugc.ts's resolveElementTags already substitutes ANY element's
// `description` into a prompt regardless of kind — the substitution
// machinery was never image-specific. The only reason an @voice1 tag never
// resolved to anything is that every audio element's `description` was
// empty; nothing had ever written one. This module is what writes one.
//
// VERIFIED against kie's live API on 2026-09-07, against a real production
// mp3, not a guess:
//   POST https://api.kie.ai/gemini/v1/models/gemini-3-8-flash:generateContent
//   Authorization: Bearer $KIE_API_KEY
//   { "contents": [{ "role": "user", "parts": [
//       { "text": "<instruction>" },
//       { "inlineData": { "mimeType": "audio/mpeg", "data": "<base64>" } }
//   ]}], "generationConfig": { "responseMimeType": "application/json",
//        "responseSchema": { ... } } }
// Returned, first attempt, credits_consumed: 0.03 and a body matching
// AudioDescriptionSchema below. :generateContent, never
// :streamGenerateContent — schema-constrained JSON only comes back whole on
// the blocking call, and a streamed response hands back fragments this
// module has no reassembler for.
//
// THE JSON IS A STRING, unlike Claude's response.parsed_output
// (lib/claude.ts's structured-output helper). Gemini's own structured-output
// shape serializes the schema's fields as TEXT inside
// candidates[0].content.parts[0].text, so it has to be JSON.parse'd and
// validated here rather than read as a nested object.
//
// This endpoint was verified with inlineData bytes, so this module downloads
// the clip itself before calling out, as the image describer now does.

import { z } from "zod";
import { describeRoleLine } from "./describe-role-line";
import { isDev } from "./mode";

const BASE_URL = "https://api.kie.ai";

/** kie's own id for the model this module calls and what recordRun's `model` column gets. */
export const AUDIO_DESCRIBE_MODEL = "gemini-3-8-flash";

/**
 * kie's published credit rate — $0.005/credit. lib/kie.ts (image generation)
 * and lib/kie-balance.ts (the account balance read) each already carry this
 * exact number as their OWN local constant rather than a shared export; see
 * lib/kie-balance.ts's comment on why. This is that number's third copy, for
 * the same reason: this file's concern (describing a voice clip) has nothing
 * to do with either of theirs, and importing one into this one would tie
 * three unrelated concerns to whichever happened to define the constant
 * first. Confirmed against worker/internal/kie/client.go's own creditUSD.
 */
const CREDIT_USD = 0.005;

/**
 * The spend-cap ESTIMATE checked BEFORE this module is ever called — the
 * real bill (credits_consumed on the response) is not known until after the
 * money is spent, and a cap that only runs after the spend is not a cap.
 *
 * MEASURED, not guessed: the verified call above billed 0.03 credits for one
 * ~5s clip, which is 0.03 * CREDIT_USD = $0.00015. Rounded up to a full
 * tenth of a cent rather than used to the fraction — this codebase has one
 * receipt, not a table relating credits to clip length, and a cap check has
 * to stay comfortably above whatever a longer clip (up to
 * MAX_REFERENCE_AUDIO_SECONDS, lib/file-type.ts) actually costs rather than
 * assume every clip prices like the one sample.
 */
export { AUDIO_DESCRIBE_ESTIMATE_USD } from "./element-describe-cost";

/**
 * The clip was reached, listened to and BILLED, and is still not usable.
 *
 * Carries the metered cost because the caller's catch block otherwise records
 * `costUsd: null` — the honest under-statement for a call whose charge is
 * unknown, but wrong here, where the exact figure came back in the same
 * response that reported the refusal. Null is the right answer for a network
 * failure or an unparseable body; it is a thrown-away receipt for this.
 *
 * Every other failure in this module stays a plain Error, so the caller keeps
 * recording null for the cases where null is the truth.
 */
export class AudioDescribeUnusableError extends Error {
  readonly costUsd: number | null;
  constructor(message: string, costUsd: number | null) {
    super(message);
    this.name = "AudioDescribeUnusableError";
    this.costUsd = costUsd;
  }
}

const AudioDescriptionSchema = z.object({
  voice: z.string(),
  delivery: z.string(),
  language: z.string(),
  transcript: z.string(),
  usable: z.boolean(),
  problem: z.string().optional(),
});
type AudioDescriptionJson = z.infer<typeof AudioDescriptionSchema>;

export interface DescribeReferenceAudioArgs {
  /**
   * Signed URL to the stored mp3/wav, for a clip already in storage — the
   * redescribe button (actions/ugc.ts's redescribeElement). This module
   * downloads the bytes itself rather than handing kie the URL.
   */
  audioUrl?: string;
  /**
   * Inline clip bytes, when the caller already has them. Ignored when
   * audioUrl is set.
   */
  audioBase64?: string;
  /** Required with audioBase64: the clip's own content type, e.g. "audio/mpeg". */
  mediaType?: string;
  /** The element's own name, for context only. Never quoted back. */
  name?: string;
  /**
   * 'audio' since 0081, or a pre-0081 category on an older row.
   *
   * NOTHING BRANCHES ON IT, AND THAT IS NOT THE SAME AS "CONTEXT ONLY", which
   * is what this said before and why the reach of the value was easy to miss:
   * describeRoleLine interpolates it into `instruction`, and `instruction` is
   * parts[0].text in the POST below. The word travels to kie inside a request
   * body on every audio description request.
   */
  category?: string | null;
}

export interface DescribeReferenceAudioResult {
  description: string;
  /**
   * The REAL amount this call is known to have cost, in USD — from the
   * response's own credits_consumed, never the estimate above. Null only
   * when the response carried no usable credits_consumed figure; mirrors
   * lib/kie.ts's GenerateImageResult.costUsd contract exactly, including on
   * a successful call — an unreported charge is unknown, not zero.
   */
  costUsd: number | null;
}

// Test seam — mirrors lib/kie.ts's own __setKieFetchForTests. A separate
// module-local variable rather than importing that one: the two clients hit
// different kie endpoints for different reasons, and a test faking one call
// must not be able to accidentally intercept the other.
let fetchImpl: typeof fetch = fetch;

export function __setKieAudioFetchForTests(impl: typeof fetch): void {
  fetchImpl = impl;
}

export function __resetKieAudioTestSeams(): void {
  fetchImpl = fetch;
}

function apiKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) {
    throw new Error("KIE_API_KEY is not set — cannot describe a voice reference.");
  }
  return key;
}

/**
 * Downloads the clip itself, since kie's Gemini endpoint takes bytes, not a
 * URL it fetches on our behalf (see file header). The stored content-type
 * (set at upload time by lib/storage.ts's uploadFile) comes back on the
 * signed URL's own response; falls back to audio/mpeg only when that header
 * is missing or generic, mirroring lib/storage.ts's uploadLibraryFromUrl.
 */
async function downloadAudioAsBase64(
  audioUrl: string,
): Promise<{ base64: string; mediaType: string }> {
  let response: Response;
  try {
    response = await fetch(audioUrl);
  } catch (err) {
    throw new Error(
      `Could not download that voice clip: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Could not download that voice clip (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("content-type");
  const mediaType =
    contentType && contentType !== "application/octet-stream" ? contentType : "audio/mpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { base64: buffer.toString("base64"), mediaType };
}

/**
 * The one set of bytes this module ever hands to kie, from whichever source
 * the caller supplied — a downloaded signed URL, or the raw file the caller
 * already holds. Mirrors lib/claude.ts's imageBlock exactly, including the
 * throw: both fields on DescribeReferenceAudioArgs are optional so either
 * call site compiles, and "neither was set" is a shape TS cannot rule out —
 * without this a silent request with no clip would reach kie describing
 * nothing at all.
 */
async function resolveAudioBytes(
  args: DescribeReferenceAudioArgs,
): Promise<{ base64: string; mediaType: string }> {
  if (args.audioUrl) return downloadAudioAsBase64(args.audioUrl);
  if (args.audioBase64 && args.mediaType) {
    return { base64: args.audioBase64, mediaType: args.mediaType };
  }
  throw new Error("describeReferenceAudio: needs either audioUrl, or audioBase64 with mediaType.");
}

/** Drops one trailing period so two clauses can be joined without a full stop between them. */
function asClause(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

/**
 * voice + delivery, joined into ONE NOUN PHRASE rather than two sentences.
 *
 * This text is spliced in at the position of the operator's tag, mid-sentence
 * — substituteElementTags replaces "@voice1" in place, it does not append a
 * paragraph. So the shape has to survive being dropped into the middle of
 * somebody else's clause.
 *
 * It used to return `${voice}. Delivery: ${delivery}.` and an operator who
 * wrote "speaks to camera in @voice1" got a full stop and a bare "Delivery:"
 * label wedged inside their own phrase:
 *
 *   …speaks to camera in a mature female voice with a standard German
 *   accent. Delivery: calm and deliberate with measured pacing.
 *
 * An IMAGE description gets away with the sentence shape because it is
 * already a noun phrase ("a woman in her fifties, silver-grey bob") and
 * slides into a sentence unaltered. A voice description written as prose does
 * not, and the model reads what we send it literally — the whole point of
 * describing the clip was to hand it a clean sentence.
 *
 * The transcript is deliberately LEFT OUT — it is what the REFERENCE clip
 * said, not what the new scene's dialogue will say, and pasting it into a
 * prompt for a different scene would read as an instruction to repeat those
 * exact words. Its only job here is deciding `usable` below.
 */
function composeDescription(data: AudioDescriptionJson): string {
  return `${asClause(data.voice)}, ${asClause(data.delivery)}`;
}

/**
 * Describes one saved voice reference by listening to it, once. Cached by
 * the caller on elements.ai_description (0072), the same as
 * describeReferenceImage — this is the AI step; every prompt that later
 * types "@voice1" is plain string substitution against what this wrote.
 */
export async function describeReferenceAudio(
  args: DescribeReferenceAudioArgs,
): Promise<DescribeReferenceAudioResult> {
  if (isDev()) {
    return {
      description:
        `a ${args.category ?? "reference"} voice, described from the attached clip ` +
        "(MOCK_KIE fixture)",
      costUsd: null,
    };
  }

  const { base64, mediaType } = await resolveAudioBytes(args);
  const roleLine = describeRoleLine(args.category);

  const instruction =
    "Listen to this voice clip and describe it for a video model that will never hear it — " +
    "only the words you write. Cover apparent age and gender, the timbre and accent of the " +
    "voice, and the delivery: pace, tone, energy. Also transcribe what is said, name the " +
    "spoken language as a BCP-47 tag, and say whether the clip is usable as a voice reference " +
    "at all — silence, music with no speech, or speech buried in heavy noise is not. " +
    `${roleLine}One or two sentences for voice and delivery. No preamble.`;

  let response: Response;
  try {
    response = await fetchImpl(
      `${BASE_URL}/gemini/v1/models/${AUDIO_DESCRIBE_MODEL}:generateContent`,
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
                voice: { type: "STRING" },
                delivery: { type: "STRING" },
                language: { type: "STRING" },
                transcript: { type: "STRING" },
                usable: { type: "BOOLEAN" },
                problem: { type: "STRING" },
              },
              required: ["voice", "delivery", "language", "transcript", "usable"],
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
    credits_consumed?: number;
  };

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

  const parsed = AudioDescriptionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `kie Gemini's response did not match the expected shape: ${parsed.error.message}`,
    );
  }

  const credits = envelope.credits_consumed;
  const costUsd = typeof credits === "number" ? credits * CREDIT_USD : null;

  if (!parsed.data.usable) {
    throw new AudioDescribeUnusableError(
      `That clip could not be used as a voice reference` +
        `${parsed.data.problem ? ` (${parsed.data.problem})` : ""} — write the description yourself.`,
      costUsd,
    );
  }

  // USABLE BUT EMPTY, which the schema alone cannot catch: z.string() accepts
  // "", so a response of usable:true with blank voice and delivery parses
  // cleanly and used to compose ". Delivery: ." — a billed call writing
  // punctuation into ai_description, and from there into every prompt that
  // ever tags this voice. Nothing said so.
  //
  // Treated as unusable rather than repaired, and it takes the same operator
  // message: a model that says a clip is usable and then describes nothing has
  // told us nothing, and writing a partial description would be a quieter
  // version of the same bug. Checked AFTER `usable` so a well-formed refusal
  // still reports its own `problem` string rather than this generic one.
  if (!asClause(parsed.data.voice) || !asClause(parsed.data.delivery)) {
    throw new AudioDescribeUnusableError(
      "That clip came back described as usable but with nothing written about the voice — " +
        "write the description yourself, or try again.",
      costUsd,
    );
  }

  return { description: composeDescription(parsed.data), costUsd };
}
