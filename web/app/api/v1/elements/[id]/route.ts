import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-auth";
import { apiError, readJsonObject } from "@/lib/api-v1";
import { elementUploadNameError } from "@/lib/element-upload-name";
import { promptMentionsTag, renameTagInPrompt } from "@/lib/rename-tag";
import { signedUrlWithExpiry } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/server";
import type { ElementCategory } from "@/types/db";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CATEGORIES: readonly ElementCategory[] = [
  "image",
  "audio",
  "video",
  "character",
  "product",
  "location",
  "voice",
];

async function ownedElement(id: string, userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("elements")
    .select("id, user_id, name, description, category, is_shared, asset_id, created_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Failed to read API element: ${error.message}`);
  return data?.user_id === userId ? data : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireApiToken(request, "read");
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return apiError("Element was not found.", "not_found", 404);

  try {
    const element = await ownedElement(id, auth.userId);
    if (!element) return apiError("Element was not found.", "not_found", 404);
    const { data: asset, error } = await createAdminClient()
      .from("assets")
      .select("kind, storage_key, duration_s")
      .eq("id", element.asset_id)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) throw new Error(`Failed to read API element asset: ${error.message}`);
    if (!asset) return apiError("Element file was not found.", "not_found", 404);
    const { url, expiresInSeconds } = await signedUrlWithExpiry(asset.storage_key, 3600, true);
    return NextResponse.json({
      element: {
        id: element.id,
        name: element.name,
        description: element.description,
        category: element.category,
        shared: element.is_shared,
        asset_kind: asset.kind,
        duration_s: asset.duration_s,
        created_at: element.created_at,
        download_url: url,
        url_expires_in_s: expiresInSeconds,
      },
    });
  } catch (error) {
    console.error("GET /api/v1/elements/[id] failed", error);
    return apiError("Could not read element.", "element_read_failed", 500);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireApiToken(request, "upload", { rateLimitBucket: "write" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return apiError("Element was not found.", "not_found", 404);
  const parsed = await readJsonObject(request);
  if (parsed.response) return parsed.response;
  const body = parsed.value;
  if (
    Object.keys(body).length === 0 ||
    Object.keys(body).some((key) => !["name", "description", "category"].includes(key))
  ) {
    return apiError("Send name, description, or category only.", "invalid_parameters", 400);
  }

  try {
    const element = await ownedElement(id, auth.userId);
    if (!element) return apiError("Element was not found.", "not_found", 404);
    const name =
      body.name === undefined
        ? element.name
        : typeof body.name === "string"
          ? body.name.trim()
          : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
      return apiError(
        "name must be a 1-64 character tag using letters, numbers, - or _.",
        "invalid_element_name",
        422,
      );
    }
    if (
      body.description !== undefined &&
      body.description !== null &&
      typeof body.description !== "string"
    ) {
      return apiError("description must be a string or null.", "invalid_description", 422);
    }
    const description =
      body.description === undefined
        ? element.description
        : typeof body.description === "string"
          ? body.description.trim() || null
          : null;
    if (description && description.length > 2000) {
      return apiError("description must be at most 2000 characters.", "invalid_description", 422);
    }
    const category = body.category === undefined ? element.category : body.category;
    if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) {
      return apiError("category is not supported.", "invalid_category", 422);
    }
    const admin = createAdminClient();
    if (name !== element.name) {
      const nameError = await elementUploadNameError(admin, auth.userId, name, element.is_shared);
      if (nameError) return apiError(nameError, "duplicate_element", 409);
    }
    const { error } = await admin
      .from("elements")
      .update({ name, description, category: category as ElementCategory })
      .eq("id", element.id)
      .eq("user_id", auth.userId)
      .is("deleted_at", null);
    if (error?.code === "23505")
      return apiError(`@${name} is already used.`, "duplicate_element", 409);
    if (error) throw new Error(`Failed to update API element: ${error.message}`);

    if (name !== element.name) {
      const { data: projects, error: projectsError } = await admin
        .from("projects")
        .select("id")
        .eq("user_id", auth.userId);
      if (projectsError) console.warn(`Could not read API element owner's projects`, projectsError);
      if (!projectsError && projects?.length) {
        const { data: scenes, error: scenesError } = await admin
          .from("scenes")
          .select("id, video_prompt")
          .in(
            "project_id",
            projects.map((project) => project.id),
          );
        if (scenesError) console.warn(`Could not read API element owner's scenes`, scenesError);
        for (const scene of scenesError ? [] : (scenes ?? [])) {
          if (!promptMentionsTag(scene.video_prompt ?? "", element.name)) continue;
          const { error: rewriteError } = await admin
            .from("scenes")
            .update({
              video_prompt: renameTagInPrompt(scene.video_prompt ?? "", element.name, name),
            })
            .eq("id", scene.id);
          if (rewriteError)
            console.warn(
              `Could not follow API element rename into scene ${scene.id}`,
              rewriteError,
            );
        }
      }
    }
    return NextResponse.json({ element: { id, name, description, category } });
  } catch (error) {
    console.error("PATCH /api/v1/elements/[id] failed", error);
    return apiError("Could not update element.", "element_update_failed", 500);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireApiToken(request, "upload", { rateLimitBucket: "write" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return apiError("Element was not found.", "not_found", 404);
  try {
    const element = await ownedElement(id, auth.userId);
    if (!element) return apiError("Element was not found.", "not_found", 404);
    const { error } = await createAdminClient()
      .from("elements")
      .update({ deleted_at: new Date().toISOString(), deleted_by: auth.userId })
      .eq("id", element.id)
      .eq("user_id", auth.userId)
      .is("deleted_at", null);
    if (error) throw new Error(`Failed to delete API element: ${error.message}`);
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("DELETE /api/v1/elements/[id] failed", error);
    return apiError("Could not delete element.", "element_delete_failed", 500);
  }
}
