import "server-only";

import { z } from "zod";
import { describeRoleLine } from "./describe-role-line";
import { isDev } from "./mode";

export const IMAGE_DESCRIBE_MODEL = "gemini-3-8-flash";
// shortcut: image estimate has no paid receipt yet; tune after the first Gemini image charge.
export { IMAGE_DESCRIBE_ESTIMATE_USD } from "./element-describe-cost";

const ReferenceDescription = z.object({ description: z.string().trim().min(1) });

export interface DescribeReferenceArgs {
  imageUrl?: string;
  imageBase64?: string;
  mediaType?: string;
  name?: string;
  category?: string | null;
}

export interface DescribeReferenceResult {
  description: string;
  costUsd: number | null;
}

export class KieImageDescribeError extends Error {
  constructor(
    message: string,
    readonly costUsd: number | null = null,
  ) {
    super(message);
    this.name = "KieImageDescribeError";
  }
}

let fetchImpl: typeof fetch = fetch;

export function __setKieImageFetchForTests(impl: typeof fetch): void {
  fetchImpl = impl;
}

export function __resetKieImageTestSeams(): void {
  fetchImpl = fetch;
}

async function imageBytes(
  args: DescribeReferenceArgs,
): Promise<{ base64: string; mediaType: string }> {
  if (args.imageUrl) {
    const response = await fetch(args.imageUrl);
    if (!response.ok) throw new Error(`Could not download that image (HTTP ${response.status}).`);
    const mediaType = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) {
      throw new Error("Stored reference is not a JPG, PNG or WebP image.");
    }
    return { base64: Buffer.from(await response.arrayBuffer()).toString("base64"), mediaType };
  }
  if (args.imageBase64 && args.mediaType) {
    return { base64: args.imageBase64, mediaType: args.mediaType };
  }
  throw new Error("describeReferenceImage: needs either imageUrl, or imageBase64 with mediaType.");
}

export async function describeReferenceImage(
  args: DescribeReferenceArgs,
): Promise<DescribeReferenceResult> {
  if (isDev()) {
    return {
      description:
        `a ${args.category ?? "reference"} subject, described from the attached photograph ` +
        "(MOCK_KIE fixture)",
      costUsd: null,
    };
  }

  const { base64, mediaType } = await imageBytes(args);
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("KIE_API_KEY is not set — cannot describe an image reference.");
  const roleLine = describeRoleLine(args.category);
  const instruction =
    "You describe the SUBJECT of a reference photograph, for a video model that will never " +
    "see the photograph itself — only the words you write here. Your words are the whole " +
    "reference, and they will be spliced into a prompt that puts this subject somewhere " +
    "else entirely.\n\n" +
    "DESCRIBE THE SUBJECT, NEVER THE PICTURE. A reference is very often a contact sheet or " +
    "turnaround — the same person or product repeated in several views, on a plain studio " +
    "backdrop. That layout is how the reference was PHOTOGRAPHED and has nothing to do with " +
    "the scene being generated. Never write that the subject is shown in multiple views, " +
    "never number or name the views, and never mention the backdrop or the studio. Write " +
    "one description of one subject, as if you had seen them once.\n\n" +
    "A description that says 'shown in three views against a neutral grey background' gets " +
    "pasted into a prompt about a kitchen, and then the prompt contradicts itself.\n\n" +
    "SPEND THE WORDS ON IDENTITY. What matters is recognising this exact person or object " +
    "again in a different shot. For a person: apparent age in years, face shape, skin, eye " +
    "colour, and hair — its length, colour, texture and how it falls — then build, then " +
    "clothing. Age and hair are what a video model most often gets wrong, so be decisive " +
    "about both rather than hedging. For a product: form, material, colour and the layout " +
    "of its packaging. For a place: surfaces, light and character.\n\n" +
    "Describe ONLY what is in the picture. Do not invent, do not write marketing copy, and " +
    "do not describe the photograph as a photograph — no mention of framing, background " +
    "blur, lighting setup or camera. Those come from the prompt this will be spliced into, " +
    "and repeating them here would fight it.\n\n" +
    "NEVER transcribe text. If the subject carries printed words — a logo, a wordmark, a " +
    "sign, a label — describe their colour, size and placement and stop there. A video model " +
    "draws what you describe, so a quoted word comes back painted into the frame.\n\n" +
    `${roleLine}Describe what is in this picture. One or two sentences. No preamble.`;

  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.kie.ai/gemini/v1/models/${IMAGE_DESCRIBE_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: instruction }, { inlineData: { mimeType: mediaType, data: base64 } }],
            },
          ],
          generationConfig: {
            // Keep output uncapped: Gemini counts thinking tokens against maxOutputTokens.
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: { description: { type: "STRING" } },
              required: ["description"],
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
  let envelope: {
    code?: number;
    msg?: string;
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
    credits_consumed?: number;
  };
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch {
    throw new KieImageDescribeError(`kie Gemini returned invalid JSON (HTTP ${response.status}).`);
  }
  const credits = envelope.credits_consumed;
  const costUsd =
    typeof credits === "number" && Number.isFinite(credits) && credits >= 0
      ? credits * 0.005
      : null;
  if (!response.ok || (envelope.code !== undefined && envelope.code !== 200)) {
    throw new KieImageDescribeError(
      `kie Gemini error: ${envelope.msg ?? `HTTP ${response.status}`}`,
      costUsd,
    );
  }
  const raw = envelope.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new KieImageDescribeError("kie Gemini returned no image description.", costUsd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const finishReason = envelope.candidates?.[0]?.finishReason;
    throw new KieImageDescribeError(
      `kie Gemini's image description was not parseable JSON${finishReason ? ` (finish_reason: ${finishReason})` : ""}.`,
      costUsd,
    );
  }
  const result = ReferenceDescription.safeParse(parsed);
  if (!result.success) {
    throw new KieImageDescribeError(
      "kie Gemini returned an empty or invalid image description.",
      costUsd,
    );
  }
  return { description: result.data.description, costUsd };
}
