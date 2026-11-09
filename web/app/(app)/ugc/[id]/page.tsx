// /ugc — one clip, one press.
//
// The destination New project now opens instead of the six-screen wizard. See
// actions/ugc.ts for why this is a shorter pipeline rather than a shortcut
// through the existing one, and lib/kie/rates.ts for why the prices are in
// credits.
//
// Selection lives in the URL, not in client state. `?scene=` drives three
// separate things at once — the column loads that scene's prompt, the result
// shows its current version, the rail lists its attempts — and a
// server-rendered param is the only version of that where the three cannot
// disagree. `?v=` is which attempt is being LOOKED at, which is a different
// fact from which one is current: only Make current writes that.

import { Suspense, type JSX } from "react";
import Link from "next/link";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";
import { requireProjectReadable } from "@/actions/guard";
import {
  CreateModeContent,
  CreateModeSkeleton,
  CreateModeSwitch,
} from "@/components/create-mode-switch";
import { ImageGeneratorConsole } from "@/components/image-generator-console";
import { getAccountBudgetSnapshot } from "@/lib/spend";
import type { RenderBudgetFigures } from "@/lib/render-budget";
import { createClient } from "@/lib/supabase/server";
import { signedUrl, extFromFilename } from "@/lib/storage";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import { geminiVoiceFor } from "@/lib/gemini-voices";
import { videoAspectRatioFor } from "@/lib/kie/models";
import { videoQualityFor, type VideoQuality } from "@/lib/video-quality";
import { getModel, isAudioEnabled, mergeRenderSettings, type RenderSettings } from "@/lib/models";
import { latestErrorsByScene } from "@/lib/render-error";
import { UgcLiveRefresh } from "@/components/ugc-live-refresh";
import { Spinner } from "@/components/spinner";
import { filenameForClip } from "@/lib/manifest";
import { ugcOptions } from "@/lib/ugc-options";
import { UgcColumn, type UgcOption } from "@/components/ugc-column";
import { UgcTitle } from "@/components/ugc-title";
import { UgcSceneStrip, type UgcScene } from "@/components/ugc-scene-strip";
import type { UgcVersion } from "@/components/ugc-version-rail";
import { IterateButton } from "@/components/iterate-button";
import { ResizablePromptBar } from "@/components/resizable-prompt-bar";
import { UgcDeletedScenes, type UgcDeletedScene } from "@/components/ugc-deleted-scenes";
import { binRetentionCutoffIso } from "@/lib/bin-thumbnails";
import {
  buildSceneVersions,
  activeClipIdByScene,
  type SceneVersionRow,
  type ClipAssetRow,
} from "@/lib/scene-versions";
import type { ElementTag } from "@/lib/elements";
import { asAttachment } from "@/lib/download-url";
import { resultPanelState } from "@/lib/result-panel";
import { dateTimeFormatter } from "@/lib/datetime";

// ugc's own scenes.idx starts at 1 and is shown as-is (actions/ugc.ts's
// generateClip: `idx = (last?.idx ?? 0) + 1`, and ugc-scene-strip.tsx prints
// `scene.idx` with no offset). That is NOT lib/manifest.ts's convention —
// filenameForClip's own doc comment says its `idx` is the scripted
// pipeline's raw, 0-based `scenes.idx`, and the function adds 1 itself.
// Feeding it ugc's already-1-based idx straight would double-shift every
// filename ("scene 1" downloading as scene-02.mp4), so this subtracts the 1
// back out first — one place, so nobody has to remember it at each call site
// below.
function ugcClipFilename(idx: number, storageKey: string): string {
  return filenameForClip(idx - 1, storageKey);
}

/**
 * The version rail's own per-attempt filename — `-v{n}` appended so two
 * attempts at the same scene don't both suggest "scene-01.mp4" to the
 * browser's save dialog. Built directly rather than through
 * filenameForClip: that function's own output has already lost the
 * extension by the time you'd want to splice a suffix in front of it.
 */
function ugcVersionFilename(idx: number, n: number, storageKey: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(storageKey);
  const ext = match?.[1] ?? "mp4";
  return `scene-${String(idx).padStart(2, "0")}-v${n}.${ext}`;
}

/**
 * The first line of an archived scene's video_prompt, for the trash list —
 * never empty, since a scene deleted before it ever got a prompt is still a
 * row worth showing, just not one with words to quote.
 */
function firstLine(text: string | null | undefined): string {
  const line = text?.split("\n")[0]?.trim();
  return line ? line : "(no prompt)";
}

// Editors may sit on this page for a while comparing takes before
// downloading one — same headroom the Deliver page's own
// DELIVER_SIGNED_URL_TTL_SECONDS gives, well past the 1h default.
const RESULT_SIGNED_URL_TTL_SECONDS = 3600;

// Display-only transform for an Element's picker/hover-preview thumbnail —
// never applied to a source-of-truth read (the copy actions/ugc.ts's
// generateClip makes from an Element's asset always reads the UNTRANSFORMED
// storage_key). `resize: "contain"`, not the default "cover", because a
// `width`-only transform without it silently squashes the image — see
// lib/storage.ts's ImageTransform doc comment.
//
// 320, NOT 96. The picker's grid tiles are about 150 CSS pixels wide and the
// detail panel's preview is 176, which on a 2x display asks for 300 and 352
// real pixels — so a 96px source was being upscaled three times over in the
// one place an operator studies a reference to tell it from four others like
// it. This is still about 1% of the 2 MB originals these are made from, and
// Supabase bills transformations per origin image, not per size, so a wider
// thumbnail costs nothing extra.
const ELEMENT_THUMBNAIL_TRANSFORM = { width: 320, resize: "contain" as const, quality: 70 };

// creditsForRetry — what "Try again" would have cost, priced off the
// scene's own stored settings rather than the column's pickers — is GONE
// along with that control. See the failure panel below for why: Regenerate
// (in the column, which already re-prices from whatever the operator has on
// screen) is the one requeue control this route has now.

export default async function UgcPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ scene?: string; v?: string; tab?: string }>;
}): Promise<JSX.Element> {
  const { id: projectId } = await params;
  // THE PERMISSIVE GUARD, and the reason it is safe here is the same one
  // e61a82a gave for the seven scripted-pipeline pages: every write action
  // this page can reach still calls requireProject, which refuses a
  // non-owner in the server. So a control this page fails to hide is a
  // cosmetic bug, not a hole.
  //
  // This used to be requireProject, deliberately, and the comment said
  // "Admins are refused too". That was true and it made an admin's own
  // /projects list advertise a door it had locked — clicking a /ugc project
  // they could plainly see returned 404. `isOwner` is what everything below
  // reads instead of re-deriving ownership.
  const { project, user, profile, isOwner } = await requireProjectReadable(projectId);
  const { scene: sceneParam, v: versionParam, tab } = await searchParams;
  // Where the switch's Video side goes back to: the scene being looked at.
  const videoHref = `/ugc/${project.id}${sceneParam ? `?scene=${sceneParam}` : ""}`;

  // THE IMAGE TAB, without leaving the project: the personal image generator
  // (the same console /create shows). Pictures made here land in the
  // account's own gallery, can be saved as elements, and @tagged in this
  // project's clips. Returned before any of the clip console's reads.
  if (tab === "image") {
    return (
      <div className="flex min-h-full flex-col">
        <header className="flex flex-wrap items-center justify-between gap-4 px-4 pb-4 pt-6">
          {/* The personal generator, not this project's: titled as such. */}
          <h1 className="text-2xl font-semibold tracking-tight">Image Generator</h1>
          <CreateModeSwitch
            video={false}
            imageHref={`${videoHref}${sceneParam ? "&" : "?"}tab=image`}
            videoHref={videoHref}
          />
        </header>
        <CreateModeContent video={false} projectVideo>
          <Suspense fallback={<CreateModeSkeleton video={false} />}>
            <ImageGeneratorConsole />
          </Suspense>
        </CreateModeContent>
      </div>
    );
  }

  // Resolved on the server: offerable() reads isPriceEstimated, which reads
  // KIE_MODELS, and that env is not NEXT_PUBLIC_ — a client-side call would
  // answer "fal" for everything and both mislabel and misprice the button.
  // SOUND TIER, AND EACH MODEL'S OWN CHEAPEST OFFERABLE TIER.
  //
  // offerable(false) quoted the silent rate while every render sets
  // generate_audio true, so the two Seedance 2.0 models — which have no
  // silent rate at all, because nothing has ever been rendered on them that
  // way — could not appear here however they were priced.
  //
  // ugcOptions (lib/ugc-options.ts) narrows each model to its cheapest
  // offerable tier under this sound setting, not a literal "480p" — see that
  // file's header for the history: the literal deliberately excluded Kling
  // and Hailuo while this route was tuned for one model's prompt behaviour.
  // Kling is offered BY REQUEST now, at std/720p either way since the
  // 2026-09-10 silent receipt: 20 cr/s with sound (cheaper than pro/1080p's
  // 27), 14 without (cheaper than pro/1080p's 18).
  //
  // With sound on, Hailuo never appears here: it has no sound rate at all,
  // so offerable(true) never returns it. With
  // AUDIO_ENABLED=0 the silent picker also lists Hailuo 2.3 Pro (6s/10s) and
  // prices Kling at its silent rate — consistent with generateClip, which
  // validates against this same offerable(isAudioEnabled()).
  //
  // READ FROM THE ENV, not written as `true`. The literal was right for
  // production and still let this page disagree with the Server Action, which
  // asked offerable(false) and refused by name a model this list had just
  // offered. Both sides now read the one fact that decides it — whether this
  // render carries sound — so they cannot answer it differently.
  const withSound = isAudioEnabled();
  const options: UgcOption[] = ugcOptions(withSound, profile.role);

  // Four seconds is the default because it is what the workflow this route
  // serves actually uses: short takes make a retry cheap, and a retry is the
  // normal case rather than the exception.

  // The three-cap snapshot the Regenerate confirm needs. Without it that
  // dialog can show a price but cannot say "this would breach the weekly
  // cap" — and a Confirm that only finds out server-side is a click the
  // operator had no way to avoid.
  const snapshot = await getAccountBudgetSnapshot(user.id, profile);
  const budget: RenderBudgetFigures = {
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
  };

  const supabase = await createClient();

  // Named, not just "another user". An admin looking at a read-only page
  // needs to know WHOSE it is to do anything useful with what they see, and
  // profiles_select_admin already grants this read to the session client —
  // the same reasoning projects/[id]/layout.tsx documents for its own
  // banner, whose wording this matches on purpose.
  let ownerLabel: string | null = null;
  if (!isOwner) {
    const { data: ownerProfile } = await supabase
      .from("profiles")
      .select("email, username")
      .eq("id", project.user_id)
      .maybeSingle();
    ownerLabel = ownerProfile?.email ?? ownerProfile?.username ?? "another user";
  }

  let scenes: UgcScene[] = [];
  // The strip's tiles: `scenes`, with every scene that has several versions
  // expanded into one tile per version — a TAKE.
  let stripScenes: UgcScene[] = [];
  let versions: UgcVersion[] = [];
  let selected: {
    id: string;
    idx: number;
    prompt: string;
    active_version_id: string | null;
    /** The scene's effective render settings — what rerenderScene will price and submit. */
    settings: RenderSettings;
    durationS: number;
    /**
     * Not versioned — scene_versions carries no is_talking_head/script_line
     * columns, only video_prompt (0058) — so these are always the SCENE's
     * current values, even while looking at an older attempt's prompt below.
     * generateClip sets is_talking_head from the chosen model now (true only
     * for Kling — see actions/ugc.ts), but /ugc still writes no script_line
     * (no Dialogue field on this route), so the prompt preview's dialogue
     * append can never fire regardless — read straight off the schema so it
     * degrades correctly rather than assuming a control this branch does not
     * have.
     */
    isTalkingHead: boolean;
    scriptLine: string | null;
    /**
     * The lengths of the video references THIS SCENE carries, one entry each,
     * null where the duration was never measured.
     *
     * For the retry price. A retry re-runs the scene exactly as it stands,
     * so what it costs depends on these rows and not on whatever the prompt
     * currently @tags — those two come apart the moment the operator edits
     * the prompt without pressing Generate.
     */
    videoInputSecondsS: (number | null)[];
    /**
     * This scene's saved References box — the non-null `tag` values off its
     * scene_references rows, kind then ordinal. Seeds ugc-column.tsx's box;
     * see that prop's own comment for why it only SEEDS rather than defines
     * the box forever.
     */
    referenceTags: string[];
    /** Gemini preset voice from the override; mergeRenderSettings drops it. */
    voice: string | null;
    /** aspect_ratio from the override, same reason as voice. */
    aspectRatio: string | null;
    /** quality from the override (lib/video-quality.ts), same reason as voice. */
    quality: VideoQuality | null;
  } | null = null;

  {
    const { data: sceneRows } = await supabase
      .from("scenes")
      .select(
        "id, idx, duration_s, status, video_prompt, active_version_id, render_settings_override, is_talking_head, script_line, ref_frame_asset_id",
      )
      .eq("project_id", project.id)
      .order("idx", { ascending: false })
      .limit(40);

    const rows = sceneRows ?? [];
    const sceneIds = rows.map((r) => r.id);

    // Three reads, one per scene id list: every version of every scene
    // (for the count AND for "which clip does each scene's ACTIVE version
    // deliver" via activeClipIdByScene — the same helper the worker's own
    // SceneClipsForProject mirrors, so this strip can't disagree with what
    // ffmpeg would actually assemble), every clip asset any of them
    // produced (its storage_key is what a download link and a filename are
    // built from), and what every one of them has actually been BILLED
    // (runs.cost_usd — never a live re-price, same rule "Show the clip what
    // it was billed" already enforces on the scripted pipeline's own scene
    // page).
    const [
      { data: versionRows },
      { data: clipAssetRows },
      { data: posterAssetRows },
      { data: sceneRunRows },
      { data: sceneReferenceRows },
    ] = await Promise.all([
      supabase
        .from("scene_versions")
        .select("id, n, created_at, clip_asset_id, scene_id")
        .in("scene_id", sceneIds),
      supabase
        .from("assets")
        .select("id, created_at, scene_id, storage_key")
        .eq("kind", "clip")
        .in("scene_id", sceneIds),
      // Newest first, so posterByScene below takes the most recent frame for
      // each scene with a single pass and no sort of its own.
      supabase
        .from("assets")
        .select("id, created_at, scene_id, storage_key")
        .eq("kind", "poster")
        .in("scene_id", sceneIds)
        .order("created_at", { ascending: false }),
      supabase.from("runs").select("scene_id, cost_usd").in("scene_id", sceneIds),
      // THE SCENE'S OWN VIDEO REFERENCES, for the retry price below. Not the
      // prompt's @tags — a retry re-runs the scene exactly as it stands, and
      // what it stands on is these rows (attachSceneReferences copies one
      // asset per tag at generate time, carrying the duration since #116).
      // Editing the prompt afterwards changes the tags and not these, which
      // is precisely why the retry control cannot be priced off the column.
      supabase.from("scene_references").select("scene_id, asset_id, kind").in("scene_id", sceneIds),
    ]);

    // Only live scene_references rows participate in a retry. Superseded
    // video_ref assets retain their scene_id for history, so reading assets
    // by scene_id would count stale uploads that the worker will not submit.
    const sceneVideoRefRows = (sceneReferenceRows ?? []).filter((row) => row.kind === "video");
    const scenesWithLiveReferences = new Set((sceneReferenceRows ?? []).map((row) => row.scene_id));
    const legacyVideoAssetIds = rows
      .filter((row) => !scenesWithLiveReferences.has(row.id) && row.ref_frame_asset_id)
      .map((row) => row.ref_frame_asset_id!);
    const sceneVideoAssetIds = [
      ...new Set([...(sceneVideoRefRows ?? []).map((row) => row.asset_id), ...legacyVideoAssetIds]),
    ];
    const { data: sceneVideoAssetRows } = sceneVideoAssetIds.length
      ? await supabase.from("assets").select("id, kind, duration_s").in("id", sceneVideoAssetIds)
      : { data: [] as { id: string; kind: string; duration_s: number | null }[] };
    const sceneVideoDurationByAsset = new Map(
      (sceneVideoAssetRows ?? [])
        .filter((row) => row.kind === "video_ref")
        .map((row) => [row.id, row.duration_s]),
    );

    // One entry per video reference the scene carries. A null duration stays
    // null: it means nobody measured the file, which is not zero, and the
    // retry price has to refuse rather than quote the clip alone.
    const videoSecondsByScene = new Map<string, (number | null)[]>();
    for (const row of sceneVideoRefRows ?? []) {
      if (!row.scene_id) continue;
      const list = videoSecondsByScene.get(row.scene_id) ?? [];
      list.push(sceneVideoDurationByAsset.get(row.asset_id) ?? null);
      videoSecondsByScene.set(row.scene_id, list);
    }
    // Match regenerateClip's legacy fallback: old scenes without live
    // scene_references may carry their source video in ref_frame_asset_id.
    for (const row of rows) {
      if (scenesWithLiveReferences.has(row.id) || !row.ref_frame_asset_id) continue;
      const asset = sceneVideoAssetRows?.find(
        (candidate) => candidate.id === row.ref_frame_asset_id,
      );
      if (asset?.kind === "video_ref") videoSecondsByScene.set(row.id, [asset.duration_s]);
    }

    const counts = new Map<string, number>();
    for (const row of versionRows ?? []) {
      counts.set(row.scene_id, (counts.get(row.scene_id) ?? 0) + 1);
    }

    const usdBilledByScene = new Map<string, number>();
    for (const row of sceneRunRows ?? []) {
      if (!row.scene_id || typeof row.cost_usd !== "number") continue;
      usdBilledByScene.set(row.scene_id, (usdBilledByScene.get(row.scene_id) ?? 0) + row.cost_usd);
    }

    const activeClipByScene = activeClipIdByScene(
      rows.map((r) => ({ id: r.id, active_version_id: r.active_version_id })),
      (versionRows ?? []) as (SceneVersionRow & { scene_id: string })[],
      (clipAssetRows ?? []) as (ClipAssetRow & { scene_id: string | null })[],
    );
    const clipAssetById = new Map((clipAssetRows ?? []).map((a) => [a.id, a]));

    // One poster per scene, newest first — the strip shows a scene's ACTIVE
    // clip, so the newest poster is the right frame for it in every case
    // except a scene whose current version was rolled back, which the rail
    // handles per-version with a tighter pairing.
    const posterByScene = new Map<string, string>();
    for (const asset of posterAssetRows ?? []) {
      if (asset.scene_id && !posterByScene.has(asset.scene_id)) {
        posterByScene.set(asset.scene_id, asset.storage_key);
      }
    }

    scenes = await Promise.all(
      rows.map(async (row) => {
        const clipAssetId = activeClipByScene.get(row.id) ?? null;
        const clipAsset = clipAssetId ? clipAssetById.get(clipAssetId) : undefined;
        const downloadUrl = clipAsset
          ? await signedUrl(clipAsset.storage_key, RESULT_SIGNED_URL_TTL_SECONDS)
          : null;
        const usdBilled = usdBilledByScene.get(row.id);
        return {
          id: row.id,
          idx: row.idx,
          duration_s: row.duration_s,
          status: row.status,
          versionCount: counts.get(row.id) ?? 1,
          downloadUrl,
          filename: clipAsset ? ugcClipFilename(row.idx, clipAsset.storage_key) : null,
          posterUrl: await (async () => {
            const key = posterByScene.get(row.id);
            return key ? await signedUrl(key, RESULT_SIGNED_URL_TTL_SECONDS) : null;
          })(),
          usdBilled: usdBilled ?? null,
        };
      }),
    );

    // TAKES. A scene regenerated before takes existed has several versions;
    // each is a tile of its own now, so the versions rail is gone and nothing
    // old is lost. A scene with one version stays the single tile it was.
    const clipVersionsByScene = new Map<
      string,
      { id: string; n: number; clip_asset_id: string }[]
    >();
    for (const v of versionRows ?? []) {
      if (!v.clip_asset_id) continue;
      clipVersionsByScene.set(v.scene_id, [
        ...(clipVersionsByScene.get(v.scene_id) ?? []),
        { id: v.id, n: v.n, clip_asset_id: v.clip_asset_id },
      ]);
    }
    for (const scene of scenes) {
      const own = [...(clipVersionsByScene.get(scene.id) ?? [])].sort((x, y) => x.n - y.n);
      if (own.length <= 1) {
        stripScenes.push(scene);
        continue;
      }
      const activeId = rows.find((r) => r.id === scene.id)?.active_version_id ?? null;
      for (const v of own) {
        const asset = clipAssetById.get(v.clip_asset_id);
        stripScenes.push({
          ...scene,
          versionId: v.id,
          take: v.n,
          isCurrentTake: v.id === activeId,
          status: "done",
          downloadUrl: asset
            ? await signedUrl(asset.storage_key, RESULT_SIGNED_URL_TTL_SECONDS)
            : null,
          filename: asset ? ugcVersionFilename(scene.idx, v.n, asset.storage_key) : null,
          // The poster is the scene's newest, so only its current take shows it.
          posterUrl: v.id === activeId ? scene.posterUrl : null,
        });
      }
      if (scene.status === "queued" || scene.status === "rendering") {
        stripScenes.push({ ...scene, downloadUrl: null, filename: null, posterUrl: null });
      }
    }

    // An unknown ?scene= resolves to no selection rather than to a default.
    // Silently falling back to "the newest" would leave the URL saying one
    // thing and the screen showing another, and Regenerate would then bill
    // against a scene nobody named.
    const match = sceneParam ? rows.find((r) => r.id === sceneParam) : undefined;
    if (match) {
      // THE BOX'S SEED, one cheap select scoped to this scene alone — not
      // the project-wide sceneIds batch above, because that batch exists to
      // price every scene in the strip at once and this only ever needs the
      // ONE scene that is actually selected. kind then ordinal so the seed
      // reads in the same order attachSceneReferences (actions/ugc.ts) wrote
      // it: the primary reference first, then the rest as they were tagged.
      const { data: referenceRows } = await supabase
        .from("scene_references")
        .select("tag, kind, ordinal")
        .eq("scene_id", match.id)
        .order("kind", { ascending: true })
        .order("ordinal", { ascending: true });
      const referenceTags = (referenceRows ?? [])
        .map((row) => row.tag)
        .filter((tag): tag is string => tag !== null);

      selected = {
        id: match.id,
        idx: match.idx,
        prompt: match.video_prompt ?? "",
        active_version_id: match.active_version_id,
        // What this scene will ACTUALLY render with. rerenderScene merges
        // project.render_settings with this override and prices from the
        // result — see actions/enqueue.ts — so a column showing anything else
        // is quoting a render that will not happen.
        settings: mergeRenderSettings(project.render_settings, match.render_settings_override),
        durationS: match.duration_s,
        isTalkingHead: match.is_talking_head,
        scriptLine: match.script_line,
        videoInputSecondsS: videoSecondsByScene.get(match.id) ?? [],
        referenceTags,
        voice:
          geminiVoiceFor(
            mergeRenderSettings(project.render_settings, match.render_settings_override).model,
            (match.render_settings_override as { voice?: unknown } | null)?.voice,
          ) ?? null,
        aspectRatio:
          videoAspectRatioFor(
            mergeRenderSettings(project.render_settings, match.render_settings_override).model,
            (match.render_settings_override as { aspect_ratio?: unknown } | null)?.aspect_ratio,
          ) ?? null,
        quality: videoQualityFor(
          (match.render_settings_override as { quality?: unknown } | null)?.quality,
        ),
      };
    }
  }

  if (selected) {
    const selectedScene = selected;
    const [{ data: versionRows }, { data: clipRows }, { data: posterRows }] = await Promise.all([
      supabase
        .from("scene_versions")
        .select("id, n, created_at, video_prompt, ref_frame_asset_id, clip_asset_id, duration_s")
        .eq("scene_id", selectedScene.id)
        .order("n", { ascending: true }),
      supabase
        .from("assets")
        .select("id, created_at, storage_key")
        .eq("scene_id", selectedScene.id)
        .eq("kind", "clip")
        .order("created_at", { ascending: true }),
      // Posters, so the rail can show the takes instead of grey rectangles.
      // ingest writes a clip and its poster in the same pass, so the two are
      // paired below by created_at proximity rather than by a foreign key —
      // there isn't one, and inventing an index-based pairing would go wrong
      // the first time a render produced one and not the other.
      supabase
        .from("assets")
        .select("id, created_at, storage_key")
        .eq("scene_id", selectedScene.id)
        .eq("kind", "poster")
        .order("created_at", { ascending: true }),
    ]);
    // buildSceneVersions, not a hand-rolled join: MarkDone never sets
    // clip_asset_id, so a version is paired with its clip by created_at
    // window, and that rule lives in exactly one place.
    const baseVersions = buildSceneVersions(versionRows ?? [], clipRows ?? []);
    const clipStorageKeyById = new Map((clipRows ?? []).map((c) => [c.id, c.storage_key]));
    const clipCreatedAtById = new Map((clipRows ?? []).map((c) => [c.id, c.created_at]));

    /**
     * The poster written alongside a given clip.
     *
     * Nearest created_at wins, with a one-minute ceiling. ingest saves both in
     * the same pass so the real gap is milliseconds; the ceiling is there so a
     * render that produced a clip and no poster gets nothing rather than
     * borrowing an unrelated attempt's frame — showing take 1's thumbnail on
     * take 3 would be worse than showing none, because it looks like an answer.
     */
    function posterKeyForClip(clipId: string | null): string | undefined {
      if (!clipId) return undefined;
      const clipAt = clipCreatedAtById.get(clipId);
      if (!clipAt) return undefined;
      const target = new Date(clipAt).getTime();

      let best: { key: string; gap: number } | undefined;
      for (const poster of posterRows ?? []) {
        const gap = Math.abs(new Date(poster.created_at).getTime() - target);
        if (!best || gap < best.gap) best = { key: poster.storage_key, gap };
      }
      return best && best.gap <= 60_000 ? best.key : undefined;
    }

    versions = await Promise.all(
      baseVersions.map(async (version) => {
        const storageKey = version.clipAssetId
          ? clipStorageKeyById.get(version.clipAssetId)
          : undefined;
        const downloadUrl = storageKey
          ? await signedUrl(storageKey, RESULT_SIGNED_URL_TTL_SECONDS)
          : null;
        const posterKey = posterKeyForClip(version.clipAssetId);
        return {
          ...version,
          downloadUrl,
          posterUrl: posterKey ? await signedUrl(posterKey, RESULT_SIGNED_URL_TTL_SECONDS) : null,
          filename: storageKey
            ? ugcVersionFilename(selectedScene.idx, version.n, storageKey)
            : null,
        };
      }),
    );
  }

  // Defaults to the current version, so opening a scene shows what that scene
  // IS before it shows any older attempt.
  const selectedVersionId =
    versionParam && versions.some((version) => version.id === versionParam)
      ? versionParam
      : (selected?.active_version_id ?? null);

  const shownVersion = versions.find((version) => version.id === selectedVersionId) ?? null;

  // The scene's effective settings, resolved once. rerenderScene merges
  // project.render_settings with the scene's override and prices from the
  // result, so these are what the pickers must show — see the selectedScene
  // prop below.
  // Why a clip failed, not just that it did.
  //
  // A failed render still costs money, and without a reason the only move
  // available is to press the button again — which costs again, and on a
  // prompt the vendor rejected costs the same way every time. classifyRender
  // Error also answers whether retrying could plausibly help at all
  // (`retryable`), which is the difference between "change something" and
  // "the vendor was briefly down".
  //
  // Same query and same helper as the scripted pipeline's Render page — that
  // surface has shown this since it existed; /ugc simply never inherited it.
  const { data: runsWithErrors, error: runsErrorsError } = await supabase
    .from("runs")
    .select("scene_id, error, created_at")
    .eq("project_id", project.id)
    .not("error", "is", null)
    .order("created_at", { ascending: false });

  if (runsErrorsError) {
    throw new Error(
      `Failed to load run errors for project ${project.id}: ${runsErrorsError.message}`,
    );
  }

  const errorsByScene = latestErrorsByScene(runsWithErrors ?? []);
  const selectedError = selected ? (errorsByScene.get(selected.id) ?? null) : null;

  // Whether anything on this screen is still moving. Drives the poll below;
  // 'queued' and 'rendering' are the only states that change without the
  // operator doing something.
  const inFlight = scenes.some(
    (scene) => scene.status === "queued" || scene.status === "rendering",
  );

  // Queued or rendering: the worker has it and the screen should say so.
  // Read off the scene rows rather than added to `selected`, which is built
  // before them.
  const selectedStatus = selected
    ? (scenes.find((scene) => scene.id === selected.id)?.status ?? null)
    : null;
  // What the result panel shows. Extracted to lib/result-panel.ts because the
  // ORDER of these questions was a bug — the scene's status used to be asked
  // before the shown version's clip, so an old take with a finished clip
  // rendered as a spinner while a newer attempt was in flight. That file's
  // tests are the guard; this page has none of its own.

  const panel = resultPanelState({
    hasClip: Boolean(shownVersion?.downloadUrl),
    hasVersion: Boolean(shownVersion),
    status: selectedStatus,
  });

  const selectedSettings = selected?.settings ?? null;
  const selectedModel = selectedSettings ? getModel(selectedSettings.model) : null;
  const selectedModelId = selectedModel?.id ?? null;

  // This operator's own @tag library (0065_elements.sql) — the reference
  // picker's Elements tab and the prompt editor's @tag resolution both read
  // this same list, so a tag that resolves in the hover preview is
  // guaranteed to be one the picker could also have offered. Filtered by
  // user_id explicitly rather than trusting RLS alone — belt-and-suspenders
  // the same way requireProjectReadable's isOwner check is, even though
  // elements_select's `using (user_id = auth.uid() or is_admin())` should
  // already narrow this to the same set for a non-admin viewing their own
  // page.
  const elements: ElementTag[] = [];
  {
    const { data: elementRows } = await supabase
      .from("elements")
      // ai_description rides along for lib/ugc-prompt-preview.ts — see
      // ElementTag.aiDescription's own doc comment (lib/elements.ts) for why
      // leaving it out would make the prompt preview under-substitute.
      .select("id, name, description, ai_description, category, asset_id")
      .is("deleted_at", null)
      // THE PROJECT OWNER'S library, not the viewer's. A prompt is written
      // in its author's tags, so scoping this to the viewer would make every
      // @tag in an admin's read-only view resolve to nothing: the highlight
      // would read as a typo and the hover preview would be empty, on a
      // prompt that is perfectly correct for the person who wrote it. That is
      // worse than a 404 — it looks like it works and tells the wrong story.
      //
      // elements_select is `(user_id = auth.uid() or is_admin())`, so the
      // session client can make this read for an admin and refuses it for
      // anyone else; no admin client is needed and none is used.
      .eq("user_id", project.user_id)
      // NEWEST FIRST, AND NOTHING BEFORE THAT. This used to sort by category
      // first, which was harmless while the values were character / location
      // / product / voice: 'voice' sorted last, so pictures filled the @ menu
      // and nobody noticed the sort was there.
      //
      // 0081 renamed voice to audio. 'audio' sorts FIRST, and the menu shows
      // the first 8 matches (matchElementsByPrefix), so twelve voice clips
      // pushed every picture out of it — a library that still held them,
      // offering none. A rename with no code change to its name reordered a
      // menu.
      //
      // Recency is what the menu is for anyway: an operator typing @ means
      // the reference they just added far more often than the one that sorts
      // first alphabetically by a label they cannot see.
      .order("created_at", { ascending: false });

    const assetIds = (elementRows ?? []).map((row) => row.asset_id);
    const { data: elementAssetRows } =
      assetIds.length > 0
        ? await supabase
            .from("assets")
            .select("id, storage_key, kind, duration_s, deleted_at")
            .in("id", assetIds)
        : { data: [] };
    const assetByIdForElements = new Map((elementAssetRows ?? []).map((a) => [a.id, a]));

    // Sequential, not Promise.all: an operator's own saved-reference list is
    // small (this is a personal library, not a project's asset table), and
    // signedUrl's own memoization means a repeat render of this page in the
    // same process pays for at most one createSignedUrl call per element
    // either way.
    for (const row of elementRows ?? []) {
      const asset = assetByIdForElements.get(row.asset_id);
      // Should not happen (asset_id references assets(id) not null, and
      // elements cascades on that FK's delete) — degrades to "leave it out
      // of the picker" rather than breaking the whole page over one row
      // whose source image is somehow gone.
      if (!asset) continue;
      // Same as lib/element-library.ts: an image in Bin takes its element along.
      if (asset.deleted_at) continue;
      // AN ALLOWLIST, NOT "anything that is not audio". This read
      // `asset.kind === "audio"` and the transform below took the else
      // branch, which was correct only for as long as audio was the one
      // thing a picture could be instead of. 0093 added a third kind and
      // an uploaded MP4 landed in the picture branch, so the panel asked
      // Supabase to resize a video and the whole page threw:
      //
      //   signedUrl: a transform was requested for "....mp4", which this
      //   file does not recognize as an image
      //
      // Observed in production 2026-09-09 23:18 on the first real video
      // ever uploaded — the upload, the describe and the $0.0002 charge
      // all succeeded, and the operator still saw nothing but an error.
      // This is the same denylist actions/ugc.ts had to be corrected out
      // of twice already (firstTaggedImageElementId, attachSceneReferences);
      // this was the third site and the only one nobody had found yet.
      const isImageAsset = IMAGE_ASSET_KINDS.has(asset.kind);
      elements.push({
        id: row.id,
        name: row.name,
        category: row.category,
        description: row.description,
        aiDescription: row.ai_description,
        assetKind: asset.kind,
        // Only a video's is billed, and only the column reads it — see
        // ElementTag.durationS. Carried for every kind rather than gated on
        // video_ref: the gate would be a fourth place that has to know which
        // kinds exist, and this file has already paid for three of those.
        durationS: asset.duration_s,
        // Only meaningful for a picture — see ElementTag.imageExt's own
        // comment for why the Kling frame slots need it. Computed for every
        // kind anyway (cheap, one regex over a string already in hand)
        // rather than gating on isImageAsset, the same "don't add a fourth
        // place that has to know which kinds exist" reasoning this file's
        // own isImageAsset comment gives just above.
        imageExt: extFromFilename(asset.storage_key, ""),
        previewUrl: await signedUrl(
          asset.storage_key,
          RESULT_SIGNED_URL_TTL_SECONDS,
          // NO TRANSFORM ON ANYTHING BUT A PICTURE. The thumbnail transform
          // routes the URL through Supabase's image renderer, which decodes
          // what it is given; handed an MP3 or an MP4 it does not return a
          // smaller one, it fails. The file would then be unplayable in the
          // panel AND unfetchable by kie, for a resize nobody asked for.
          isImageAsset ? ELEMENT_THUMBNAIL_TRANSFORM : undefined,
        ),
      });
    }
    // Auto-filed generated images after the operator's own references — see
    // lib/element-library.ts for why. Stable.
    elements.sort(
      (a, b) =>
        Number(a.assetKind === "generated_image") - Number(b.assetKind === "generated_image"),
    );
  }

  // "Recently deleted" — this project's own trash (0088_deleted_scenes.sql).
  // Scoped to project_id like every other query on this page; no separate
  // owner filter is needed because deleted_scenes_select's RLS
  // (`user_id = auth.uid() or is_admin()`) already narrows this the same way
  // elements_select above does, and requireProjectReadable has already
  // proven the caller is either that owner or an admin. A row a PROJECT-level
  // cascade delete wrote (user_id snapshotted NULL, per 0088's header) can
  // never appear here regardless: this project is still live enough to be
  // rendering this page, so it was never the one being deleted.
  const deletedScenes: UgcDeletedScene[] = [];
  {
    // `hard_deleted_at is null` (0092) is what keeps this list and /bin
    // telling the same story. Purging from /bin does not delete the archive
    // row — it only marks it — so without this filter a purged scene keeps
    // its place here, wearing a Restore button that can only ever fail,
    // because restoreScene's claim filters on the same column.
    const { data: deletedRows } = await supabase
      .from("deleted_scenes")
      .select("scene_id, scene_idx, deleted_at, scene")
      .eq("project_id", project.id)
      .is("hard_deleted_at", null)
      .gte("deleted_at", binRetentionCutoffIso())
      .order("deleted_at", { ascending: false });

    for (const row of deletedRows ?? []) {
      const archivedScene = row.scene as { video_prompt?: string | null } | null;
      deletedScenes.push({
        sceneId: row.scene_id,
        idx: row.scene_idx,
        promptFirstLine: firstLine(archivedScene?.video_prompt),
        deletedAtLabel: dateTimeFormatter.format(new Date(row.deleted_at)),
      });
    }
  }

  return (
    // The app shell's top bar is h-16, so the console takes the viewport minus
    // those 4rem. Together with overflow-hidden this keeps the PAGE from
    // scrolling. Everything that can overflow scrolls inside its own box
    // instead — the version rail vertically, the scene strip sideways — which
    // keeps the Generate button in place no matter how many clips exist.
    //
    // svh, not vh: on mobile Safari `vh` is the height with the browser chrome
    // RETRACTED, so a 100vh box is taller than the visible area until you
    // scroll. svh is the smallest state, which is the only one that is always
    // on screen.
    <div
      data-project-shell
      // Scrolls now: the prompt bar floats over the bottom as a sticky dock.
      className="flex min-h-[calc(100svh-4rem)] flex-col gap-4 px-6 pt-6"
    >
      <UgcLiveRefresh inFlight={inFlight} />

      {/* NO BACK LINK. There was one — "← Studio", above the title — and it
          is gone because the sidebar already carries Projects as an icon on
          every project screen (components/sidebar-shell.tsx keeps the rail
          visible at md:w-16 here, deliberately, so the top-level destinations
          stay one click away). Two ways back is one more than the screen has
          room to explain, and this one cost a line above the title on a page
          whose whole layout is a fight for vertical space.

          The scripted pipeline's project rail still has its own — that route
          has no equivalent and project-rail.test.tsx pins it. */}

      {ownerLabel !== null ? (
        // The muted informational treatment, matching the scripted
        // pipeline's own read-only banner. Red is reserved in this codebase
        // for "something here may be fake or incomplete", not for "you are
        // allowed to be here, but only to look".
        <p
          role="status"
          className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-foreground"
        >
          You&apos;re viewing {ownerLabel}&apos;s project in read-only mode. As an admin you can
          look, but you cannot generate, rename or delete anything here.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            // Back to the Create wall, where every clip project is previewed.
            href="/create?tab=video"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-muted/60 px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            Projects
          </Link>
          <UgcTitle projectId={project.id} title={project.title} readOnly={!isOwner} />
          {selected ? (
            <span className="text-sm text-muted-foreground">· scene {selected.idx}</span>
          ) : null}
        </div>
        <CreateModeSwitch
          video
          imageHref={`${videoHref}${sceneParam ? "&" : "?"}tab=image`}
          videoHref={videoHref}
        />
      </div>

      <CreateModeContent video projectVideo>
        {/* Scenes | result | versions: the result takes the middle and the
            full height, which it needs for a 9:16 clip. */}
        {/* Down to the bottom of the screen, under the floating bar: -mt-48 on
            the dock below lets it overlap this row, and every scroller in the
            row (scenes, versions) plus the result gets pb-48 so its last item
            can scroll clear of the bar. */}
        <div className="flex min-h-[26rem] flex-col gap-4 xl:h-[calc(100svh-8.5rem)] xl:flex-row xl:items-stretch xl:[&_.overflow-y-auto]:pb-48">
          <UgcSceneStrip
            vertical
            projectId={project.id}
            scenes={stripScenes}
            selectedSceneId={selected?.id ?? null}
            selectedVersionId={selectedVersionId}
            readOnly={!isOwner}
          />
          {/* A FIXED height, not a minimum: the rail beside it scrolls, and if
            either grew with its content the two would disagree and the canvas
            would jump every time a scene with more versions was selected. */}
          {/* Dashed ONLY while there is nothing to show.
            A dashed border reads as "empty, put something here" — which is
            right for the waiting state and wrong for the finished clip, and
            this panel used it for both. The most important thing on the screen
            was framed like a drop zone. */}
          <div
            className={`flex min-h-0 flex-1 flex-col rounded-lg border ${
              shownVersion?.downloadUrl ? "bg-card" : "border-dashed"
            }`}
          >
            <div className="flex items-center justify-between gap-2 rounded-t-[7px] border-b bg-muted/60 px-3 py-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                {shownVersion
                  ? `Result — scene ${selected?.idx}` +
                    (selected && versions.length > 1 ? ` · v${shownVersion.n}` : "")
                  : "Result — the clip lands here"}
              </p>
              {selected && isOwner ? (
                // Another take, not a replacement: refills the bar below.
                <IterateButton
                  detail={{
                    prompt: shownVersion?.videoPrompt ?? selected.prompt,
                    referenceTags: selected.referenceTags,
                    modelId: selectedModelId,
                    resolution: selectedSettings?.resolution ?? null,
                    durationS: shownVersion?.durationS ?? selected.durationS,
                  }}
                />
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 xl:pb-48">
              {/* THE SHOWN VERSION DECIDES, not the scene's status.
                These were the other way round, so while v2 was in flight the
                panel showed a spinner for every version — including v1, which
                had a finished clip sitting right there in the rail. Pressing
                "Make current" on v1 to get back to a good take put the
                operator on a page that said "Rendering" about a clip that
                rendered ten minutes ago. A version that HAS a clip can always
                be played; the spinner belongs only to the version that is
                actually waiting on the worker. */}
              {panel.kind === "working" ? (
                /* A spinner, centred, for as long as the worker has it.
                 The canvas said "Attach an image, write a prompt, and press
                 Generate" while a render was in flight — instructions for a
                 thing the operator had already done, on the screen they were
                 watching to see whether it had worked. With the poll
                 refreshing every 10s this now moves on its own: queued ->
                 rendering -> the clip.

                 A spinner rather than dots or a swapped label, per the rule
                 this project already follows for in-flight controls. */
                <div className="flex flex-1 flex-col items-center justify-center gap-3">
                  <Spinner className="size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {panel.queued
                      ? "Queued — waiting for a worker to pick this up."
                      : "Rendering. This takes a minute or two."}
                  </p>
                </div>
              ) : panel.kind === "clip" && shownVersion?.downloadUrl ? (
                <>
                  {/* The clip at full height, and its own poster blurred behind it
                    so a 9:16 take in a wide panel has no dead bars beside it. */}
                  <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-black">
                    {shownVersion.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed URL
                      <img
                        src={shownVersion.posterUrl}
                        alt=""
                        aria-hidden="true"
                        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-2xl"
                      />
                    ) : null}
                    <video
                      controls
                      preload="metadata"
                      poster={shownVersion.posterUrl ?? undefined}
                      className="relative h-full max-h-full w-auto max-w-full"
                      src={shownVersion.downloadUrl}
                    >
                      Your browser does not support inline video playback.
                    </video>
                    {/* asAttachment, because `download` alone is ignored on a
                    cross-origin href and every signed URL here is one. */}
                    <a
                      href={asAttachment(shownVersion.downloadUrl, shownVersion.filename)}
                      download={shownVersion.filename ?? undefined}
                      className="absolute right-3 top-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-background/80 px-3 text-sm font-medium text-foreground backdrop-blur transition-colors hover:bg-background"
                    >
                      <DownloadIcon aria-hidden="true" className="size-3.5" />
                      Download
                    </a>
                  </div>
                  {/* Watching an older take while a new one renders is the whole
                    reason the branch above yields — but the render must not go
                    silent for it. The poll refreshes every 10s, so this clears
                    itself. */}
                  {panel.kind === "clip" && panel.renderInFlight ? (
                    <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                      <Spinner className="size-3" />
                      {panel.queued
                        ? "A newer attempt is queued."
                        : "A newer attempt is rendering."}
                    </p>
                  ) : null}
                </>
              ) : shownVersion && selectedError ? (
                // A failed render has already been billed, so "it failed" on its
                // own leaves the operator with one move to make next.
                // classifyRenderError's `retryable` is the part worth reading
                // before spending: it separates "the vendor was briefly down"
                // from "this will not work as written".
                //
                // The message is scoped to the SCENE, not to this version:
                // latestErrorsByScene keeps the newest error per scene_id, so
                // with several failed attempts this is the most recent one. Said
                // in the copy rather than implied, because attributing v3's
                // failure to v1 would be its own small lie.
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                  <p className="text-sm font-medium text-destructive">
                    This attempt produced no clip.
                  </p>
                  {/* The classifier's own message, and nothing paraphrasing it.
                    A second line reading "Worth another try — this looks like
                    a passing failure" sat under one that already said
                    "Retrying may work", and the same duplication existed on
                    the other branch: every message classifyRenderError
                    produces already carries its own retry advice. Two
                    sentences saying one thing read as two findings. */}
                  <p className="max-w-sm text-sm text-foreground">{selectedError.message}</p>

                  {/* NO "TRY AGAIN" HERE ANY MORE. It used to be its own
                    confirm dialog, wired to retryClip -> retryScene, which
                    re-ran the scene's SAVED settings — the prompt, the
                    frames, the model as they stood the moment the render was
                    queued, not whatever the operator had since changed in the
                    column. Editors read that as their new Kling frames being
                    ignored, because they were: pressing Try again after
                    swapping the Start frame billed and re-rendered the OLD
                    one.

                    Regenerate (in the column, to the left) is the one requeue
                    control this route has now, for a failed scene exactly as
                    for a done one — it always re-prices and re-submits
                    whatever is on screen at the moment of the press. This is
                    just a pointer to it, not a second control. */}
                  <p className="text-xs text-muted-foreground">
                    Press Iterate to try it again from this prompt.
                  </p>

                  <p className="text-[11px] text-muted-foreground">
                    Most recent failure on this scene.
                  </p>
                </div>
              ) : (
                // Centred like the spinner beside it. Pinned to the top-left of
                // a box this tall, one short sentence read as leftover text
                // rather than as the state of the panel.
                <p className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                  {shownVersion
                    ? "This attempt produced no clip."
                    : "Write a prompt in the bar below and press Generate."}
                </p>
              )}
            </div>
          </div>
        </div>

        <UgcDeletedScenes scenes={deletedScenes} readOnly={!isOwner} />

        {/* THE PROMPT BAR, along the bottom like /create's. It used to be the
          left column of the row above; the result and version rail get that
          width back, and the composer reads the same on both screens. */}
        {/* Sticky, like the image console's dock: <main> scrolls, the bar
          floats over the bottom with a fade so the content reads under it. */}
        <div className="pointer-events-none sticky bottom-0 z-30 -mx-6 mt-auto bg-gradient-to-t xl:-mt-48 from-background via-background/90 to-transparent px-6 pb-4 pt-8 has-[[data-moved=true]]:bg-none">
          <div className="mx-auto w-full max-w-5xl">
            <ResizablePromptBar storageKey="video" defaultPx={80}>
              <UgcColumn
                layout="bar"
                projectId={project.id}
                options={options}
                budget={budget}
                readOnly={!isOwner}
                // kie is the only vendor now — resolveVendor (lib/vendor-routing.ts)
                // was decommissioned along with fal.
                vendor="kie"
                // Same flag `options` above was already built from (`withSound`) —
                // read once and passed down rather than re-imported into a client
                // component, and reused rather than re-derived so the picker and
                // the prompt preview cannot answer "will this clip have audio"
                // differently.
                audioEnabled={withSound}
                // ALWAYS A NEW SCENE. The bar used to follow the selected scene and
                // turn Generate into Regenerate (a new VERSION of it); takes
                // replaced versions, so Generate makes another clip and Iterate
                // (in the result header) is what refills the bar from one.
                selectedScene={null}
                elements={elements}
              />
            </ResizablePromptBar>
          </div>
        </div>
      </CreateModeContent>
    </div>
  );
}
