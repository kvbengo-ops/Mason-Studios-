// /bin — every deleted scene and every deleted clip version, across every
// project, in one place.
//
// components/ugc-deleted-scenes.tsx already renders this for ONE project
// (0088_deleted_scenes.sql's "Recently deleted" section on /ugc/[id]). This
// page generalises that same idea two ways at once: cross-project (no
// project id in the URL — there is nowhere for one to come from, which is
// exactly why nav-links.tsx can carry this as a top-level link the way it
// cannot for /ugc), and cross-table (0092_deleted_scene_versions.sql gave a
// standalone-deleted VERSION its own bin entry, independent of whether its
// scene was ever deleted).
//
// SESSION CLIENT, NOT ADMIN — the same rule every read on this route
// family follows (see restoreScene's own comment in actions/ugc.ts). There
// is no requireProject/requireScene to run here — this page has no single
// project to anchor one on — so deleted_scenes_select and
// deleted_scene_versions_select's identical RLS (`user_id = auth.uid() or
// is_admin()`) are the ENTIRE authorization boundary for what this query
// returns. That has a consequence worth being explicit about: for an
// editor, `or is_admin()` never fires and this is exactly their own bin.
// For an admin, it does, and unlike the per-project /ugc page (where an
// admin opts into viewing ONE named project read-only) this page has no
// project to scope by — an admin who opens /bin sees every account's
// deleted scenes and versions, not just their own. Restore/Delete permanently
// are still hidden per row below unless the viewer is that row's own
// snapshotted owner, so an admin can look here without being offered a
// button that would only fail.
//
// Every card's thumbnail is a signed Storage URL, resolved server-side —
// see the two-phase build below (shape everything first, sign everything
// in one Promise.all second) for why this stays a single round-trip to
// Storage no matter how many projects, scenes and versions are in the bin.

import type { JSX } from "react";
import { ImageBin } from "@/components/image-bin";
import { DownloadIcon, Trash2 } from "lucide-react";
import { isAdmin, requireUser } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { extFromFilename, signedUrl } from "@/lib/storage";
import { asAttachment } from "@/lib/download-url";
import { dateTimeFormatter } from "@/lib/datetime";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { BinCard, type BinCardThumbnail } from "@/components/bin-card";
import {
  binExpiryLabel,
  binRetentionCutoffIso,
  pickSceneClipSource,
  pickSceneThumbnailSource,
  versionClipThumbnailSource,
  type SceneClipSource,
  type ThumbnailSource,
} from "@/lib/bin-thumbnails";
import {
  purgeDeletedScene,
  purgeDeletedVersion,
  reapExpiredBinEntries,
  restoreClipVersion,
  restoreScene,
} from "@/actions/ugc";

/**
 * The first line of an archived video_prompt, never empty — a scene or
 * version deleted before it ever got a prompt is still a row worth
 * showing, just not one with words to quote. Duplicated from
 * app/(app)/ugc/[id]/page.tsx's identical private helper rather than
 * shared: both are one-line, page-local, and neither is used anywhere a
 * third copy would suggest promoting it to lib/.
 */
function firstLine(text: string | null | undefined): string {
  const line = text?.split("\n")[0]?.trim();
  return line ? line : "(no prompt)";
}

// Same TTL every other display call site in this app picks for a signed URL
// that only has to survive one page view (see lib/storage.ts's own header).
const BIN_SIGNED_URL_TTL_SECONDS = 3600;

interface PreparedScene {
  sceneId: string;
  projectId: string | null;
  userId: string | null;
  deletedAtMs: number;
  idx: number | null;
  promptFirstLine: string;
  deletedAtLabel: string;
  expiresLabel: string | null;
  /** Read off the archived `versions` jsonb array's own length — how the
   * operator sees that a scene's versions rode along with it into the bin,
   * without this page running a second query per scene to count them. */
  versionCount: number;
  /** True when this row's snapshotted owner is the viewer. Only the owner may
   * restore a scene back to their project. */
  isOwner: boolean;
  clipSource: SceneClipSource | null;
  thumbnailSource: ThumbnailSource | null;
}

interface PreparedVersion {
  versionId: string;
  projectId: string | null;
  userId: string | null;
  deletedAtMs: number;
  n: number | null;
  /**
   * "Its scene" (this row's own archived `video_prompt`), not a resolved
   * scene index — a version's bin entry does not carry its scene's idx at
   * all (deleted_scene_versions.version is to_jsonb of the scene_versions
   * row alone, which has no idx column), and the scene itself may since
   * have been deleted too, purged, or restored back to a different index
   * than it held when this version was taken. The prompt is the one fact
   * about "which scene" that travels with THIS row regardless of what has
   * happened to the scene since — the same identifying fact
   * ugc-deleted-scenes.tsx already uses for a deleted scene itself.
   */
  scenePromptFirstLine: string;
  deletedAtLabel: string;
  expiresLabel: string | null;
  isOwner: boolean;
  thumbnailSource: ThumbnailSource | null;
}

interface SceneRow {
  sceneId: string;
  idx: number | null;
  promptFirstLine: string;
  deletedAtLabel: string;
  expiresLabel: string | null;
  ownerLabel: string | null;
  versionCount: number;
  isOwner: boolean;
  thumbnail: BinCardThumbnail;
  downloadUrl: string | null;
  downloadFilename: string | null;
}

interface VersionRow {
  versionId: string;
  n: number | null;
  scenePromptFirstLine: string;
  deletedAtLabel: string;
  expiresLabel: string | null;
  ownerLabel: string | null;
  isOwner: boolean;
  thumbnail: BinCardThumbnail;
  downloadUrl: string | null;
  downloadFilename: string | null;
}

interface ProjectGroup {
  projectId: string;
  projectTitle: string;
  scenes: SceneRow[];
  versions: VersionRow[];
  /** Epoch ms of the newest deletion in this group, across both lists —
   * what orders the groups themselves (see below). */
  latestDeletedAtMs: number;
}

export default async function BinPage(): Promise<JSX.Element> {
  const { user, profile } = await requireUser();
  const viewerIsAdmin = isAdmin(profile);
  await reapExpiredBinEntries();

  const supabase = await createClient();
  const nowMs = new Date().getTime();
  const cutoffIso = binRetentionCutoffIso(nowMs);

  const [
    { data: deletedSceneRows, error: deletedScenesError },
    { data: deletedVersionRows, error: deletedVersionsError },
  ] = await Promise.all([
    supabase
      .from("deleted_scenes")
      .select("scene_id, project_id, user_id, scene_idx, deleted_at, scene, assets, versions")
      .is("hard_deleted_at", null)
      .gte("deleted_at", cutoffIso)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("deleted_scene_versions")
      .select("version_id, scene_id, project_id, user_id, n, deleted_at, version, clip_asset")
      .is("hard_deleted_at", null)
      .gte("deleted_at", cutoffIso)
      .order("deleted_at", { ascending: false }),
  ]);

  if (deletedScenesError) {
    throw new Error(`Failed to load deleted scenes: ${deletedScenesError.message}`);
  }
  if (deletedVersionsError) {
    throw new Error(`Failed to load deleted versions: ${deletedVersionsError.message}`);
  }

  const sceneRows = deletedSceneRows ?? [];
  const versionRows = deletedVersionRows ?? [];

  // Batched project-name resolution — ONE query for every project id
  // either list touched, not one per row or per group. A project id that
  // resolves to nothing (the project itself was later deleted — see
  // deleted_scenes' own header on why project_id is expected to dangle)
  // falls back to a label rather than an empty group heading.
  const projectIds = Array.from(
    new Set(
      [
        ...sceneRows.map((row) => row.project_id),
        ...versionRows.map((row) => row.project_id),
      ].filter((id): id is string => id !== null),
    ),
  );
  const projectTitleById = new Map<string, string>();
  const projectOwnerById = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projectRows, error: projectsError } = await supabase
      .from("projects")
      .select("id, title, user_id")
      .in("id", projectIds);
    if (projectsError) {
      throw new Error(`Failed to load project names: ${projectsError.message}`);
    }
    for (const row of projectRows ?? []) {
      projectTitleById.set(row.id, row.title);
      projectOwnerById.set(row.id, row.user_id);
    }
  }

  // When an admin views /bin across accounts, resolve each owner's email or
  // username in a single batched query so every card clearly identifies whose
  // generation is being reviewed.
  const ownerLabelByUserId = new Map<string, string>();
  if (viewerIsAdmin) {
    const ownerIds = Array.from(
      new Set(
        [
          ...sceneRows.map(
            (row) =>
              row.user_id ??
              (row.project_id ? (projectOwnerById.get(row.project_id) ?? null) : null),
          ),
          ...versionRows.map(
            (row) =>
              row.user_id ??
              (row.project_id ? (projectOwnerById.get(row.project_id) ?? null) : null),
          ),
        ].filter((id): id is string => id !== null),
      ),
    );
    if (ownerIds.length > 0) {
      const { data: ownerProfiles } = await supabase
        .from("profiles")
        .select("id, email, username")
        .in("id", ownerIds);
      for (const owner of ownerProfiles ?? []) {
        ownerLabelByUserId.set(owner.id, owner.email ?? owner.username ?? owner.id);
      }
    }
  }

  // Phase 1: shape every row's display fields and decide WHICH asset (if
  // any) is its thumbnail/clip candidate — no I/O yet. Kept apart from grouping
  // and from resolving (both below) so the one Promise.all after this can
  // cover every tile on the page at once, scenes and versions together,
  // rather than one round-trip per project group or per list.
  const preparedScenes: PreparedScene[] = sceneRows.map((row) => {
    const archivedScene = row.scene as { video_prompt?: string | null } | null;
    const archivedVersions = Array.isArray(row.versions) ? row.versions : [];
    const clipSource = pickSceneClipSource(row.assets);
    return {
      sceneId: row.scene_id,
      projectId: row.project_id,
      userId:
        row.user_id ?? (row.project_id ? (projectOwnerById.get(row.project_id) ?? null) : null),
      deletedAtMs: new Date(row.deleted_at).getTime(),
      idx: row.scene_idx,
      promptFirstLine: firstLine(archivedScene?.video_prompt),
      deletedAtLabel: dateTimeFormatter.format(new Date(row.deleted_at)),
      expiresLabel: binExpiryLabel(row.deleted_at, nowMs),
      versionCount: archivedVersions.length,
      isOwner: row.user_id === user.id,
      clipSource,
      thumbnailSource: clipSource ? null : pickSceneThumbnailSource(row.assets),
    };
  });

  const preparedVersions: PreparedVersion[] = versionRows.map((row) => {
    const archivedVersion = row.version as { video_prompt?: string | null } | null;
    return {
      versionId: row.version_id,
      projectId: row.project_id,
      userId:
        row.user_id ?? (row.project_id ? (projectOwnerById.get(row.project_id) ?? null) : null),
      deletedAtMs: new Date(row.deleted_at).getTime(),
      n: row.n,
      scenePromptFirstLine: firstLine(archivedVersion?.video_prompt),
      deletedAtLabel: dateTimeFormatter.format(new Date(row.deleted_at)),
      expiresLabel: binExpiryLabel(row.deleted_at, nowMs),
      isOwner: row.user_id === user.id,
      thumbnailSource: versionClipThumbnailSource(row.clip_asset),
    };
  });

  // Phase 2: the page's one and only round-trip to Storage. Every scene and
  // every version with a clip or thumbnail candidate gets signed here, in parallel.
  const signedUrlByKey = new Map<string, string>();
  const signTasks: { key: string; source: ThumbnailSource }[] = [];
  for (const scene of preparedScenes) {
    if (scene.clipSource) {
      signTasks.push({
        key: `scene-clip:${scene.sceneId}`,
        source: { kind: "video", storageKey: scene.clipSource.clipStorageKey },
      });
      if (scene.clipSource.posterStorageKey) {
        signTasks.push({
          key: `scene-poster:${scene.sceneId}`,
          source: { kind: "image", storageKey: scene.clipSource.posterStorageKey },
        });
      }
    } else if (scene.thumbnailSource) {
      signTasks.push({
        key: `scene:${scene.sceneId}`,
        source: scene.thumbnailSource,
      });
    }
  }
  for (const version of preparedVersions) {
    if (version.thumbnailSource) {
      signTasks.push({
        key: `version:${version.versionId}`,
        source: version.thumbnailSource,
      });
    }
  }

  await Promise.all(
    signTasks.map(async ({ key, source }) => {
      try {
        const url =
          source.kind === "image"
            ? await signedUrl(source.storageKey, BIN_SIGNED_URL_TTL_SECONDS)
            : await signedUrl(source.storageKey, BIN_SIGNED_URL_TTL_SECONDS);
        signedUrlByKey.set(key, url);
      } catch (err) {
        console.error(`bin: could not sign a thumbnail for ${key} (${source.storageKey})`, err);
      }
    }),
  );

  function resolveSceneMedia(scene: PreparedScene): {
    thumbnail: BinCardThumbnail;
    downloadUrl: string | null;
    downloadFilename: string | null;
  } {
    if (scene.clipSource) {
      const clipUrl = signedUrlByKey.get(`scene-clip:${scene.sceneId}`);
      const posterUrl = signedUrlByKey.get(`scene-poster:${scene.sceneId}`) ?? null;
      if (clipUrl) {
        const ext = extFromFilename(scene.clipSource.clipStorageKey, "mp4");
        const num =
          scene.idx === null ? scene.sceneId.slice(0, 8) : String(scene.idx).padStart(2, "0");
        return {
          thumbnail: { kind: "video", url: clipUrl, posterUrl },
          downloadUrl: clipUrl,
          downloadFilename: `deleted-scene-${num}.${ext}`,
        };
      }
      if (posterUrl) {
        const ext = scene.clipSource.posterStorageKey
          ? extFromFilename(scene.clipSource.posterStorageKey, "jpg")
          : "jpg";
        const num =
          scene.idx === null ? scene.sceneId.slice(0, 8) : String(scene.idx).padStart(2, "0");
        return {
          thumbnail: { kind: "image", url: posterUrl },
          downloadUrl: posterUrl,
          downloadFilename: `deleted-scene-${num}.${ext}`,
        };
      }
      return { thumbnail: { kind: "placeholder" }, downloadUrl: null, downloadFilename: null };
    }

    if (!scene.thumbnailSource) {
      return { thumbnail: { kind: "placeholder" }, downloadUrl: null, downloadFilename: null };
    }
    const url = signedUrlByKey.get(`scene:${scene.sceneId}`);
    if (!url) {
      return { thumbnail: { kind: "placeholder" }, downloadUrl: null, downloadFilename: null };
    }
    const ext = extFromFilename(
      scene.thumbnailSource.storageKey,
      scene.thumbnailSource.kind === "video" ? "mp4" : "jpg",
    );
    const num = scene.idx === null ? scene.sceneId.slice(0, 8) : String(scene.idx).padStart(2, "0");
    return {
      thumbnail: { kind: scene.thumbnailSource.kind, url },
      downloadUrl: url,
      downloadFilename: `deleted-scene-${num}.${ext}`,
    };
  }

  function resolveVersionMedia(version: PreparedVersion): {
    thumbnail: BinCardThumbnail;
    downloadUrl: string | null;
    downloadFilename: string | null;
  } {
    if (!version.thumbnailSource) {
      return { thumbnail: { kind: "placeholder" }, downloadUrl: null, downloadFilename: null };
    }
    const url = signedUrlByKey.get(`version:${version.versionId}`);
    if (!url) {
      return { thumbnail: { kind: "placeholder" }, downloadUrl: null, downloadFilename: null };
    }
    const ext = extFromFilename(version.thumbnailSource.storageKey, "mp4");
    const num = version.n === null ? version.versionId.slice(0, 8) : `v${version.n}`;
    return {
      thumbnail: { kind: version.thumbnailSource.kind, url },
      downloadUrl: url,
      downloadFilename: `deleted-version-${num}.${ext}`,
    };
  }

  const UNRESOLVED_PROJECT_LABEL = "Deleted project";
  const groups = new Map<string, ProjectGroup>();

  function groupFor(projectId: string | null): ProjectGroup {
    const key = projectId ?? "unresolved";
    let group = groups.get(key);
    if (!group) {
      group = {
        projectId: key,
        projectTitle: (projectId && projectTitleById.get(projectId)) || UNRESOLVED_PROJECT_LABEL,
        scenes: [],
        versions: [],
        latestDeletedAtMs: 0,
      };
      groups.set(key, group);
    }
    return group;
  }

  for (const scene of preparedScenes) {
    const group = groupFor(scene.projectId);
    group.latestDeletedAtMs = Math.max(group.latestDeletedAtMs, scene.deletedAtMs);
    const media = resolveSceneMedia(scene);
    group.scenes.push({
      sceneId: scene.sceneId,
      idx: scene.idx,
      promptFirstLine: scene.promptFirstLine,
      deletedAtLabel: scene.deletedAtLabel,
      expiresLabel: scene.expiresLabel,
      ownerLabel: viewerIsAdmin
        ? scene.userId
          ? (ownerLabelByUserId.get(scene.userId) ?? "Unknown user")
          : "Deleted project owner"
        : null,
      versionCount: scene.versionCount,
      isOwner: scene.isOwner,
      thumbnail: media.thumbnail,
      downloadUrl: media.downloadUrl,
      downloadFilename: media.downloadFilename,
    });
  }

  for (const version of preparedVersions) {
    const group = groupFor(version.projectId);
    group.latestDeletedAtMs = Math.max(group.latestDeletedAtMs, version.deletedAtMs);
    const media = resolveVersionMedia(version);
    group.versions.push({
      versionId: version.versionId,
      n: version.n,
      scenePromptFirstLine: version.scenePromptFirstLine,
      deletedAtLabel: version.deletedAtLabel,
      expiresLabel: version.expiresLabel,
      ownerLabel: viewerIsAdmin
        ? version.userId
          ? (ownerLabelByUserId.get(version.userId) ?? "Unknown user")
          : "Deleted project owner"
        : null,
      isOwner: version.isOwner,
      thumbnail: media.thumbnail,
      downloadUrl: media.downloadUrl,
      downloadFilename: media.downloadFilename,
    });
  }

  // Newest activity first — a group holding this morning's delete belongs
  // above one nobody has touched in a month, regardless of which project
  // sorts first alphabetically.
  const orderedGroups = Array.from(groups.values()).sort(
    (a, b) => b.latestDeletedAtMs - a.latestDeletedAtMs,
  );

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Bin</h1>
        <p className="text-sm text-muted-foreground">
          Deleted generated images, scenes and clip versions, across every project
          {viewerIsAdmin ? " and every account" : ""} — everything stays in the bin for 3 days
          before automatic permanent deletion
          {viewerIsAdmin ? ". Admins can preview, download, or permanently delete any entry." : "."}
        </p>
      </div>

      <ImageBin userId={user.id} />

      {orderedGroups.length === 0 ? (
        // A real, calm empty state — this page is one click away in the
        // sidebar and will often be exactly this: nothing has been deleted
        // recently, which is good news, not a page that failed to load.
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-16 text-center">
          <Trash2 aria-hidden="true" className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No scenes or clip versions in Bin</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Delete a scene or a clip version from any project and it stays here for 3 days so you
            can restore it before it is permanently deleted.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {orderedGroups.map((group) => (
            <section key={group.projectId} className="rounded-lg border bg-card">
              {/* truncate + title: a real project in production carries a
                  60-character name, and without this the header bar simply
                  stretches to fit it — see this page's own contract. */}
              <h2
                title={group.projectTitle}
                className="truncate rounded-t-[7px] bg-foreground px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-background"
              >
                {group.projectTitle}
              </h2>

              {group.scenes.length > 0 ? (
                <div className="pb-3">
                  <h3 className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Scenes
                  </h3>
                  <div className="grid grid-cols-1 gap-3 px-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {group.scenes.map((scene) => (
                      <BinCard
                        key={scene.sceneId}
                        itemLabel={scene.idx === null ? "Scene" : `Scene #${scene.idx}`}
                        badge={scene.idx === null ? "—" : `#${scene.idx}`}
                        meta={`${scene.versionCount} version${scene.versionCount === 1 ? "" : "s"}`}
                        promptFirstLine={scene.promptFirstLine}
                        deletedAtLabel={scene.deletedAtLabel}
                        expiresLabel={scene.expiresLabel}
                        ownerLabel={scene.ownerLabel}
                        thumbnail={scene.thumbnail}
                        actions={
                          <>
                            {scene.isOwner ? (
                              <ActionForm
                                action={restoreScene}
                                fallbackErrorMessage="Could not restore this scene."
                              >
                                <input type="hidden" name="sceneId" value={scene.sceneId} />
                                <SubmitButton pendingLabel="Restoring" variant="outline" size="sm">
                                  Restore
                                </SubmitButton>
                              </ActionForm>
                            ) : null}
                            {viewerIsAdmin && scene.downloadUrl ? (
                              <a
                                href={asAttachment(scene.downloadUrl, scene.downloadFilename)}
                                download={scene.downloadFilename ?? undefined}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                              >
                                <DownloadIcon aria-hidden="true" className="size-3.5" />
                                Download
                              </a>
                            ) : null}
                            {viewerIsAdmin ? (
                              <ActionForm
                                action={purgeDeletedScene}
                                fallbackErrorMessage="Could not delete this scene permanently."
                              >
                                <input type="hidden" name="sceneId" value={scene.sceneId} />
                                <ConfirmSubmitButton
                                  pendingLabel="Deleting"
                                  variant="outline"
                                  size="sm"
                                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  confirmMessage={`Permanently delete ${
                                    scene.idx === null ? "this scene" : `scene #${scene.idx}`
                                  }? This removes the scene and its files from storage for good — it can no longer be restored.`}
                                >
                                  Delete permanently
                                </ConfirmSubmitButton>
                              </ActionForm>
                            ) : null}
                          </>
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {group.versions.length > 0 ? (
                <div className="pb-3">
                  <h3 className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Versions
                  </h3>
                  <div className="grid grid-cols-1 gap-3 px-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {group.versions.map((version) => (
                      <BinCard
                        key={version.versionId}
                        itemLabel={version.n === null ? "Version" : `Version v${version.n}`}
                        badge={version.n === null ? "—" : `v${version.n}`}
                        promptFirstLine={version.scenePromptFirstLine}
                        deletedAtLabel={version.deletedAtLabel}
                        expiresLabel={version.expiresLabel}
                        ownerLabel={version.ownerLabel}
                        thumbnail={version.thumbnail}
                        actions={
                          <>
                            {version.isOwner ? (
                              <ActionForm
                                action={restoreClipVersion}
                                fallbackErrorMessage="Could not restore this version."
                              >
                                <input type="hidden" name="versionId" value={version.versionId} />
                                <SubmitButton pendingLabel="Restoring" variant="outline" size="sm">
                                  Restore
                                </SubmitButton>
                              </ActionForm>
                            ) : null}
                            {viewerIsAdmin && version.downloadUrl ? (
                              <a
                                href={asAttachment(version.downloadUrl, version.downloadFilename)}
                                download={version.downloadFilename ?? undefined}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                              >
                                <DownloadIcon aria-hidden="true" className="size-3.5" />
                                Download
                              </a>
                            ) : null}
                            {viewerIsAdmin ? (
                              <ActionForm
                                action={purgeDeletedVersion}
                                fallbackErrorMessage="Could not delete this version permanently."
                              >
                                <input type="hidden" name="versionId" value={version.versionId} />
                                <ConfirmSubmitButton
                                  pendingLabel="Deleting"
                                  variant="outline"
                                  size="sm"
                                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  confirmMessage={`Permanently delete ${
                                    version.n === null ? "this version" : `v${version.n}`
                                  }? This removes the version and its clip from storage for good — it can no longer be restored.`}
                                >
                                  Delete permanently
                                </ConfirmSubmitButton>
                              </ActionForm>
                            ) : null}
                          </>
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
