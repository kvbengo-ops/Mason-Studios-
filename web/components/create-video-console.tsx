import type { JSX } from "react";
import { requireUser } from "@/actions/guard";
import { ensurePersonalClipProject } from "@/actions/ugc";
import { CreateClipWall, type WallItem } from "@/components/create-clip-wall";
import { ResizablePromptBar } from "@/components/resizable-prompt-bar";
import { UgcColumn } from "@/components/ugc-column";
import { UgcLiveRefresh } from "@/components/ugc-live-refresh";
import { VideoRunsPanel, type VideoRun } from "@/components/video-runs-panel";
import { KIE_MODELS } from "@/lib/kie/models";
import type { AccountBudgetSnapshot } from "@/lib/spend";
import { loadElementTags } from "@/lib/element-library";
import { estimateUsdForScenes } from "@/lib/estimate";
import { getModel, isAudioEnabled, mergeRenderSettings } from "@/lib/models";
import { extFromFilename, signedUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";
import { ugcOptions } from "@/lib/ugc-options";

/** Scenes read for the wall, newest first. Each can carry several takes. */
const RECENT_SCENES = 60;
/** Takes shown. */
const WALL_TAKES = 30;
/** Attempts listed in the Runs pill. */
const RECENT_RUNS = 30;

/** The capped estimate for one scene, or null when it cannot be priced. */
function returnedEstimate(
  scene: { is_talking_head: boolean; duration_s: number; render_settings_override: unknown },
  projectRenderSettings: unknown,
  audioEnabled: boolean,
): number | null {
  try {
    const usd = estimateUsdForScenes([scene], audioEnabled, projectRenderSettings);
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

/** The model and tier a version was rendered with (scene_versions.render_settings snapshot). */
function snapshotModel(raw: unknown): { id: string | null; resolution: string | null } {
  if (typeof raw !== "object" || raw === null) return { id: null, resolution: null };
  const { model, resolution } = raw as { model?: unknown; resolution?: unknown };
  return {
    id: typeof model === "string" ? model : null,
    resolution: typeof resolution === "string" ? resolution : null,
  };
}

/**
 * /create's Video tab: a wall of takes across the caller's own clip projects,
 * and the /ugc prompt bar.
 *
 * NO PROJECT STEP. Generate queues into the account's hidden personal project
 * (ensurePersonalClipProject) with the very same UgcColumn form /ugc uses —
 * same action, guard, confirm and caps — and the clip appears on the wall. A
 * clip still being drawn is a spinner tile, polled until it lands.
 *
 * A TAKE is one rendered version. Pressing Generate again — or Iterate on a
 * take, which refills the bar — makes another; nothing replaces anything.
 */
export async function CreateVideoConsole({
  snapshot,
  initialSceneId,
}: {
  snapshot: AccountBudgetSnapshot;
  initialSceneId?: string;
}): Promise<JSX.Element> {
  const { user, profile } = await requireUser();
  const supabase = await createClient();

  const { data: projectRows } = await supabase
    .from("projects")
    .select("id, title, is_personal, render_settings")
    .eq("user_id", user.id)
    .eq("kind", "clip");
  const projects = projectRows ?? [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const withSound = isAudioEnabled();
  const [sceneResult, elements] = await Promise.all([
    projects.length > 0
      ? supabase
          .from("scenes")
          .select(
            "id, project_id, status, video_prompt, duration_s, active_version_id, created_at, is_talking_head, render_settings_override",
          )
          .in(
            "project_id",
            projects.map((p) => p.id),
          )
          .order("created_at", { ascending: false })
          .limit(RECENT_SCENES)
      : Promise.resolve({ data: [] }),
    loadElementTags(supabase, user.id),
  ]);
  const scenes = [...(sceneResult.data ?? [])];
  if (
    initialSceneId &&
    projects.length > 0 &&
    !scenes.some((scene) => scene.id === initialSceneId)
  ) {
    const { data: requestedScene } = await supabase
      .from("scenes")
      .select(
        "id, project_id, status, video_prompt, duration_s, active_version_id, created_at, is_talking_head, render_settings_override",
      )
      .eq("id", initialSceneId)
      .in(
        "project_id",
        projects.map((project) => project.id),
      )
      .maybeSingle();
    if (requestedScene) scenes.unshift(requestedScene);
  }
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const sceneIds = scenes.map((s) => s.id);

  const videoModels = [...new Set(KIE_MODELS.map((m) => m.kieModelName))];
  // One row per attempt (runs), for the Runs pill. Readable through
  // runs_select's project-owner branch. Filtered by video model rather than
  // scene_id IS NOT NULL so a run still shows here after its scene is deleted
  // (0054_runs_survive_scene_delete.sql sets runs.scene_id to NULL).
  const { data: runRows } =
    projects.length > 0
      ? await supabase
          .from("runs")
          .select("id, scene_id, model, prompt, cost_usd, error, created_at")
          .in(
            "project_id",
            projects.map((p) => p.id),
          )
          .in("model", videoModels)
          .order("created_at", { ascending: false })
          .limit(RECENT_RUNS)
      : { data: [] };
  const latestRunOfScene = new Set<string>();
  const runs: VideoRun[] = (runRows ?? []).map((run) => {
    const scene = run.scene_id ? sceneById.get(run.scene_id) : undefined;
    // Newest first, so the first row seen for a scene is its latest attempt.
    const latest = !!run.scene_id && !latestRunOfScene.has(run.scene_id);
    if (run.scene_id) latestRunOfScene.add(run.scene_id);
    const project = scene ? projectById.get(scene.project_id) : undefined;
    return {
      id: run.id,
      createdAt: run.created_at,
      // A queued scene has not been claimed, so its attempt has no run row
      // yet — that one is listed from the scene below, not as this run.
      status: run.error ? "failed" : latest && scene?.status === "rendering" ? "rendering" : "done",
      modelLabel: KIE_MODELS.find((m) => m.kieModelName === run.model)?.label ?? run.model,
      prompt: run.prompt ?? scene?.video_prompt ?? "",
      costUsd: run.cost_usd,
      reason: run.error,
      // A failure kie did not bill holds nothing (worker's kie.FailedRunCost):
      // what the caps would have held is what came back. Same estimate the
      // caps price with, through the scene's own override.
      returnedUsd:
        run.error && run.cost_usd === null && scene && project
          ? returnedEstimate(scene, project.render_settings, withSound)
          : null,
    };
  });
  // What is still drawing leads the list, even before the worker has claimed
  // it and written its run row.
  const pendingRuns: VideoRun[] = scenes
    .filter(
      (scene) =>
        scene.status === "queued" ||
        (scene.status === "rendering" && !latestRunOfScene.has(scene.id)),
    )
    .map((scene) => ({
      id: `scene-${scene.id}`,
      createdAt: scene.created_at,
      status: scene.status === "queued" ? "queued" : "rendering",
      modelLabel: getModel(
        mergeRenderSettings(
          projectById.get(scene.project_id)?.render_settings,
          scene.render_settings_override,
        ).model,
      ).label,
      prompt: scene.video_prompt ?? "",
      costUsd: null,
      reason: null,
      returnedUsd: null,
    }));

  const [versionResult, referenceResult] =
    sceneIds.length > 0
      ? await Promise.all([
          supabase
            .from("scene_versions")
            .select(
              "id, n, scene_id, clip_asset_id, video_prompt, duration_s, render_settings, created_at",
            )
            .in("scene_id", sceneIds),
          supabase
            .from("scene_references")
            .select("scene_id, tag")
            .in("scene_id", sceneIds)
            .order("kind", { ascending: true })
            .order("ordinal", { ascending: true }),
        ])
      : [{ data: [] }, { data: [] }];
  const versions = (versionResult.data ?? []).filter((v) => v.clip_asset_id !== null);
  const versionCount = new Map<string, number>();
  for (const v of versionResult.data ?? []) {
    versionCount.set(v.scene_id, (versionCount.get(v.scene_id) ?? 0) + 1);
  }
  const tagsByScene = new Map<string, string[]>();
  for (const row of referenceResult.data ?? []) {
    if (row.tag === null) continue;
    tagsByScene.set(row.scene_id, [...(tagsByScene.get(row.scene_id) ?? []), row.tag]);
  }

  const sortedTakes = [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const takes = sortedTakes.slice(0, WALL_TAKES);
  const initialVersionId = initialSceneId
    ? (sceneById.get(initialSceneId)?.active_version_id ?? null)
    : null;
  const requestedTake = initialVersionId
    ? sortedTakes.find((version) => version.id === initialVersionId)
    : null;
  // Keep a notification-targeted active take outside the recent wall limit.
  if (requestedTake && !takes.some((version) => version.id === requestedTake.id))
    takes.push(requestedTake);
  const { data: assetRows } =
    takes.length > 0
      ? await supabase
          .from("assets")
          .select("id, storage_key")
          .in(
            "id",
            takes.map((v) => v.clip_asset_id!),
          )
      : { data: [] };
  const assetById = new Map((assetRows ?? []).map((a) => [a.id, a]));

  const clipItems: WallItem[] = [];
  for (const version of takes) {
    const scene = sceneById.get(version.scene_id);
    const asset = assetById.get(version.clip_asset_id!);
    const project = scene ? projectById.get(scene.project_id) : undefined;
    if (!scene || !asset || !project) continue;
    const used = snapshotModel(version.render_settings);
    const known = used.id ? getModel(used.id) : null;
    clipItems.push({
      kind: "clip",
      key: version.id,
      sceneId: scene.id,
      versionId: version.id,
      projectId: project.id,
      projectTitle: project.title,
      personal: project.is_personal,
      prompt: version.video_prompt ?? scene.video_prompt ?? "",
      modelLabel: known && known.id === used.id ? known.label : null,
      modelId: used.id,
      resolution: used.resolution,
      durationS: version.duration_s ?? scene.duration_s,
      createdAt: version.created_at,
      url: await signedUrl(asset.storage_key),
      filename: `clip-${version.n}.${extFromFilename(asset.storage_key, "mp4")}`,
      referenceTags: tagsByScene.get(scene.id) ?? [],
      // deleteClipVersion refuses the current (or only) version, and
      // deleteClipScene takes every take of the scene with it — so a scene
      // with one take deletes as a scene, and the current take of a scene
      // with several cannot be deleted from here.
      deleteMode:
        (versionCount.get(scene.id) ?? 1) <= 1
          ? "scene"
          : scene.active_version_id === version.id
            ? null
            : "version",
    });
  }

  // Newest first: what is drawing right now leads the wall, then the takes.
  const clipSceneIds = new Set(clipItems.map((i) => (i.kind === "clip" ? i.sceneId : "")));
  const liveItems: WallItem[] = [];
  let inFlight = false;
  for (const scene of scenes) {
    if (scene.status === "queued" || scene.status === "rendering") {
      inFlight = true;
      liveItems.push({
        kind: "rendering",
        key: `live-${scene.id}`,
        prompt: scene.video_prompt ?? "",
        queued: scene.status === "queued",
      });
    } else if (scene.status === "failed" && !clipSceneIds.has(scene.id)) {
      liveItems.push({
        kind: "failed",
        key: `failed-${scene.id}`,
        sceneId: scene.id,
        prompt: scene.video_prompt ?? "",
      });
    }
  }

  return (
    <>
      <UgcLiveRefresh inFlight={inFlight} />
      <VideoRunsPanel runs={[...pendingRuns, ...runs]} />
      <CreateClipWall
        key={initialVersionId ?? "wall"}
        items={[...liveItems, ...clipItems]}
        projects={projects.filter((p) => !p.is_personal).map((p) => ({ id: p.id, title: p.title }))}
        initialVersionId={initialVersionId}
        elements={elements}
      />

      {/* Same sticky dock as the image bar: <main> is the scroll container. */}
      <div className="pointer-events-none sticky bottom-0 z-30 mt-auto bg-gradient-to-t from-background via-background to-transparent px-3 pb-3 pt-8 has-[[data-moved=true]]:bg-none">
        <div className="flex w-full flex-col gap-2">
          <ResizablePromptBar storageKey="create" defaultPx={80}>
            <UgcColumn
              layout="bar"
              // No project step: Generate queues into the account's hidden
              // personal project and the clip appears on the wall above.
              projectId=""
              ensureProject={ensurePersonalClipProject}
              options={ugcOptions(withSound, profile.role)}
              budget={{
                dailyCapEnabled: snapshot.dailyCapEnabled,
                dailyRemainingUsd: snapshot.dailyRemainingUsd,
                dailyCapUsd: snapshot.dailyCapUsd,
                weeklyRemainingUsd: snapshot.weeklyRemainingUsd,
                weeklyCapUsd: snapshot.weeklyCapUsd,
                globalRemainingUsd: snapshot.globalRemainingUsd,
                globalCapUsd: snapshot.globalCapUsd,
                globalCapEnabled: snapshot.globalCapEnabled,
                globalCapPeriod: snapshot.globalCapPeriod,
                hourlyRemainingUsd: snapshot.hourlyRemainingUsd,
                hourlyCapUsd: snapshot.hourlyCapUsd,
              }}
              vendor="kie"
              audioEnabled={withSound}
              selectedScene={null}
              elements={elements}
            />
          </ResizablePromptBar>
        </div>
      </div>
    </>
  );
}
