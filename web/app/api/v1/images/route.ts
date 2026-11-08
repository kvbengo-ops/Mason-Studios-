import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-auth";
import { apiError, readJsonObject } from "@/lib/api-v1";
import { generateImageFor } from "@/lib/image-generation";
import { IMAGE_MODELS } from "@/lib/models";

export const dynamic = "force-dynamic";

const ALLOWED_FIELDS = new Set(["prompt", "model", "aspect_ratio", "resolution"]);
const STRING_FIELDS = ["model", "aspect_ratio", "resolution"] as const;

/**
 * POST /api/v1/images — the personal Image Generator, as the token's account.
 *
 * The same core /image-generator runs (lib/image-generation.ts): atomic
 * reserve under the spend caps, Idempotency-Key as the attempt key, and the
 * finished picture filed as a private Element so a video can @tag it.
 * Asynchronous: a submitted attempt returns 202 + job_id; poll
 * GET /api/v1/images/{job_id}.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiToken(request, "generate");
  if (!auth.ok) return auth.response;

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128 || /[\r\n\0]/.test(idempotencyKey)) {
    return apiError(
      "A 1-128 character Idempotency-Key header is required.",
      "invalid_idempotency_key",
      400,
    );
  }

  const parsed = await readJsonObject(request);
  if (parsed.response) return parsed.response;
  const body = parsed.value;
  if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) {
    return apiError("Request contains an unknown field.", "unknown_field", 400);
  }
  if (typeof body.prompt !== "string") {
    return apiError("prompt is required.", "invalid_parameters", 400);
  }
  for (const key of STRING_FIELDS) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      return apiError(`${key} must be a string.`, "invalid_parameters", 400);
    }
  }
  // getImageModel falls back to the default for an unknown id; an API caller
  // naming a model must get that model or a refusal, never a different charge.
  if (body.model !== undefined && !IMAGE_MODELS.some((model) => model.id === body.model)) {
    return apiError(
      `Unknown image model. Use one of: ${IMAGE_MODELS.map((model) => model.id).join(", ")}.`,
      "unsupported_model",
      422,
    );
  }

  const form = new FormData();
  form.set("prompt", body.prompt);
  form.set("idempotencyKey", idempotencyKey);
  if (typeof body.model === "string") form.set("imageModel", body.model);
  if (typeof body.aspect_ratio === "string") form.set("aspectRatio", body.aspect_ratio);
  if (typeof body.resolution === "string") form.set("resolution", body.resolution);

  try {
    const result = await generateImageFor(
      { userId: auth.userId, profile: auth.profile, projectId: null },
      form,
      true,
    );
    if (result.pendingRunId !== undefined) {
      return NextResponse.json(
        { job_id: result.pendingRunId, status: "generating" },
        { status: 202 },
      );
    }
    if (result.image !== undefined) {
      return NextResponse.json({
        status: "completed",
        output: { asset_id: result.image.assetId, download_url: result.image.url },
      });
    }
    return apiError(result.error, result.keyExhausted ? "image_failed" : "image_refused", 422);
  } catch (error) {
    console.error("POST /api/v1/images failed", error);
    return apiError("Could not generate this image.", "image_failed", 500);
  }
}
