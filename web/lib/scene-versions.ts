// Which clip belongs to which attempt.
//
// scene_versions (0058) records the prompt and frame a render was started
// from, but not the clip — the clip does not exist yet at that moment, and
// the thing that eventually inserts it is the Go worker, which knows nothing
// about versions. Rather than teach it, the link is derived here from the
// one fact both sides already agree on: time.
//
// A clip belongs to the NEWEST version that existed when the clip landed.
// That is exactly the attempt that produced it — a version is opened
// immediately before the scene is queued, so any clip created after that
// point and before the next version was opened came from this render.
//
// The alternative, a version_id column on assets, would put a versions
// concept into the worker's write path for a link that is already implied.

export interface SceneVersionRow {
  id: string;
  n: number;
  created_at: string;
  video_prompt: string | null;
  ref_frame_asset_id: string | null;
  /**
   * Set only when something already knows the answer — 0058's backfill named
   * the clip each pre-existing scene had. When present it WINS over the time
   * window below: those backfilled rows were created after the clips they
   * describe, so the window would exclude every clip that existed before the
   * migration ran.
   */
  clip_asset_id?: string | null;
  /**
   * 0059's snapshots: the EFFECTIVE settings and the length this version was
   * rendered with. Optional on the row type because not every query selects
   * them, and null on any version backfilled by 0058 — which predates the
   * columns and has no honest value to report.
   */
  render_settings?: unknown;
  duration_s?: number | null;
}

export interface ClipAssetRow {
  id: string;
  created_at: string;
}

export interface SceneVersionView {
  id: string;
  /** 1, 2, 3 … shown as "v1". */
  n: number;
  createdAt: string;
  videoPrompt: string | null;
  refFrameAssetId: string | null;
  /** The clip this attempt produced, or null if it never produced one. */
  clipAssetId: string | null;
  /**
   * What this version was actually rendered with (0059). Null means NOT
   * RECORDED — a pre-0059 version — and must be shown as that, never
   * substituted with the scene's current settings, which is the exact
   * defect the snapshot exists to prevent.
   */
  renderSettings: unknown;
  durationS: number | null;
}

/**
 * Pairs each version with the clip that render produced.
 *
 * `versions` and `clips` may arrive in any order; both are sorted here so a
 * caller cannot get a different answer by fetching differently. A clip that
 * predates every version (one rendered before 0058 landed) attaches to the
 * earliest version, which is what the backfill already assumed — otherwise
 * a project's only existing clip would show as belonging to nothing.
 */
export function buildSceneVersions(
  versions: readonly SceneVersionRow[],
  clips: readonly ClipAssetRow[],
): SceneVersionView[] {
  const ordered = [...versions].sort((a, b) => a.n - b.n);
  const views: SceneVersionView[] = ordered.map((version) => ({
    id: version.id,
    n: version.n,
    createdAt: version.created_at,
    videoPrompt: version.video_prompt,
    refFrameAssetId: version.ref_frame_asset_id,
    clipAssetId: null,
    renderSettings: version.render_settings ?? null,
    durationS: version.duration_s ?? null,
  }));

  const named = new Set<string>();
  for (const version of ordered) {
    if (!version.clip_asset_id) continue;
    const view = views.find((candidate) => candidate.id === version.id);
    if (view && clips.some((clip) => clip.id === version.clip_asset_id)) {
      view.clipAssetId = version.clip_asset_id;
      named.add(view.id);
    }
  }

  // Oldest first, so within one version's window the NEWEST clip is the one
  // left standing — the same answer activeClipIdByScene and the worker's
  // SceneClipsForProject give. "Update this version" re-renders into the
  // same window, and MarkDone never sets clip_asset_id, so a version can hold
  // two clips; picking the first one kept showing the clip it replaced.
  const byAge = [...clips].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const clip of byAge) {
    if (views.some((view) => named.has(view.id) && view.clipAssetId === clip.id)) continue;
    const clipAt = new Date(clip.created_at).getTime();
    // The last version opened at or before this clip appeared.
    let owner: SceneVersionView | undefined;
    for (const view of views) {
      if (new Date(view.createdAt).getTime() <= clipAt) {
        owner = view;
      }
    }
    // A clip older than every version belongs to the first attempt on
    // record — see this function's doc comment.
    owner ??= views[0];
    if (owner && !named.has(owner.id)) {
      owner.clipAssetId = clip.id;
    }
  }

  return views.reverse();
}

/**
 * The clip each scene currently DELIVERS — one per scene, chosen by that
 * scene's active version rather than by "whichever clip row came back last".
 *
 * Mirrors the worker's SceneClipsForProject query (worker/internal/store/
 * store.go) so the cut an operator previews and the cut ffmpeg assembles
 * cannot disagree. Before 0058 a plain map keyed by scene_id was correct
 * because re-rendering deleted the old clip first; now that a superseded
 * clip survives, "last one wins" is an arbitrary choice between clips the
 * operator can actually pick between.
 *
 * A scene with no active version (never rendered since 0058) falls back to
 * its newest clip, which is exactly the old behaviour.
 */
export function activeClipIdByScene(
  scenes: readonly { id: string; active_version_id: string | null }[],
  versions: readonly (SceneVersionRow & { scene_id: string })[],
  clips: readonly (ClipAssetRow & { scene_id: string | null })[],
): Map<string, string> {
  const bySceneId = new Map<string, string>();

  for (const scene of scenes) {
    const sceneVersions = versions
      .filter((version) => version.scene_id === scene.id)
      .sort((a, b) => a.n - b.n);
    const sceneClips = clips
      .filter((clip) => clip.scene_id === scene.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    if (sceneClips.length === 0) continue;

    const active = sceneVersions.find((version) => version.id === scene.active_version_id);
    if (active?.clip_asset_id && sceneClips.some((clip) => clip.id === active.clip_asset_id)) {
      // See SceneVersionRow.clip_asset_id: a named clip wins over the window.
      bySceneId.set(scene.id, active.clip_asset_id);
      continue;
    }
    if (!active) {
      // No version to honour — newest clip, the pre-0058 answer.
      bySceneId.set(scene.id, sceneClips[sceneClips.length - 1]!.id);
      continue;
    }

    const activeAt = new Date(active.created_at).getTime();
    const nextAt = sceneVersions
      .filter((version) => new Date(version.created_at).getTime() > activeAt)
      .map((version) => new Date(version.created_at).getTime())
      .sort((a, b) => a - b)[0];

    const inWindow = sceneClips.filter((clip) => {
      const at = new Date(clip.created_at).getTime();
      return at >= activeAt && (nextAt === undefined || at < nextAt);
    });

    const chosen = inWindow[inWindow.length - 1];
    if (chosen) bySceneId.set(scene.id, chosen.id);
  }

  return bySceneId;
}
