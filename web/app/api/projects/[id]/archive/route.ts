// "Download all" (SMN-feature-spec.md § 3.8: "Download All → drag the clips
// into CapCut") — this route IS the handoff, not a convenience on top of
// the per-clip downloads on the Deliver page, which stay for editors who
// want one shot.
//
// Zipped on the server and streamed out as it's built: an eighteen-clip ad
// is tens of megabytes, and ugc-web runs on Render's starter plan (512MB,
// shared with SSR) — buffering the whole archive in memory before sending
// a byte is not an option on that box. Each clip is fetched from Storage
// and piped straight into a zip entry one chunk at a time, so peak memory
// is roughly one clip's chunk buffer, not the sum of every clip in the
// project.
//
// Store-only (fflate's ZipPassThrough), not deflate: an mp4 is already
// H.264-compressed, so spending CPU deflating it on a shared instance buys
// back close to nothing and costs real time on an ad with eighteen clips.

import { NextResponse } from "next/server";
import { Zip, ZipPassThrough } from "fflate";
import { AuthorizationError, requireProject } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";
import { activeClipIdByScene } from "@/lib/scene-versions";
import { buildManifest, type ManifestSceneInput } from "@/lib/manifest";
import {
  archiveFilename,
  buildClipEntries,
  contentDispositionHeader,
  FINAL_ENTRY_NAME,
  MANIFEST_ENTRY_NAME,
} from "@/lib/archive";
import { buildProjectAssetEntries } from "@/lib/project-archive";
import type { Database } from "@/types/db";

export const dynamic = "force-dynamic";

type AssetRow = Database["public"]["Tables"]["assets"]["Row"];

// Long enough to cover the fetch-and-zip loop for a large project plus the
// preflight existence check below, without leaving stray long-lived URLs
// around afterward — this route resolves its own signed URLs per request,
// unlike the Deliver page's which sit in the DOM for the session.
const ARCHIVE_SIGNED_URL_TTL_SECONDS = 3600;

interface StreamEntry {
  name: string;
  url: string;
}

/**
 * Fetches every entry's headers before a single content byte is sent.
 * Storage objects can go missing (a failed re-render that never re-uploaded,
 * a manual cleanup) and if that's discovered mid-stream there is no way
 * back — the 200 and the Content-Disposition header are already on the
 * wire, so the browser would save a zip that LOOKS complete but silently
 * stops partway through. Checking existence first means a missing object
 * fails as a clean error response instead of a corrupt download.
 */
async function assertAllReachable(entries: readonly StreamEntry[]): Promise<void> {
  for (const entry of entries) {
    const res = await fetch(entry.url, { method: "HEAD" });
    if (!res.ok) {
      throw new Error(
        `Missing from storage: ${entry.name} (HTTP ${res.status}). Restore or re-render the file and try again.`,
      );
    }
  }
}

/** Streams one already-fetched HTTP response's body into a zip entry, chunk
 * by chunk, so the entry's bytes never sit fully buffered in memory. */
async function pipeIntoZipEntry(response: Response, file: ZipPassThrough): Promise<void> {
  if (!response.ok || !response.body) {
    throw new Error(
      `Archive: ${file.filename} disappeared from storage mid-download (HTTP ${response.status}).`,
    );
  }

  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      file.push(new Uint8Array(0), true);
      return;
    }
    file.push(value);
  }
}

function buildArchiveStream(
  clipEntries: readonly StreamEntry[],
  finalEntry: StreamEntry | null,
  projectEntries: readonly StreamEntry[],
  manifestBytes: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      const archive = new Zip((err, chunk, final) => {
        if (err) {
          controller.error(err);
          return;
        }
        controller.enqueue(chunk);
        if (final) {
          controller.close();
        }
      });

      try {
        for (const entry of [
          ...clipEntries,
          ...(finalEntry ? [finalEntry] : []),
          ...projectEntries,
        ]) {
          const file = new ZipPassThrough(entry.name);
          archive.add(file);
          const response = await fetch(entry.url);
          await pipeIntoZipEntry(response, file);
        }

        const manifestFile = new ZipPassThrough(MANIFEST_ENTRY_NAME);
        archive.add(manifestFile);
        manifestFile.push(manifestBytes, true);

        archive.end();
      } catch (err) {
        // Entries already flushed to the client can't be un-sent — this at
        // least aborts the stream instead of quietly ending it short, so
        // the browser reports a failed download rather than a finished one.
        controller.error(err);
      }
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const includeProjectAssets = new URL(request.url).searchParams.get("scope") === "project";

  let project: Database["public"]["Tables"]["projects"]["Row"];
  try {
    ({ project } = await requireProject(id));
  } catch (err) {
    // requireProject's row-missing and not-owner branches now call
    // notFound() instead of throwing AuthorizationError (see guard.ts) —
    // `throw err` below re-throws that unchanged, so Next handles it the
    // same way it would from a page load: a 404, not this route's own JSON
    // error shape. The instanceof branch is dead for those two cases now;
    // it's kept because requireUser() (which requireProject calls first)
    // still throws AuthorizationError for the profile-bootstrap-missing
    // edge case, and that one genuinely is this route's concern to surface
    // as JSON rather than a 404.
    if (err instanceof AuthorizationError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const supabase = await createClient();

  const { data: scenes, error: scenesError } = await supabase
    .from("scenes")
    .select("*")
    .eq("project_id", id)
    .order("idx", { ascending: true });
  if (scenesError) {
    return NextResponse.json(
      { error: `Failed to load scenes for project ${id}: ${scenesError.message}` },
      { status: 500 },
    );
  }

  const { data: assets, error: assetsError } = await supabase
    .from("assets")
    .select("*")
    .eq("project_id", id);
  if (assetsError) {
    return NextResponse.json(
      { error: `Failed to load assets for project ${id}: ${assetsError.message}` },
      { status: 500 },
    );
  }

  let projectAssets = assets ?? [];
  if (includeProjectAssets && (scenes ?? []).length > 0) {
    const { data: references, error: referencesError } = await supabase
      .from("scene_references")
      .select("asset_id")
      .in(
        "scene_id",
        (scenes ?? []).map((scene) => scene.id),
      );
    if (referencesError) {
      return NextResponse.json(
        { error: `Failed to load project references: ${referencesError.message}` },
        { status: 500 },
      );
    }

    const projectAssetIds = new Set(projectAssets.map((asset) => asset.id));
    const referencedIds = [
      ...new Set((references ?? []).map((reference) => reference.asset_id)),
    ].filter((assetId) => !projectAssetIds.has(assetId));
    if (referencedIds.length > 0) {
      const { data: referencedAssets, error: referencedAssetsError } = await supabase
        .from("assets")
        .select("*")
        .in("id", referencedIds);
      if (referencedAssetsError) {
        return NextResponse.json(
          { error: `Failed to load referenced project assets: ${referencedAssetsError.message}` },
          { status: 500 },
        );
      }
      projectAssets = [...projectAssets, ...(referencedAssets ?? [])];
    }
  }

  // Same active-version rule as the Deliver page and the worker's own
  // assembly query — a superseded clip survives a re-render now
  // (0058_scene_versions.sql), so an archive keyed by scene_id alone would
  // ship whichever clip the query happened to return last.
  const { data: versionRows } = await supabase
    .from("scene_versions")
    .select("id, n, created_at, video_prompt, ref_frame_asset_id, clip_asset_id, scene_id")
    .in(
      "scene_id",
      (scenes ?? []).map((scene) => scene.id),
    );

  const activeClipIds = activeClipIdByScene(
    scenes ?? [],
    versionRows ?? [],
    projectAssets
      .filter((asset) => asset.kind === "clip")
      .map((asset) => ({ id: asset.id, created_at: asset.created_at, scene_id: asset.scene_id })),
  );

  // Which assembled cut goes in the zip is decided by
  // projects.active_final_version_id (0060_final_versions.sql), not by
  // `kind === 'final'`. Old cuts are kept now rather than deleted to trigger
  // a rebuild, so a project routinely has several `final` rows — this loop
  // used to keep whichever one the query returned LAST, which meant the
  // downloaded mp4 was chosen arbitrarily and could differ from the one the
  // Deliver page had just played. Same rule, same row, both places.
  //
  // Null when there is no active version, when it is still building, or when
  // its file has been pruned to the recipe. All three mean the same thing to
  // this route: ship the clips and the manifest, without a final. The null
  // is handled BEFORE the query — `.eq("id", "")` against a uuid column is a
  // Postgres type error, not an empty result.
  let activeFinalAssetId: string | null = null;
  if (project.active_final_version_id) {
    const { data: activeVersions, error: versionError } = await supabase
      .from("final_versions")
      .select("final_asset_id")
      .eq("id", project.active_final_version_id)
      .limit(1);
    if (versionError) {
      return NextResponse.json(
        { error: `Failed to load the final version for project ${id}: ${versionError.message}` },
        { status: 500 },
      );
    }
    activeFinalAssetId = activeVersions?.[0]?.final_asset_id ?? null;
  }

  const clipAssetByScene = new Map<string, AssetRow>();
  let finalAsset: AssetRow | null = null;
  for (const asset of projectAssets) {
    if (asset.kind === "clip" && asset.scene_id) {
      if (activeClipIds.get(asset.scene_id) === asset.id) {
        clipAssetByScene.set(asset.scene_id, asset);
      }
    } else if (asset.id === activeFinalAssetId) {
      finalAsset = asset;
    }
  }

  const scenesWithClips = (scenes ?? []).filter((scene) => clipAssetByScene.has(scene.id));
  if (scenesWithClips.length === 0 && !includeProjectAssets) {
    return NextResponse.json({ error: "No finished clips to archive yet." }, { status: 409 });
  }

  const clipEntryDescriptors = buildClipEntries(
    scenesWithClips.map((scene) => ({
      idx: scene.idx,
      storageKey: (clipAssetByScene.get(scene.id) as AssetRow).storage_key,
    })),
  );

  // Archives always use original bytes. Image transforms would alter source
  // assets, and Supabase's transform endpoint does not serve video.
  const representedAssetIds = new Set([
    ...[...clipAssetByScene.values()].map((asset) => asset.id),
    ...(finalAsset ? [finalAsset.id] : []),
  ]);
  const projectEntryDescriptors = includeProjectAssets
    ? buildProjectAssetEntries(
        projectAssets
          .filter((asset) => !representedAssetIds.has(asset.id))
          .map((asset) => ({ id: asset.id, kind: asset.kind, storageKey: asset.storage_key })),
      )
    : [];

  const [clipEntries, finalEntry, projectEntries, manifestScenes] = await Promise.all([
    Promise.all(
      clipEntryDescriptors.map(async (entry): Promise<StreamEntry> => ({
        name: entry.name,
        url: await signedUrl(entry.storageKey, ARCHIVE_SIGNED_URL_TTL_SECONDS),
      })),
    ),
    finalAsset
      ? signedUrl((finalAsset as AssetRow).storage_key, ARCHIVE_SIGNED_URL_TTL_SECONDS).then(
          (url): StreamEntry => ({ name: FINAL_ENTRY_NAME, url }),
        )
      : Promise.resolve(null),
    Promise.all(
      projectEntryDescriptors.map(async (entry): Promise<StreamEntry> => ({
        name: entry.name,
        url: await signedUrl(entry.storageKey, ARCHIVE_SIGNED_URL_TTL_SECONDS),
      })),
    ),
    Promise.all(
      scenesWithClips.map(async (scene): Promise<ManifestSceneInput> => {
        const asset = clipAssetByScene.get(scene.id) as AssetRow;
        const entry = clipEntryDescriptors.find((e) => e.storageKey === asset.storage_key);
        return {
          idx: scene.idx,
          script_line: scene.script_line,
          video_prompt: scene.video_prompt,
          is_talking_head: scene.is_talking_head,
          duration_s: scene.duration_s,
          filename: entry?.name ?? "",
          signed_url: await signedUrl(asset.storage_key, ARCHIVE_SIGNED_URL_TTL_SECONDS),
        };
      }),
    ),
  ]);

  try {
    await assertAllReachable([
      ...clipEntries,
      ...(finalEntry ? [finalEntry] : []),
      ...projectEntries,
    ]);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "A storage object for this archive is missing.",
      },
      { status: 502 },
    );
  }

  const manifest = buildManifest({
    projectTitle: project.title,
    characterDescription: project.character_desc,
    scenes: manifestScenes,
  });
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const stream = buildArchiveStream(clipEntries, finalEntry, projectEntries, manifestBytes);

  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDispositionHeader(archiveFilename(project.title)),
      "Cache-Control": "no-store",
    },
  });
}
