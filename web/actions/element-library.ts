"use server";

import { z } from "zod";
import { requireUser } from "@/actions/guard";
import {
  loadElementLibraryPage,
  type ElementLibraryFilter,
  type ElementLibraryPage,
  type ElementLibraryCursor,
} from "@/lib/element-library";
import { createClient } from "@/lib/supabase/server";
import { extFromFilename, signedUrl } from "@/lib/storage";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";

const requestSchema = z.object({
  query: z.string().max(200),
  filter: z.enum(["all", "mine", "images", "audio", "video"]),
  cursor: z
    .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() })
    .nullable(),
});

export async function loadElementLibraryPageAction(input: {
  query: string;
  filter: ElementLibraryFilter;
  cursor: ElementLibraryCursor | null;
}): Promise<ElementLibraryPage> {
  const { user } = await requireUser();
  const parsed = requestSchema.parse(input);
  const supabase = await createClient();
  return loadElementLibraryPage(supabase, user.id, parsed);
}

export async function getElementLibraryUrl(
  elementId: string,
  disposition: "view" | "download",
): Promise<string> {
  await requireUser();
  const parsedId = z.string().uuid().parse(elementId);
  const supabase = await createClient();
  const { data: element, error: elementError } = await supabase
    .from("elements")
    .select("name, asset_id")
    .eq("id", parsedId)
    .is("deleted_at", null)
    .maybeSingle();
  if (elementError) throw new Error(`Failed to load that reference: ${elementError.message}`);
  if (!element) throw new Error("That reference is no longer available.");

  const { data: asset, error: assetError } = await supabase
    .from("assets")
    .select("storage_key, kind")
    .eq("id", element.asset_id)
    .maybeSingle();
  if (assetError) throw new Error(`Failed to load that file: ${assetError.message}`);
  if (!asset) throw new Error("That reference file is no longer available.");

  if (disposition === "view") return signedUrl(asset.storage_key);
  const isImage = IMAGE_ASSET_KINDS.has(asset.kind);
  const fallbackExt = asset.kind === "audio" ? "mp3" : isImage ? "png" : "mp4";
  return signedUrl(
    asset.storage_key,
    undefined,
    undefined,
    `${element.name}.${extFromFilename(asset.storage_key, fallbackExt)}`,
  );
}
