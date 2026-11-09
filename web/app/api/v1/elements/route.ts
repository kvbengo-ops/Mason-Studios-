import { NextResponse } from "next/server";
import { createApiElement } from "@/lib/api-elements";
import { requireApiToken } from "@/lib/api-auth";
import { apiError } from "@/lib/api-v1";
import { StagedUploadError } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_DIRECT_UPLOAD_BYTES = 16 * 1024 * 1024;

export async function GET(request: Request): Promise<Response> {
  const auth = await requireApiToken(request, "read");
  if (!auth.ok) return auth.response;

  try {
    const admin = createAdminClient();
    const pageSize = 1000;
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin
        .from("elements")
        .select("id, name, category, asset_id, created_at")
        .eq("user_id", auth.userId)
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw new Error(`Failed to list API elements: ${error.message}`);
      rows.push(...(data ?? []));
      if ((data ?? []).length < pageSize) break;
    }

    const assetIds = [...new Set(rows.map((row) => row.asset_id))];
    const { data: assets, error: assetsError } =
      assetIds.length > 0
        ? await admin.from("assets").select("id, kind, duration_s").in("id", assetIds)
        : { data: [], error: null };
    if (assetsError) throw new Error(`Failed to read API element assets: ${assetsError.message}`);
    const assetById = new Map((assets ?? []).map((asset) => [asset.id, asset]));

    return NextResponse.json({
      elements: rows.map((element) => {
        const asset = assetById.get(element.asset_id);
        return {
          id: element.id,
          name: element.name,
          category: element.category,
          asset_kind: asset?.kind ?? null,
          duration_s: asset?.duration_s ?? null,
          created_at: element.created_at,
        };
      }),
    });
  } catch (error) {
    console.error("GET /api/v1/elements failed", error);
    return apiError("Could not list elements.", "elements_list_failed", 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiToken(request, "upload");
  if (!auth.ok) return auth.response;

  // Refuse before buffering: the largest accepted file is 15 MB, plus the multipart envelope.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_DIRECT_UPLOAD_BYTES) {
    return apiError(
      "This upload is over 16 MB. Images may be up to 10 MB, and audio and video up to 15 MB.",
      "file_too_large",
      413,
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return apiError("Request body must be multipart form data.", "invalid_upload", 400);
  }

  try {
    const result = await createApiElement(auth.userId, formData);
    if (!result.ok) return apiError(result.error, result.code, result.status);
    return NextResponse.json({ element: result.element }, { status: 201 });
  } catch (error) {
    if (error instanceof StagedUploadError) {
      return apiError(error.message, error.code, error.status);
    }
    console.error("POST /api/v1/elements failed", error);
    return apiError("Could not create element.", "element_upload_failed", 500);
  }
}
