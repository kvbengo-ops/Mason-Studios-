// Step 9 — Deliver (docs/architecture.md § "User flow": "clips + manifest,
// or assembled mp4"). Assembly into a single mp4 is entirely the Go
// worker's job, via `loop.Assemble`, gated behind ASSEMBLE_ENABLED (see
// docs/roadmap.md for the product question of whether it stays optional).
// This page only ever reads whatever `clip`/`final` assets already exist;
// it never triggers, stubs, or calls assembly logic.
//
// WHICH final it shows is resolved through projects.active_final_version_id
// (0060_final_versions.sql), never `assets.find(kind === 'final')`. Old cuts
// are kept now instead of being deleted to trigger a rebuild, so a project
// routinely holds several `final` rows and that `.find()` picked its winner
// by whatever the query returned first — the assembled video an operator
// downloaded was decided arbitrarily. The active version is the only
// non-arbitrary answer, and it is also what the archive route downloads.
//
// A version with no file is not one state but three, and this page says
// which: still building (built_at null — the assembling placeholder), given
// up on (failed_at set — its failure_reason, not a spinner that never
// resolves), or built and since pruned to its recipe (rebuild, not a player
// that cannot play).

import type { JSX } from "react";
import Link from "next/link";
import { requireProjectReadable } from "@/actions/guard";
import { getCutStatus } from "@/actions/deliver";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";
import { activeClipIdByScene } from "@/lib/scene-versions";
import { filenameForClip } from "@/lib/manifest";
import { isAssembleEnabled } from "@/lib/models";
import { getProjectSpend } from "@/lib/db-aggregates";
import { hasMockVideoEvidence } from "@/lib/mock-flags";
import { ClipGrid, type ClipGridClip } from "@/components/clip-grid";
import { AssemblingStatus } from "@/components/assembling-status";
import { FinalVersionPicker, type FinalVersionOption } from "@/components/final-version-picker";
import { MockModeBanner } from "@/components/mock-mode-banner";
import { Card, CardContent } from "@/components/ui/card";
import type { Database } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];
type AssetRow = Database["public"]["Tables"]["assets"]["Row"];
type FinalVersionRow = Database["public"]["Tables"]["final_versions"]["Row"];

// Editors may be downloading clips over the course of a session — give the
// signed URLs on this page more headroom than the 1h default.
const DELIVER_SIGNED_URL_TTL_SECONDS = 3600;

async function loadOrderedScenes(projectId: string): Promise<SceneRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("scenes")
    .select("*")
    .eq("project_id", projectId)
    .order("idx", { ascending: true });

  if (error) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${error.message}`);
  }
  return data ?? [];
}

async function loadDeliverableAssets(projectId: string): Promise<AssetRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .in("kind", ["clip", "final", "poster"]);

  if (error) {
    throw new Error(`Failed to load assets for project ${projectId}: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Every cut this project has ever been assembled into, newest first — the
 * picker's list, and the source of the one that is currently active. Ordered
 * by `n` rather than created_at because `n` is the number the operator reads
 * and the two can disagree: a version rebuilt in place keeps its number and
 * gets a new build time.
 */
async function loadFinalVersions(projectId: string): Promise<FinalVersionRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("final_versions")
    .select("*")
    .eq("project_id", projectId)
    .order("n", { ascending: false });

  if (error) {
    throw new Error(`Failed to load final versions for project ${projectId}: ${error.message}`);
  }
  return data ?? [];
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * The delivered format, shown in this page's meta line. A constant, not a
 * setting, because it genuinely is one: the worker asks every vendor for
 * 9:16 (`"aspect_ratio": "9:16"` is hard-coded in
 * worker/internal/kie/models.go, whose own comment calls it "this product's
 * only delivered aspect ratio") and then normalises every clip to 1080x1920
 * before concatenating (`scale=1080:1920` in worker/internal/media/media.go).
 * projects.render_settings carries model/resolution/fps and NOTHING else
 * (lib/models.ts's RenderSettings) — there is no per-project aspect ratio to
 * read, so reading one here would be inventing a field. If a landscape
 * output ever ships, it starts in those two worker files and this constant
 * becomes a real read.
 */
const DELIVERED_ASPECT_RATIO = "9:16";

export default async function DeliverPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { project, isOwner } = await requireProjectReadable(id);

  // One `runs` read, filtered on runs.project_id — see getProjectSpend
  // (lib/db-aggregates.ts) for why this page must not go through scenes to
  // find its own spend. Only the project total is read here now: the
  // per-scene figures this page used to compute existed for the per-clip
  // Re-render/Fix the prompt dialogs, which have moved off this screen (see
  // ClipGrid's header comment).
  const supabase = await createClient();
  const [scenes, assets, spend, cutStatus, finalVersions] = await Promise.all([
    loadOrderedScenes(id),
    loadDeliverableAssets(id),
    getProjectSpend(supabase, id),
    getCutStatus(id),
    loadFinalVersions(id),
  ]);

  // One clip per scene, chosen by the scene's ACTIVE version — not
  // "whichever row the query returned last". Superseded clips survive a
  // re-render now (0058_scene_versions.sql), so a map keyed by scene_id
  // alone would pick arbitrarily between clips the operator can switch
  // between deliberately. Same rule the worker assembles by.
  const { data: versionRows } = await supabase
    .from("scene_versions")
    .select("id, n, created_at, video_prompt, ref_frame_asset_id, clip_asset_id, scene_id")
    .in(
      "scene_id",
      scenes.map((scene) => scene.id),
    );

  const activeClipIds = activeClipIdByScene(
    scenes,
    versionRows ?? [],
    assets
      .filter((asset) => asset.kind === "clip")
      .map((asset) => ({ id: asset.id, created_at: asset.created_at, scene_id: asset.scene_id })),
  );

  const clipAssetByScene = new Map<string, AssetRow>();
  const posterAssetByScene = new Map<string, AssetRow>();
  for (const asset of assets) {
    if (asset.kind === "clip" && asset.scene_id) {
      if (activeClipIds.get(asset.scene_id) === asset.id) {
        clipAssetByScene.set(asset.scene_id, asset);
      }
    } else if (asset.kind === "poster" && asset.scene_id) {
      posterAssetByScene.set(asset.scene_id, asset);
    }
  }
  // The cut this page is about. Resolved by id through the active version —
  // see this file's header for the arbitrary-winner bug that replaced.
  const activeVersion =
    finalVersions.find((version) => version.id === project.active_final_version_id) ?? null;
  const finalAsset = assets.find((asset) => asset.id === activeVersion?.final_asset_id) ?? null;
  // The final's poster is now the ACTIVE VERSION's poster, by id — not
  // "whichever project-level poster row exists". Posters are best-effort
  // everywhere (the worker logs and swallows a failed extraction, and every
  // asset created before 0022_asset_poster_kind.sql has no poster row at
  // all), so this is expected to routinely come back empty and every
  // consumer below degrades to today's posterless behaviour when it does.
  // What it must NOT do is fall back to some other version's poster: a
  // thumbnail of a different cut is worse than none, because nothing about
  // it looks wrong.
  const finalPosterAsset =
    assets.find((asset) => asset.id === activeVersion?.poster_asset_id) ?? null;

  const scenesWithClips = scenes.filter((scene) => clipAssetByScene.has(scene.id));

  const [clips, finalUrl, finalPosterUrl] = await Promise.all([
    Promise.all(
      scenesWithClips.map(async (scene): Promise<ClipGridClip> => {
        const asset = clipAssetByScene.get(scene.id) as AssetRow;
        const posterAsset = posterAssetByScene.get(scene.id);
        // quality 80, no width — same WebP-negotiation transform as
        // frames/page.tsx and library/page.tsx: this is a display call
        // site, never a source of truth, so recompressing is safe.
        // Deliberately no `width` here, unlike those other display call
        // sites: posters are minted by the worker's own ffmpeg pass at a
        // fixed 360x640 and already tuned to land around ~15kB (see
        // posterScale/posterQuality in worker/internal/media/media.go) —
        // there's no oversized original to trim down here. The clip grid's
        // video box (~280-360px CSS-wide across this app's breakpoints)
        // already meets or exceeds that 360px source at any real device
        // pixel ratio, and Supabase's transform never upscales past the
        // source (see ImageTransform's doc comment in lib/storage.ts) — so
        // a `width` here could only ever shrink the poster further below
        // what the box already needs, making it measurably softer to save
        // a few more kB off an asset that's already small.
        // Resolves to undefined (never null/"") when there's no poster row
        // yet — see ClipGridClip.posterUrl for why that distinction matters.
        const activeVersion = (versionRows ?? []).find(
          (version) => version.id === scene.active_version_id,
        );
        const [videoUrl, posterUrl] = await Promise.all([
          signedUrl(asset.storage_key, DELIVER_SIGNED_URL_TTL_SECONDS),
          posterAsset
            ? signedUrl(posterAsset.storage_key, DELIVER_SIGNED_URL_TTL_SECONDS, { quality: 80 })
            : Promise.resolve(undefined),
        ]);
        return {
          id: scene.id,
          idx: scene.idx,
          isTalkingHead: scene.is_talking_head,
          durationS: scene.duration_s,
          versionN: activeVersion?.n,
          videoUrl,
          posterUrl,
          filename: filenameForClip(scene.idx, asset.storage_key),
        };
      }),
    ),
    finalAsset
      ? signedUrl(finalAsset.storage_key, DELIVER_SIGNED_URL_TTL_SECONDS)
      : Promise.resolve(null),
    // No `width` here either — same already-360x640-and-tiny reasoning as
    // the per-clip poster above.
    finalPosterAsset
      ? signedUrl(finalPosterAsset.storage_key, DELIVER_SIGNED_URL_TTL_SECONDS, { quality: 80 })
      : Promise.resolve(null),
  ]);

  const totalRuntimeS = scenes.reduce((sum, scene) => sum + scene.duration_s, 0);
  const incomplete = scenes.length === 0 || scenes.some((scene) => scene.status !== "done");

  // Mirrors worker/internal/store's ProjectsReadyToAssemble: every scene has
  // left queued/rendering (won't change anymore) — not the stricter
  // `incomplete` check above, which also flags a project as "incomplete"
  // when a scene failed. A project can be assembly-ready with a failed
  // scene in it; the worker just concats whatever clips exist.
  const allTerminal =
    scenes.length > 0 &&
    scenes.every((scene) => scene.status === "done" || scene.status === "failed");
  // The three "no playable file" states, told apart by the active version
  // rather than inferred from an absence. Before 0060 this page could only
  // guess ("every scene is terminal and there's no final row, so one must be
  // coming"), which was wrong the moment assembly failed or the file was
  // pruned: both looked exactly like "still building" and the placeholder
  // spun until the operator gave up on it.
  const versionFailed = activeVersion !== null && activeVersion.failed_at !== null;
  const versionPending =
    activeVersion !== null && activeVersion.built_at === null && activeVersion.failed_at === null;
  // Built once, file since gone. The recipe survives, so this is a rebuild,
  // not a loss — the picker offers it.
  const versionPruned =
    activeVersion !== null &&
    activeVersion.built_at !== null &&
    activeVersion.final_asset_id === null;

  // Only show the placeholder when a build is actually outstanding. If
  // ASSEMBLE_ENABLED is off, no worker is coming for that row, so this must
  // stay silent — same as before.
  const assembling = isAssembleEnabled() && versionPending;

  // ANY outstanding row, not just the active one. A rebuild opens a NEW
  // version that is not active until the worker finishes it, so keying this
  // off `versionPending` (which asks about the active version) would leave
  // the button live throughout the very build it started — and 0060's
  // partial unique index means the second press fails on the constraint
  // rather than queueing anything.
  const buildInProgress = finalVersions.some(
    (version) => version.built_at === null && version.failed_at === null,
  );

  const versionOptions: FinalVersionOption[] = finalVersions.map((version) => ({
    id: version.id,
    // `n` is nullable in the schema only so the assign-n trigger can fill it
    // (0060); a row that has been inserted always has one. The fallback keeps
    // this total rather than rendering "vnull".
    n: version.n ?? 0,
    builtAt: version.built_at,
    failedAt: version.failed_at,
    failureReason: version.failure_reason,
    hasFile: version.final_asset_id !== null,
  }));

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* One line of meta, not three stat tiles. The cut is what this screen
          is for; runtime/scene count/format are how you identify it, and
          spend is a footnote pushed to the right — it is history by the time
          anyone reads this page (nothing here bills), so it should not be the
          largest number on it. */}
      <div className="flex flex-col gap-1">
        {/* The cut picker rides the page header, not the player.
            It was drawn four times before — once inside each of the four
            slot states (playing, failed, pruned, building) — so it moved
            down the page as the state changed and vanished entirely from
            some of them. It is the one control that answers "which cut am I
            looking at", and that question outlives every one of those
            states: a version that is still building has no player to sit
            under, and that is exactly when an operator wants to see which
            version it is. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-2xl font-medium text-foreground">{project.title}</h1>
          <FinalVersionPicker
            projectId={id}
            versions={versionOptions}
            activeVersionId={activeVersion?.id ?? null}
            canSwitch={isOwner}
          />
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm text-muted-foreground">
            Final video · {totalRuntimeS}s · {scenes.length}{" "}
            {scenes.length === 1 ? "scene" : "scenes"} · {DELIVERED_ASPECT_RATIO}
          </p>
          <p className="text-sm tabular-nums text-muted-foreground">
            {usdFormatter.format(spend.totalUsd)} spent
          </p>
        </div>
      </div>

      {/* The most consequential of the four mock banners: this is the page
          an operator hands to a client. hasMockVideoEvidence reads
          scenes.kie_task_id, already loaded above — no extra query, and
          proof, not a guess (see lib/mock-flags.ts). */}
      {hasMockVideoEvidence(scenes) ? (
        <MockModeBanner>
          MODE=development was on for at least one clip below — it is the worker&apos;s canned
          fixture, not a real fal render. Do not deliver this to a client. This does not confirm the
          worker&apos;s current setting, only that these specific scenes were mocked when submitted.
        </MockModeBanner>
      ) : null}

      {incomplete ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Not every scene has finished rendering yet — this is not the full delivery. See{" "}
          <Link
            href={`/projects/${id}/render`}
            className="font-medium underline underline-offset-4"
          >
            render progress
          </Link>{" "}
          for what&apos;s still in flight. Whatever clips have finished are listed below.
        </p>
      ) : null}

      {finalAsset && finalUrl ? (
        // No heading over it on purpose: this IS the screen, and a
        // "Assembled video" title only competes with the one heading that
        // earns its place below ("Order"). The card spans the panel and the
        // player is the largest thing on the page — the clips underneath are
        // its parts, not its peers.
        <Card>
          <CardContent className="flex flex-col items-center gap-3">
            {/* Sized by HEIGHT, not width. The cut is 9:16
                (DELIVERED_ASPECT_RATIO above), so a width-driven "full
                width" player would be several viewports tall and push the
                clip grid off the screen entirely; max-h + w-auto lets the
                browser derive the width from the real aspect ratio, so it
                gets as big as fits and never letterboxes. */}
            <video
              controls
              preload="metadata"
              // ?? undefined, not the bare finalPosterUrl (string | null):
              // React drops an absent poster attribute either way, but
              // `poster?: string` on the JSX type doesn't accept null. The
              // assembled final's poster is rarer than a clip's — assembly
              // itself is optional (ASSEMBLE_ENABLED) and the worker only
              // just started extracting it — so this is routinely absent.
              poster={finalPosterUrl ?? undefined}
              className="max-h-[70vh] w-auto max-w-full rounded-md bg-muted"
              src={finalUrl}
            >
              Your browser does not support inline video playback.
            </video>
          </CardContent>
        </Card>
      ) : versionFailed ? (
        // The reason, not a spinner. A failed assemble used to be
        // indistinguishable from a slow one (both were "no final row"), so
        // the page span until the operator gave up guessing.
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-destructive">
              Assembling v{activeVersion?.n ?? 0} failed
              {activeVersion?.failure_reason ? `: ${activeVersion.failure_reason}` : "."}
            </p>
          </CardContent>
        </Card>
      ) : versionPruned ? (
        // Built, then the file was pruned. The recipe is a complete record
        // of the cut, so this offers the rebuild the picker knows how to
        // ask for rather than a player pointed at nothing.
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              The file for v{activeVersion?.n ?? 0} is no longer stored. What it was built from is
              kept, so it can be rebuilt — or pick another cut.
            </p>
          </CardContent>
        </Card>
      ) : assembling ? (
        // AssemblingStatus polls hasFinalAsset (actions/deliver.ts), which
        // is owner-only (requireProject) same as every other action — a
        // read-only admin viewer would just have that poll fail quietly in
        // the background every 6s for two minutes. Skipped for them; the
        // plain text says the same thing without polling anything.
        <div className="flex flex-col gap-3">
          {isOwner ? (
            <AssemblingStatus projectId={id} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Assembling the full video from the finished clips — this takes a minute or two.
            </p>
          )}
          {/* Still offered while a build is in flight: an operator watching
              v3 assemble can drop back to v2 and watch that instead. */}
        </div>
      ) : null}

      {/* The "Order" label that used to live here is ClipGrid's now — it was
          one of two competing headings over the same list, and the grid is
          the thing that knows whether reordering is available at all. */}
      <ClipGrid
        projectId={id}
        projectTitle={project.title}
        clips={clips}
        hasFinal={finalAsset !== null}
        // Not the same question as hasFinal — see that prop's doc comment.
        // A pruned version still has a row to rebuild in place.
        hasFinalVersion={activeVersion !== null}
        buildInProgress={buildInProgress}
        finalUrl={finalUrl}
        initialStatus={project.status}
        // scenes is already ordered by idx ascending (loadOrderedScenes) —
        // exactly the sequence reorderCut expects its complete orderedIds
        // in, including scenes with no clip (failed) that never appear in
        // `clips` itself. See clip-grid.tsx's mergeFullOrder for why the
        // grid needs this superset, not just the ids it renders cards for.
        sceneOrder={scenes.map((scene) => scene.id)}
        allTerminal={allTerminal}
        // The same `incomplete` the red banner above is drawn from, so the
        // banner's claim ("this is not the full delivery") and the state of
        // the Mark delivered button can never disagree.
        allScenesDone={!incomplete}
        unfinishedSceneCount={scenes.filter((scene) => scene.status !== "done").length}
        cutStatus={cutStatus}
        readOnly={!isOwner}
      />
    </div>
  );
}
