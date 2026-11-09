import "server-only";

import type { ImageAspectRatio } from "./image-aspect-ratios";
import type { ImageResolutionId } from "./image-resolutions";

/**
 * Seedream 5.0 Pro on BytePlus ModelArk — the only vendor Seedream runs on — under the
 * same account the worker renders Seedance 2.5 with (BYTEPLUS_API_KEY). Faces generated
 * here are accepted as Seedance 2.5 references: BytePlus trusts its own Seedream 5.0
 * text-to-image outputs for 30 days, same account only
 * (docs.byteplus.com/en/docs/modelark/seedance-portrait-asset-guide), and a 2026-11-09
 * test passed 4 of 4 such faces through Seedance, re-encoded ones included.
 *
 * Reference calls (`image`) run here too. BytePlus's docs list only text-to-image as
 * trusted; the re-encoded faces passing suggests its own outputs are not flagged at all.
 */

const ENDPOINT = "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";
const DEFAULT_MODEL = "dola-seedream-5-0-pro-260628";
// Generous for a measured 33-42s call, and still under the platform proxy's cut.
const TIMEOUT_MS = 90_000;

/**
 * BytePlus's published Seedream 5.0 Pro price per image: 1K and 1.5K share one rate,
 * 2K is the next. No receipt — BytePlus returns an image count, not dollars — so this
 * is the published rate the owner's 2026-10-30 rule allows selling.
 */
export const BYTEPLUS_SEEDREAM_USD: Readonly<Record<"1K" | "2K", number>> = {
  "1K": 0.045,
  "2K": 0.09,
};

/**
 * Explicit pixels per ratio and tier. Seedream 5.0 Pro takes `WxH` with 921,600 to
 * 4,624,220 total pixels; 1K values sit just above the floor, 2K under the ceiling.
 */
export const BYTEPLUS_SEEDREAM_SIZES: Readonly<
  Record<"1K" | "2K", Partial<Record<ImageAspectRatio, string>>>
> = {
  "1K": {
    "9:16": "720x1280",
    "1:1": "1024x1024",
    "16:9": "1280x720",
  },
  "2K": {
    "9:16": "1440x2560",
    "1:1": "2048x2048",
    "16:9": "2560x1440",
  },
};

export class BytePlusImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BytePlusImageError";
  }
}

let fetchImpl: typeof fetch = fetch;
export function __setBytePlusImageFetchForTests(impl: typeof fetch): void {
  fetchImpl = impl;
}

export async function generateBytePlusSeedreamImage(args: {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  resolution: ImageResolutionId;
  /** Reference images, in prompt order. Seedream 5.0 Pro takes 1, or 2-10. */
  refImageUrls?: readonly string[];
}): Promise<{ url: string; costUsd: number }> {
  const refs = args.refImageUrls ?? [];
  if (refs.length > 10) {
    throw new BytePlusImageError("Seedream 5.0 Pro takes at most 10 reference images.");
  }
  const apiKey = process.env.BYTEPLUS_API_KEY;
  if (!apiKey) throw new BytePlusImageError("BYTEPLUS_API_KEY is not set on the web service.");
  if (args.resolution !== "1K" && args.resolution !== "2K") {
    throw new BytePlusImageError(`Seedream 5.0 Pro does not offer ${args.resolution}.`);
  }
  const size = BYTEPLUS_SEEDREAM_SIZES[args.resolution][args.aspectRatio];
  if (!size) throw new BytePlusImageError(`Seedream 5.0 Pro does not offer ${args.aspectRatio}.`);

  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.BYTEPLUS_SEEDREAM_MODEL || DEFAULT_MODEL,
        prompt: args.prompt,
        ...(refs.length === 1 ? { image: refs[0] } : refs.length > 1 ? { image: refs } : {}),
        size,
        response_format: "url",
        watermark: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // shortcut: a lost connection after BytePlus started may still bill one image, and
    // with no task id this attempt is released, not held; hold it if that ever shows up.
    throw new BytePlusImageError(
      `BytePlus image request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    data?: { url?: string }[];
    usage?: { generated_images?: number };
    error?: { code?: string; message?: string };
  };
  const url = body.data?.[0]?.url;
  if (!response.ok || !url) {
    const why = body.error
      ? `${body.error.code}: ${body.error.message}`
      : `HTTP ${response.status}`;
    throw new BytePlusImageError(`BytePlus Seedream refused the request (${why}).`);
  }
  const images = body.usage?.generated_images ?? 1;
  return { url, costUsd: images * BYTEPLUS_SEEDREAM_USD[args.resolution] };
}
