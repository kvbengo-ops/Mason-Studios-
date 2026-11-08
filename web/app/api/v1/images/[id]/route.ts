import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-auth";
import { apiError } from "@/lib/api-v1";
import { reconcileImageAttemptFor } from "@/lib/image-generation";
import { signedUrlWithExpiry } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
// reconcileImageAttemptFor's not-found message; every other throw is a real failure.
const NOT_FOUND_MESSAGE = "This image attempt is no longer available.";

/**
 * GET /api/v1/images/{id} — one image attempt, finished on read the way the
 * /image-generator panel finishes it (one kie read, then settle/store), scoped
 * to the token's account. `output.element_id` is the Element the picture was
 * filed as, ready for a video's image_refs.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireApiToken(request, "read");
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return apiError("Image job was not found.", "not_found", 404);

  const admin = createAdminClient();
  try {
    const attempt = await reconcileImageAttemptFor(() => admin, auth.userId, id);

    let output = null;
    if (attempt.image) {
      const [{ data: asset }, { data: element }] = await Promise.all([
        admin
          .from("assets")
          .select("storage_key")
          .eq("id", attempt.image.assetId)
          .eq("user_id", auth.userId)
          .maybeSingle(),
        admin
          .from("elements")
          .select("id")
          .eq("asset_id", attempt.image.assetId)
          .eq("user_id", auth.userId)
          .is("deleted_at", null)
          .maybeSingle(),
      ]);
      if (asset) {
        const signed = await signedUrlWithExpiry(asset.storage_key);
        output = {
          asset_id: attempt.image.assetId,
          element_id: element?.id ?? null,
          download_url: signed.url,
          url_expires_in_s: signed.expiresInSeconds,
        };
      }
    }

    return NextResponse.json({
      job_id: attempt.runId,
      status: attempt.status,
      model: attempt.model,
      cost_usd: attempt.costUsd,
      reason: attempt.reason,
      output,
    });
  } catch (error) {
    if (error instanceof Error && error.message === NOT_FOUND_MESSAGE) {
      return apiError("Image job was not found.", "not_found", 404);
    }
    console.error(`GET /api/v1/images/${id} failed`, error);
    return apiError("Could not read this image job.", "image_job_failed", 500);
  }
}
