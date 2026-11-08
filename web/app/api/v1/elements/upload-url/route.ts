import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-auth";
import { createStagedUploadUrl, MEDIA_BUCKET } from "@/lib/storage";
import { apiError } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiToken(request, "upload");
  if (!auth.ok) return auth.response;

  try {
    const staged = await createStagedUploadUrl(auth.userId);
    return NextResponse.json({
      bucket: MEDIA_BUCKET,
      staged_key: staged.key,
      upload_url: staged.signedUrl,
      method: "PUT",
      token: staged.token,
    });
  } catch (error) {
    console.error("POST /api/v1/elements/upload-url failed", error);
    return apiError("Could not create a staged upload.", "upload_url_failed", 500);
  }
}
