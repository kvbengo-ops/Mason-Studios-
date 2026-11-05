import "server-only";

import {
  compileImageSequence as mockImageSequence,
  IMAGE_SEQUENCE_SYSTEM_PROMPT,
  ImageSequence,
  MAX_SEQUENCE_BEATS,
} from "./claude";
import { isDev } from "./mode";

const BASE_URL = "https://api.kie.ai";
export const KIE_IMAGE_SEQUENCE_MODEL = "gemini-3-8-flash";
export const KIE_IMAGE_SEQUENCE_VENDOR = "kie";
const CREDIT_USD = 0.005;

export interface CompiledImageSequence {
  sequence: ImageSequence;
  costUsd: number | null;
}

export class KieImageSequenceError extends Error {
  constructor(
    message: string,
    readonly costUsd: number | null = null,
  ) {
    super(message);
    this.name = "KieImageSequenceError";
  }
}

let fetchImpl: typeof fetch = fetch;

export function __setKieImageSequenceFetchForTests(impl: typeof fetch): void {
  fetchImpl = impl;
}

export function __resetKieImageSequenceTestSeams(): void {
  fetchImpl = fetch;
}

function creditsToUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value * CREDIT_USD
    : null;
}

export async function compileImageSequenceWithKie(args: {
  request: string;
}): Promise<CompiledImageSequence> {
  if (isDev()) {
    return { sequence: await mockImageSequence(args), costUsd: null };
  }

  const key = process.env.KIE_API_KEY;
  if (!key) throw new KieImageSequenceError("KIE_API_KEY is not set.");

  let response: Response;
  try {
    response = await fetchImpl(
      `${BASE_URL}/gemini/v1/models/${KIE_IMAGE_SEQUENCE_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: args.request }] }],
          systemInstruction: { parts: [{ text: IMAGE_SEQUENCE_SYSTEM_PROMPT }] },
          generationConfig: {
            maxOutputTokens: 1500,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                beats: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: { prompt: { type: "STRING" } },
                    required: ["prompt"],
                  },
                },
              },
              required: ["beats"],
            },
          },
        }),
      },
    );
  } catch (error) {
    throw new KieImageSequenceError(
      `KIE Gemini request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let envelope: {
    code?: number;
    msg?: string;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    credits_consumed?: number;
  };
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch {
    throw new KieImageSequenceError(`KIE Gemini returned invalid JSON (HTTP ${response.status}).`);
  }

  const costUsd = creditsToUsd(envelope.credits_consumed);
  if (!response.ok || (envelope.code !== undefined && envelope.code !== 200)) {
    throw new KieImageSequenceError(
      `KIE Gemini error: ${envelope.msg ?? `HTTP ${response.status}`}`,
      costUsd,
    );
  }

  const raw = envelope.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new KieImageSequenceError("KIE Gemini returned no sequence.", costUsd);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KieImageSequenceError("KIE Gemini returned invalid sequence JSON.", costUsd);
  }

  const result = ImageSequence.safeParse(parsed);
  if (!result.success) {
    throw new KieImageSequenceError(
      `KIE Gemini returned an invalid sequence: ${result.error.message}`,
      costUsd,
    );
  }

  if (result.data.beats.length > MAX_SEQUENCE_BEATS) {
    throw new KieImageSequenceError("KIE Gemini returned too many sequence beats.", costUsd);
  }

  if (costUsd === null) {
    throw new KieImageSequenceError("KIE Gemini response did not include usage cost.");
  }

  return { sequence: result.data, costUsd };
}
