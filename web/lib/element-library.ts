import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import type { ElementTag } from "@/lib/elements";
import { extFromFilename, signedUrl, getImageUrl } from "@/lib/storage";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import { buildIlikeOrFilter } from "@/lib/search-term";
import { selectInChunks } from "@/lib/in-chunks";

// Matches ugc/[id]/page.tsx, where it is module-private. Kept in step by hand.
const RESULT_SIGNED_URL_TTL_SECONDS = 3600;

export type ElementLibraryFilter = "all" | "mine" | "images" | "audio" | "video";
export interface ElementLibraryCursor {
  createdAt: string;
  id: string;
}
export interface ElementLibraryPage {
  elements: ElementTag[];
  creatorNames: Record<string, string | null>;
  nextCursor: ElementLibraryCursor | null;
}

const ELEMENT_LIBRARY_PAGE_SIZE = 16;

export async function loadElementLibraryPage(
  supabase: SupabaseClient<Database>,
  viewerId: string,
  input: { query: string; filter: ElementLibraryFilter; cursor: ElementLibraryCursor | null },
): Promise<ElementLibraryPage> {
  const search = buildIlikeOrFilter(["name", "description", "ai_description"], input.query);
  let query = supabase
    .from("elements")
    .select(
      "id, name, description, ai_description, category, asset_id, user_id, is_shared, created_at, assets!inner(storage_key, kind)",
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ELEMENT_LIBRARY_PAGE_SIZE + 1);

  if (search) query = query.or(search);
  if (input.filter === "mine") query = query.eq("user_id", viewerId);
  else query = query.eq("is_shared", true);
  if (input.filter === "audio") query = query.eq("assets.kind", "audio");
  if (input.filter === "video") query = query.eq("assets.kind", "video_ref");
  if (input.filter === "images") query = query.in("assets.kind", [...IMAGE_ASSET_KINDS]);
  if (input.cursor) {
    query = query.or(
      `created_at.lt.${input.cursor.createdAt},and(created_at.eq.${input.cursor.createdAt},id.lt.${input.cursor.id})`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load elements: ${error.message}`);
  const rows = data ?? [];
  const pageRows = rows.slice(0, ELEMENT_LIBRARY_PAGE_SIZE);
  const elements = await Promise.all(
    pageRows.map(async (row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      aiDescription: row.ai_description,
      userId: row.user_id,
      isShared: row.is_shared,
      assetKind: row.assets.kind,
      previewUrl: IMAGE_ASSET_KINDS.has(row.assets.kind)
        ? await getImageUrl(row.assets.storage_key, "thumb", RESULT_SIGNED_URL_TTL_SECONDS)
        : await signedUrl(row.assets.storage_key, RESULT_SIGNED_URL_TTL_SECONDS),
    })),
  );

  const creatorIds = new Set(pageRows.map((row) => row.user_id));
  const { data: creators } = await supabase.rpc("element_creators");
  const creatorNames = Object.fromEntries(
    (creators ?? [])
      .filter((creator) => creatorIds.has(creator.id))
      .map((creator) => [creator.id, creator.display_name]),
  );
  const last = pageRows.at(-1);
  return {
    elements,
    creatorNames,
    nextCursor:
      rows.length > ELEMENT_LIBRARY_PAGE_SIZE && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
  };
}

/**
 * One operator's @tag library (0065_elements.sql), resolved to the shape the
 * prompt editor and the reference picker both consume.
 *
 * Lifted out of ugc/[id]/page.tsx when the Image Generator became the second
 * console to need it (0084). The two must agree: a tag that resolves in one
 * console's hover preview and not the other's is a library that looks broken
 * from one door and fine from the next. ugc/[id]/page.tsx still carries its own
 * inline copy — identical, and left alone rather than refactored mid-feature.
 *
 * @param ownerId THE PROJECT OWNER, not the viewer — or `null` for the whole
 * shared library.
 *
 * WHY AN ID AT ALL, now that `elements_select` is `using (true)` (0091). The
 * filter used to be belt-and-braces over a policy that already scoped the read;
 * since 0091 it is the ONLY thing scoping it, and that is the point rather than
 * a leftover. Resolution is per-owner and has to stay that way: `unique
 * (user_id, name)` means "@lena_ref" identifies one row within one account's
 * set and two operators may each have their own, so a resolver that read the
 * whole table would have to invent a tiebreak and a prompt would mean different
 * things on different days.
 *
 * A prompt is written in its AUTHOR's tags, which is why this is the project
 * owner and not the viewer: scoping to the viewer would make every @tag in an
 * admin's read-only view resolve to nothing — the highlight would read as a
 * typo and the hover preview would be empty, on a prompt that is perfectly
 * correct for whoever wrote it. Worse than a 404: it looks like it works and
 * tells the wrong story.
 *
 * `null` is the Elements Library page and nothing else. It asks the opposite
 * question — "what has anyone saved?" — and every row it gets back carries
 * `userId` so the page can decide, per card, who may edit it.
 */
export async function loadElementTags(
  supabase: SupabaseClient<Database>,
  ownerId: string | null,
): Promise<ElementTag[]> {
  const query = supabase
    .from("elements")
    // ai_description rides along for lib/ugc-prompt-preview.ts's benefit —
    // descriptionFor falls back to it, and actions/ugc.ts's resolveElementTags
    // reads both columns server-side, so omitting it here would make the
    // prompt preview under-substitute an element that has only ever been
    // AI-described. The picker UI itself has no use for it.
    //
    // user_id rides along for the library page's benefit — it is what decides
    // canEdit/canDelete per card now that the grid shows everyone's rows. The
    // owner-scoped callers select it too rather than branching the projection:
    // one column on a small read, against two select strings that could drift.
    .select("id, name, description, ai_description, category, asset_id, user_id, is_shared")
    .is("deleted_at", null)
    // NEWEST FIRST, AND NOTHING BEFORE THAT. Sorting by category first was
    // harmless while the values were character/location/product/voice —
    // 'voice' sorted last, so pictures filled the @ menu. 0081 renamed voice
    // to audio, 'audio' sorts FIRST, and the menu shows only the first 8
    // matches, so twelve voice clips pushed every picture out of it. A rename
    // with no code change reordered a menu. Recency is what the menu is for
    // anyway: typing @ means the reference just added far more often than the
    // one that sorts first by a label nobody can see.
    .order("created_at", { ascending: false });

  const { data: rows } = await (ownerId === null ? query : query.eq("user_id", ownerId));

  const assetIds = (rows ?? []).map((row) => row.asset_id);
  // In chunks: one .in() with every id fails past ~575 elements (lib/in-chunks.ts).
  const { data: assetRows } = await selectInChunks(assetIds, (chunk) =>
    supabase.from("assets").select("id, storage_key, kind, duration_s, deleted_at").in("id", chunk),
  );
  const assetById = new Map((assetRows ?? []).map((asset) => [asset.id, asset]));

  const elements: ElementTag[] = [];
  // Sequential, not Promise.all: a personal library is small, and signedUrl's
  // own memoization means a repeat render in the same process pays for at most
  // one createSignedUrl per element either way.
  for (const row of rows ?? []) {
    const asset = assetById.get(row.asset_id);
    // Should not happen — asset_id references assets(id) not null and elements
    // cascades on that FK's delete. Degrades to leaving one row out of the
    // picker rather than breaking the page over an image that is somehow gone.
    if (!asset) continue;
    // An image in Bin takes its auto-filed element with it (the element points
    // at the generated asset); restoring the image brings it back.
    if (asset.deleted_at) continue;
    // ALLOWLIST, NOT "anything that is not audio" -- see the same block in
    // ugc/[id]/page.tsx for what the denylist form cost in production. The
    // two files are kept identical by hand, which is exactly why a bug in
    // one was a bug in both: /ugc threw on the video card and /elements
    // would have thrown on the same card a click later.
    const isImageAsset = IMAGE_ASSET_KINDS.has(asset.kind);
    const isAudioAsset = asset.kind === "audio";
    elements.push({
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      aiDescription: row.ai_description,
      userId: row.user_id,
      isShared: row.is_shared,
      assetKind: asset.kind,
      // A video reference's length prices the render (ugc-column.tsx's
      // videoLengthUnmeasured). /ugc's own loader always carried it; without
      // it here, /create refused every tagged video as "never measured".
      durationS: asset.duration_s,
      // Only a picture has a pre-sized copy; audio and video are signed as they are.
      previewUrl: isImageAsset
        ? await getImageUrl(asset.storage_key, "thumb", RESULT_SIGNED_URL_TTL_SECONDS)
        : await signedUrl(asset.storage_key, RESULT_SIGNED_URL_TTL_SECONDS),
      // ONLY FOR THE LIBRARY PAGE. The @tag consumers show a hover preview and
      // nothing else, so minting two more signed URLs per element for them
      // would be two more createSignedUrl round trips per prompt render, for
      // controls that surface nowhere. `ownerId === null` IS the library page —
      // see this function's own doc.
      //
      // ponytail: three signed URLs per card is fine for a library measured in
      // dozens; if this grid ever pages into the hundreds, mint the view and
      // download URLs on demand from a route handler instead of up front.
      ...(ownerId === null
        ? {
            // No transform: this is the "actually look at it" URL, and the
            // 320px rendition behind previewUrl is not that.
            fullUrl: await signedUrl(asset.storage_key, RESULT_SIGNED_URL_TTL_SECONDS),
            // The @name the operator knows it by, not the uuid the object is
            // stored under — a download called
            // `9f3c1e02-....png` tells them nothing about which reference they
            // just saved.
            downloadUrl: await signedUrl(
              asset.storage_key,
              RESULT_SIGNED_URL_TTL_SECONDS,
              // THE FALLBACK ONLY: extFromFilename reads the real extension
              // off the key and lands here only when the key has none. Still
              // three-way rather than two, because "png" was what a video got
              // on the one branch where the key could not speak for itself,
              // and a downloaded new_video1.png opens in nothing.
              `${row.name}.${extFromFilename(
                asset.storage_key,
                isAudioAsset ? "mp3" : isImageAsset ? "png" : "mp4",
              )}`,
            ),
          }
        : {}),
    });
  }
  if (ownerId !== null) {
    // Auto-filed generated images go AFTER the references the operator chose to
    // keep. Every generation adds one, and the @ menu shows only the first few
    // matches — newest-first alone would let a day of generations push every
    // real reference out of it (the same failure the order comment above
    // records for voice clips). Stable, so each group stays newest-first.
    elements.sort(
      (a, b) =>
        Number(a.assetKind === "generated_image") - Number(b.assetKind === "generated_image"),
    );
  }
  return elements;
}
