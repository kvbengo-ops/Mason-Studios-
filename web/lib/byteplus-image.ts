import "server-only";

import type { ImageAspectRatio } from "./image-aspect-ratios";
import type { ImageResolutionId } from "./image-resolutions";

/**
 * Seedream 5.0 Pro TEXT-TO-IMAGE on BytePlus ModelArk, the same account the worker
 * renders Seedance 2.5 with (BYTEPLUS_API_KEY). Faces generated here are accepted as
 * Seedance 2.5 references, which Kie's Seedream faces are not: BytePlus trusts its own
 * Seedream 5.0 text-to-image outputs for 30 days, same account only
 * (docs.byteplus.com/en/docs/modelark/seedance-portrait-asset-guide), and a 2026-11-09
 * test passed 4 of 4 such faces through Seedance, re-encoded ones included.
 *
 * Text-to-image only. Image-to-image stays on Kie: its outputs are not on BytePlus's
 * trusted list, and this API is synchronous — Seedream's reference path ran 131-149s on
 * Kie, which the platform proxy cuts off mid-request, losing a billed image. Kie's
 * task-id recovery handles that; this call has no task id to recover by.
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
    "3:4": "864x1152",
    "2:3": "832x1248",
    "16:9": "1280x720",
    "4:3": "1152x864",
    "3:2": "1248x832",
    "21:9": "1512x648",
  },
  "2K": {
    "9:16": "1440x2560",
    "1:1": "2048x2048",
    "3:4": "1728x2304",
    "2:3": "1664x2496",
    "16:9": "2560x1440",
    "4:3": "2304x1728",
    "3:2": "2496x1664",
    "21:9": "3024x1296",
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
}): Promise<{ url: string; costUsd: number }> {
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
