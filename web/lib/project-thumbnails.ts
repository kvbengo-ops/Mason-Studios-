// Thumbnail selection and signing for the bounded /projects page query.
//
// A project has no thumbnail column of its own. Its most recognisable still is
// the newest worker-generated poster from any visible scene; before a render
// exists, the operator-approved reference frame is the useful fallback. This
// module deliberately stops there: walking every kind of project asset to
// find a third fallback would turn the directory into an unbounded asset scan.

import { getImageUrl } from "@/lib/storage";


export interface ProjectThumbnailScene {
  id: string;
  projectId: string;
  idx: number;
  refFrameAssetId: string | null;
}

export interface ProjectThumbnailPoster {
  sceneId: string;
  storageKey: string;
  createdAt: string;
}

export interface ProjectThumbnailAsset {
  id: string;
  storageKey: string;
}

export interface ProjectThumbnailSource {
  projectId: string;
  storageKey: string;
}

/**
 * Selects exactly one image key for each visible project. Poster precedence is
 * intentional even when a reference frame exists: it is the worker's still
 * for the produced clip. Ties are deterministic on the storage key so a
 * database result whose equal-timestamp order changes cannot make the card
 * flicker between two images.
 */
export function selectProjectThumbnailSources(
  scenes: readonly ProjectThumbnailScene[],
  posters: readonly ProjectThumbnailPoster[],
  refFrameAssets: readonly ProjectThumbnailAsset[],
): ProjectThumbnailSource[] {
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const newestPosterByProject = new Map<string, ProjectThumbnailPoster>();

  for (const poster of posters) {
    const scene = sceneById.get(poster.sceneId);
    if (!scene || !poster.storageKey) continue;
    const previous = newestPosterByProject.get(scene.projectId);
    if (
      !previous ||
      poster.createdAt > previous.createdAt ||
      (poster.createdAt === previous.createdAt && poster.storageKey < previous.storageKey)
    ) {
      newestPosterByProject.set(scene.projectId, poster);
    }
  }

  const refFrameKeyById = new Map(
    refFrameAssets.filter((asset) => asset.storageKey).map((asset) => [asset.id, asset.storageKey]),
  );
  const sourceByProject = new Map<string, string>();
  const earliestRefFrameByProject = new Map<string, ProjectThumbnailScene>();

  for (const scene of scenes) {
    const poster = newestPosterByProject.get(scene.projectId);
    if (poster) {
      sourceByProject.set(scene.projectId, poster.storageKey);
      continue;
    }
    if (!scene.refFrameAssetId || !refFrameKeyById.has(scene.refFrameAssetId)) continue;
    const previous = earliestRefFrameByProject.get(scene.projectId);
    if (
      !previous ||
      scene.idx < previous.idx ||
      (scene.idx === previous.idx && scene.id < previous.id)
    ) {
      earliestRefFrameByProject.set(scene.projectId, scene);
    }
  }

  for (const [projectId, scene] of earliestRefFrameByProject) {
    if (sourceByProject.has(projectId) || !scene.refFrameAssetId) continue;
    const refFrameKey = refFrameKeyById.get(scene.refFrameAssetId);
    if (refFrameKey) sourceByProject.set(projectId, refFrameKey);
  }

  return [...sourceByProject].map(([projectId, storageKey]) => ({ projectId, storageKey }));
}

/**
 * Signs a page's selected stills concurrently. One missing Storage object is
 * a placeholder for that card, never a reason for the entire directory to
 * fail. `signedUrl` owns the process-local key cache, so duplicate
 * source keys cost one signing request per server process rather than one per
 * card.
 */
export async function signProjectThumbnails(
  sources: readonly ProjectThumbnailSource[],
): Promise<Map<string, string | null>> {
  const results = await Promise.allSettled(
    sources.map((source) => getImageUrl(source.storageKey, "thumb")),
  );
  const urls = new Map<string, string | null>();

  for (const [index, result] of results.entries()) {
    const source = sources[index];
    if (!source) continue;
    if (result.status === "fulfilled") {
      urls.set(source.projectId, result.value);
    } else {
      console.warn("projects: failed to sign a thumbnail — showing placeholder", {
        projectId: source.projectId,
        storageKey: source.storageKey,
        error: result.reason,
      });
      urls.set(source.projectId, null);
    }
  }

  return urls;
}
