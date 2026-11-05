"use server";

// Step 9 — Deliver (docs/architecture.md § "User flow"). Assembly into a
// single mp4 is the Go worker's `loop.Assemble` job, gated behind its own
// ASSEMBLE_ENABLED (see lib/models.ts's isAssembleEnabled, which mirrors it
// web-side) — this file never touches ffmpeg itself, only reads whatever
// `clip`/`final` assets already exist and signs URLs to them, plus (via
// hasFinalAsset) polls for a final version's file arriving so the Deliver
// page's "assembling…" placeholder can resolve itself without a manual
// reload.
//
// Since 0060_final_versions.sql, asking for an assemble is an INSERT into
// final_versions rather than a delete of the previous `final` asset, and
// every read of "the assembled video" resolves through
// projects.active_final_version_id rather than `assets.find(kind ===
// 'final')`. See reassembleProject below for what that replaced and why.

import { revalidatePath } from "next/cache";
import { requireProject, requireProjectReadable } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isDev } from "@/lib/mode";
import { signedUrl } from "@/lib/storage";
import {
  buildManifest,
  filenameForClip,
  type Manifest,
  type ManifestSceneInput,
} from "@/lib/manifest";
import { persistOrder } from "@/actions/brief";
import { isEditable, isSceneInFlight } from "@/lib/editable-guard";
import type { ActionResult } from "@/lib/action-result";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

type AssetRow = Database["public"]["Tables"]["assets"]["Row"];

// Editors download from this manifest over the course of an editing
// session, not in one click — give it more headroom than the default 1h
// signed-URL TTL used elsewhere.
const MANIFEST_SIGNED_URL_TTL_SECONDS = 3600;

function deliverPath(projectId: string): string {
  return `/projects/${projectId}/deliver`;
}

function briefPath(projectId: string): string {
  return `/projects/${projectId}/brief`;
}

/**
 * Builds the JSON manifest an editor imports alongside the downloaded
 * clips so they know the intended order and what each shot is
 * (docs/architecture.md § "User flow" step 9). Guarded by requireProject
 * like every other action here — the query/sign work below only runs once
 * that passes.
 */
export async function getManifest(projectId: string): Promise<Manifest> {
  const { project } = await requireProject(projectId);
  const supabase = await createClient();

  const { data: scenes, error: scenesError } = await supabase
    .from("scenes")
    .select("*")
    .eq("project_id", projectId)
    .order("idx", { ascending: true });

  if (scenesError) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${scenesError.message}`);
  }

  const { data: clipAssets, error: assetsError } = await supabase
    .from("assets")
    .select("*")
    .eq("project_id", projectId)
    .eq("kind", "clip");

  if (assetsError) {
    throw new Error(`Failed to load clip assets for project ${projectId}: ${assetsError.message}`);
  }

  const clipByScene = new Map<string, AssetRow>();
  for (const asset of clipAssets ?? []) {
    if (asset.scene_id) {
      clipByScene.set(asset.scene_id, asset);
    }
  }

  const scenesWithClips = (scenes ?? []).filter((scene) => clipByScene.has(scene.id));

  const manifestScenes: ManifestSceneInput[] = await Promise.all(
    scenesWithClips.map(async (scene): Promise<ManifestSceneInput> => {
      const asset = clipByScene.get(scene.id) as AssetRow;
      // No transform here: `asset` is a `clip` (mp4), not an image.
      // Supabase's image-transform endpoint doesn't serve video — passing a
      // transform for this key would break the download outright, not just
      // degrade it.
      const url = await signedUrl(asset.storage_key, MANIFEST_SIGNED_URL_TTL_SECONDS);
      return {
        idx: scene.idx,
        script_line: scene.script_line,
        video_prompt: scene.video_prompt,
        is_talking_head: scene.is_talking_head,
        duration_s: scene.duration_s,
        filename: filenameForClip(scene.idx, asset.storage_key),
        signed_url: url,
      };
    }),
  );

  return buildManifest({
    projectTitle: project.title,
    characterDescription: project.character_desc,
    scenes: manifestScenes,
  });
}

/**
 * Whether the project's ACTIVE final version has a playable file yet.
 * Polled by components/assembling-status.tsx: `assets` is not in the
 * supabase_realtime publication (only `scenes` is — see
 * supabase/migrations/0006_realtime.sql), so unlike render-progress.tsx's
 * Realtime subscription, the Deliver page's "assembling…" placeholder has
 * no push channel to wait on and falls back to this bounded poll instead.
 *
 * Resolved through projects.active_final_version_id (0060_final_versions.sql),
 * not `assets.kind = 'final'`. Old finals are kept now, so "does a final
 * asset exist for this project" no longer answers the question this poll is
 * actually asking — a project can hold three finals and still be mid-build
 * on the one the operator is looking at. Asking the active version instead
 * is what stops the placeholder resolving itself against a previous cut.
 */
export async function hasFinalAsset(projectId: string): Promise<boolean> {
  const { project } = await requireProject(projectId);
  // Truthy, not `!== null`: this is also the guard that keeps a null out of
  // `.eq("id", …)`, where Postgres would reject it as a uuid rather than
  // returning nothing.
  const versionId = project.active_final_version_id;
  if (!versionId) {
    // No version at all: nothing has been requested, so nothing is coming.
    return false;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("final_versions")
    .select("final_asset_id")
    .eq("id", versionId)
    .limit(1);

  if (error) {
    throw new Error(
      `Failed to check the active final version for project ${projectId}: ${error.message}`,
    );
  }
  return (data?.[0]?.final_asset_id ?? null) !== null;
}

/**
 * One entry of a final version's recipe (0060_final_versions.sql): which
 * scene, and which of that scene's versions (0058) it contributed. Written
 * when a build is REQUESTED, so it records what the operator asked for
 * rather than what the scenes happen to say later.
 *
 * scene_version_id is null for a scene whose active version predates 0058's
 * backfill — "this scene, version unknown" is truer than a guess.
 */
export interface FinalRecipeEntry {
  scene_id: string;
  scene_version_id: string | null;
}

/**
 * The recipe the CURRENT scenes would produce: every scene in `idx` order,
 * each paired with its active version. Shared by reassembleProject (which
 * records it) and getCutStatus (which compares against it) so the two can
 * never disagree about what "the cut as it stands now" means.
 */
async function currentRecipe(
  client: { from: SupabaseClient<Database>["from"] },
  projectId: string,
): Promise<FinalRecipeEntry[]> {
  const { data, error } = await client
    .from("scenes")
    .select("id, active_version_id")
    .eq("project_id", projectId)
    .order("idx", { ascending: true });

  if (error) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${error.message}`);
  }

  return (data ?? []).map((scene) => ({
    scene_id: scene.id,
    scene_version_id: scene.active_version_id,
  }));
}

/** Two recipes are the same cut iff they name the same scenes, in the same
 * order, at the same versions. Compared as a string rather than field by
 * field because every difference matters equally — a reorder, a swapped
 * version and a deleted scene are all "this is not that cut". */
function sameRecipe(a: readonly FinalRecipeEntry[], b: readonly FinalRecipeEntry[]): boolean {
  const key = (entries: readonly FinalRecipeEntry[]): string =>
    entries.map((entry) => `${entry.scene_id}:${entry.scene_version_id ?? ""}`).join("|");
  return key(a) === key(b);
}

/** Narrows the jsonb column, which arrives as `unknown`. A malformed recipe
 * reads as an empty one rather than throwing: a staleness signal is not
 * worth taking the Deliver page down over. */
function parseRecipe(value: unknown): FinalRecipeEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): FinalRecipeEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.scene_id !== "string") return [];
    return [
      {
        scene_id: record.scene_id,
        scene_version_id:
          typeof record.scene_version_id === "string" ? record.scene_version_id : null,
      },
    ];
  });
}

/**
 * Discriminated result for "is this project's assembled video (if any) the
 * one the CURRENT scenes would produce" — the read getCutStatus below
 * exposes to the Deliver page. Three, and only three, states:
 *
 *   - `no_final`: the project's active final version has no file. Either
 *     nothing has been assembled yet, or the version is still building, or
 *     its file was pruned and only the recipe survives. The Deliver page
 *     tells those apart itself (it loads the version rows for its picker);
 *     this read only cares whether there is a cut to compare.
 *   - `current`: there is a built file and it is the cut today's scenes
 *     would produce.
 *   - `stale`: there is a built file and it is NOT that cut, for one of two
 *     reasons the UI has to be able to say out loud:
 *       - `"order"`: `reorderCut`/`reorderScenes` rewrote the cut order
 *         AFTER the worker read the clips for this build
 *         (0039_cut_order.sql, 0042_final_built_from_cut_order.sql).
 *       - `"recipe"`: the scenes themselves moved on — a scene was
 *         re-rendered onto a new version, switched to a different one, added
 *         or deleted — so the recipe this version recorded no longer
 *         describes the project. This is the branch that replaced
 *         deleteStaleFinalAssets (actions/enqueue.ts): a re-render used to
 *         DELETE the final so a stale cut could not be served, which under
 *         versioning would destroy a true record of something that really
 *         was built. Saying "stale" is the honest equivalent of deleting it,
 *         and unlike deletion it is reversible by doing nothing.
 *
 * `finalCreatedAt` is always present on `stale`; `cutOrderUpdatedAt` is null
 * on the `"recipe"` branch, where no reorder is what went wrong. Plain ISO
 * strings, matching every other timestamp this codebase hands to the client.
 */
export type CutStatus =
  | { state: "no_final" }
  | { state: "current" }
  | {
      state: "stale";
      reason: "order" | "recipe";
      finalCreatedAt: string;
      cutOrderUpdatedAt: string | null;
    };

/**
 * Tells the Deliver page whether the project's active final version still
 * matches the current cut — see CutStatus above for what each state means.
 *
 * Resolved through projects.active_final_version_id → its `final_asset_id`
 * (0060_final_versions.sql), NOT `assets.find(kind === 'final')`. Two `final`
 * rows on one project has never been forbidden by a constraint, so the old
 * lookup picked its winner by whatever the query returned first — and now
 * that finals are kept rather than deleted, more than one is the normal case
 * rather than the anomaly. The active version is the only non-arbitrary
 * answer to "which cut is this page about".
 *
 * The `"order"` comparison is unchanged: the project's CURRENT
 * cut_order_updated_at against the final asset's built_from_cut_order_at
 * (0042_final_built_from_cut_order.sql) — the cut order the worker actually
 * read alongside the clips — NOT the final's created_at. created_at only
 * answers "when was this file written", which is wrong when a SECOND reorder
 * lands while assembly is already running: that reorder's timestamp can land
 * before the file finishes writing even though the clips it was built from
 * predate it. See 0042's header for the full race, and 0043's for the
 * production incident (project 647739b6-f3ec-4910-96ce-bd9f1114a4ce) that
 * removed the second null special-case.
 *
 * The one surviving null case:
 *   - finalAsset.built_from_cut_order_at === null: this final predates
 *     0042 entirely and was never stamped — unknown, not "no reorder yet".
 *     It skips the `"order"` branch (not the `"recipe"` one, which needs no
 *     timestamp at all). Do not read a null here as "never reordered" going
 *     forward, only as "written before 0042".
 *
 * project.cut_order_updated_at === null needs no special case: null compares
 * less than any real timestamp, so a project that has never been reordered
 * can never be newer than what the final was built from.
 *
 * Guarded by requireProjectReadable, not requireProject like the form
 * actions here. This one runs DURING the Deliver page's render, inside that
 * page's own Promise.all next to requireProjectReadable itself. With the
 * strict guard, an admin who doesn't own the project passed the page's own
 * check and was then notFound()'d six lines later by this one, mid-render,
 * out of a page they had just been let into — which is exactly how it
 * reached production: both guards were right, and nothing tested the seam
 * between them. Safe because this function mutates nothing and reads through
 * createClient(), the caller's own RLS-scoped session client, so the
 * database still enforces access independently.
 */
export async function getCutStatus(projectId: string): Promise<CutStatus> {
  const { project } = await requireProjectReadable(projectId);
  const versionId = project.active_final_version_id;
  if (!versionId) {
    return { state: "no_final" };
  }

  const supabase = await createClient();

  const { data: versions, error: versionError } = await supabase
    .from("final_versions")
    .select("final_asset_id, recipe")
    .eq("id", versionId)
    .limit(1);

  if (versionError) {
    throw new Error(
      `Failed to load the active final version for project ${projectId}: ${versionError.message}`,
    );
  }

  const version = versions?.[0];
  // No file means there is no cut to be stale: it is either still building
  // or pruned to its recipe, both of which the page reports on their own
  // terms rather than as staleness.
  if (!version || version.final_asset_id === null) {
    return { state: "no_final" };
  }

  const { data: finalAssets, error } = await supabase
    .from("assets")
    .select("created_at, built_from_cut_order_at")
    .eq("id", version.final_asset_id)
    .limit(1);

  if (error) {
    throw new Error(`Failed to check final asset for project ${projectId}: ${error.message}`);
  }

  const finalAsset = finalAssets?.[0];
  if (!finalAsset) {
    // The row points at an asset that is gone — `on delete set null` should
    // have cleared it, so this is a torn read, not a state to report.
    return { state: "no_final" };
  }

  if (
    finalAsset.built_from_cut_order_at !== null &&
    project.cut_order_updated_at !== null &&
    new Date(project.cut_order_updated_at).getTime() >
      new Date(finalAsset.built_from_cut_order_at).getTime()
  ) {
    return {
      state: "stale",
      reason: "order",
      finalCreatedAt: finalAsset.created_at,
      cutOrderUpdatedAt: project.cut_order_updated_at,
    };
  }

  // The branch that replaced deleting the final on every re-render. A
  // scene re-render moves that scene onto a new version and touches nothing
  // this project-level comparison used to look at, so without this a
  // re-rendered project would read "current" while serving the cut built
  // from the clip that was just superseded.
  if (!sameRecipe(parseRecipe(version.recipe), await currentRecipe(supabase, projectId))) {
    return {
      state: "stale",
      reason: "recipe",
      finalCreatedAt: finalAsset.created_at,
      cutOrderUpdatedAt: null,
    };
  }

  return { state: "current" };
}

/**
 * Asks the worker to assemble the project, by INSERTING a final version
 * rather than destroying the previous one (0060_final_versions.sql).
 *
 * This function used to delete the project's `final` and `poster` asset rows
 * and their Storage objects. That was not sloppiness — it was the trigger:
 * the worker's ProjectsReadyToAssemble asked "does a `final` asset NOT exist
 * for this project", so destroying the last cut was the only way to ask for
 * the next one. There was no v1 to go back to, and a fixed storage key meant
 * even a kept row would have been overwritten by the next build — data loss
 * wearing the shape of success. `built_at is null` is the request now, so
 * asking for a build costs nothing that already exists.
 *
 * The row carries the RECIPE: the project's scenes in `idx` order, each with
 * the scene version it currently contributes. Recorded at request time, not
 * build time, because it is the operator's instruction — and because it is
 * what getCutStatus above compares against to notice the cut has moved on.
 *
 * Refused once `project.status === 'delivered'` — the same commitment-point
 * lock as reorderScenes (web/actions/brief.ts): re-assembling would replace
 * the exact video that was handed to the client without an explicit reopen.
 *
 * No longer a no-op when the project has no final yet: with the absence of a
 * row as the trigger gone, a project that has never been assembled needs
 * this insert or nothing will ever build it.
 */
export async function reassembleProject(
  projectId: string,
  /**
   * "new" opens another version and leaves the current cut playable
   * alongside it; "update" rebuilds the ACTIVE version in place, replacing
   * the file it points at. Defaults to "new" — the non-destructive one, so
   * a caller that says nothing cannot lose a cut. Same choice, same wording
   * and same default as rerenderScene's (actions/enqueue.ts): the operator
   * is asked, because neither answer is right by default.
   */
  versionMode: "new" | "update" = "new",
): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return {
      error:
        "This project has already been delivered — reopen it (Deliver page) before " +
        "re-assembling the final video.",
    };
  }

  const admin = createAdminClient();
  const recipe = await currentRecipe(admin, projectId);

  if (recipe.length === 0) {
    return { error: "This project has no scenes yet — there is nothing to assemble." };
  }

  if (versionMode === "update" && project.active_final_version_id) {
    // Clearing built_at is what re-queues this row: the assemble loop claims
    // rows where built_at is null. final_asset_id/poster_asset_id go with it
    // because they are about to describe a file that no longer exists — the
    // same reason reuseSceneVersion (actions/enqueue.ts) refreshes its whole
    // snapshot rather than half of it. failed_at/failure_reason are cleared
    // too: a row that is being retried is not a row that gave up, and
    // leaving the reason behind would have the picker report a failure
    // against a build that is in flight.
    //
    // The recipe is RE-RECORDED from today's scenes, not preserved. "Update
    // this version" means the row moves to the current attempt; keeping the
    // old recipe would leave it claiming a cut the rebuild is not going to
    // produce.
    const { error } = await admin
      .from("final_versions")
      .update({
        recipe,
        built_at: null,
        failed_at: null,
        failure_reason: null,
        final_asset_id: null,
        poster_asset_id: null,
      })
      .eq("id", project.active_final_version_id)
      .eq("project_id", projectId);

    if (error) {
      throw new Error(
        `Failed to re-open final version ${project.active_final_version_id} for rebuild: ${error.message}`,
      );
    }

    revalidatePath(deliverPath(projectId));
    return undefined;
  }

  // "new", or "update" with nothing to update (a project that has never been
  // assembled). Opening a row is still the right answer there — refusing
  // would leave the operator's request with nowhere to go.
  //
  // `n` is deliberately NOT sent: the final_versions_assign_n trigger
  // (0060) assigns it inside the same statement. Computing it here would be
  // `select max(n) + 1` followed by an insert, and two assemble requests a
  // millisecond apart would read the same max and the second would fail on
  // `unique (project_id, n)` — a "could not assemble" nobody can reproduce.
  const { data: inserted, error: insertError } = await admin
    .from("final_versions")
    // dev: the same partition scenes.dev carries, one step further down the
    // pipeline. Without it a dev worker can claim a production project's
    // final build and write a real delivered artifact — see
    // 0069_final_versions_dev_flag.sql.
    .insert({ project_id: projectId, recipe, dev: isDev() })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(
      `Failed to request a final version for project ${projectId}: ${insertError?.message ?? "no row returned"}`,
    );
  }

  // The new version becomes the active one immediately, before it has a
  // file. That is deliberate: the operator just asked for this cut, so it is
  // the one the page must be about — showing them the previous cut while the
  // one they requested builds invisibly is how "did my rebuild do anything?"
  // happens. A pending active version renders as the assembling placeholder,
  // not as a broken player.
  const { error: pointError } = await admin
    .from("projects")
    .update({ active_final_version_id: inserted.id })
    .eq("id", projectId);

  if (pointError) {
    throw new Error(
      `Failed to point project ${projectId} at final version ${inserted.id}: ${pointError.message}`,
    );
  }

  revalidatePath(deliverPath(projectId));
  return undefined;
}

/**
 * Switches which final version the Deliver page shows and the archive route
 * downloads. The project-level twin of setActiveSceneVersion
 * (actions/frames.ts), and guarded the same way: owner-only via
 * requireProject, and the version must belong to THIS project — without that
 * second check the id is an unvalidated pointer into a table the caller
 * supplies, which would let one project be pointed at another's cut.
 *
 * Switching is free and destroys nothing, so unlike reassembleProject it is
 * not refused on a delivered project: looking at what was delivered next to
 * what came before is exactly the reason to keep old cuts.
 */
export async function setActiveFinalVersion(
  projectId: string,
  versionId: string,
): Promise<ActionResult> {
  await requireProject(projectId);

  const admin = createAdminClient();

  const { data: versions, error: versionError } = await admin
    .from("final_versions")
    .select("id")
    .eq("id", versionId)
    .eq("project_id", projectId)
    .limit(1);

  if (versionError) {
    throw new Error(`Failed to look up final version ${versionId}: ${versionError.message}`);
  }
  if (!versions || versions.length === 0) {
    return { error: "That version does not belong to this project." };
  }

  const { error } = await admin
    .from("projects")
    .update({ active_final_version_id: versionId })
    .eq("id", projectId);

  if (error) {
    throw new Error(
      `Failed to switch project ${projectId} to final version ${versionId}: ${error.message}`,
    );
  }

  revalidatePath(deliverPath(projectId));
  return undefined;
}

/**
 * Marks the project delivered (docs/architecture.md § "User flow" step 9).
 * Status-only write — does not touch scenes or assets. Also the commitment
 * point every project-level lock in this codebase now reads directly
 * (lib/editable-guard.ts's header comment) — see reopenProject below for
 * the way back, and unfreezeScene/retryScene/retryAllFailed/rerenderScene
 * (actions/brief.ts, actions/enqueue.ts) for the paths that clear this
 * status themselves the moment they invalidate what was delivered.
 *
 * Unlike every other write to `projects.status` (compile.ts, enqueue.ts's
 * cache-write comment on enqueueRender explains the pattern) — all cache
 * fossils as of 0018_derived_project_status.sql, recomputed on every read —
 * this one IS read back as truth: deriveProjectStatus (lib/project-status.ts)
 * checks storedStatus === 'delivered' before computing anything from
 * scenes, because delivery is a human act no combination of scene statuses
 * can imply.
 */
export async function markDelivered(projectId: string): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  const supabase = await createClient();
  const { data: scenes, error: scenesError } = await supabase
    .from("scenes")
    .select("status")
    .eq("project_id", projectId);

  if (scenesError) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${scenesError.message}`);
  }

  // The completeness check the button's own doc comment admitted was
  // missing: "This is a UI gate only... the server-side guard belongs in
  // that action and is NOT implemented."
  //
  // A disabled button is a convenience, never a boundary — anyone can POST a
  // Server Action directly, past whatever the browser would have refused, and
  // this one writes the commitment point every project-level lock in the
  // codebase reads. Marked delivered, a project freezes its script, its
  // character, its product and its prompts; doing that to a project whose
  // scenes never finished locks an operator out of the very edits that would
  // fix it.
  //
  // Returned, not thrown: "not every scene has rendered yet" is an ordinary
  // state with an obvious next step, which is what lib/action-result.ts
  // reserves a returned error for.
  const rows = scenes ?? [];
  if (rows.length === 0) {
    return { error: "This project has no scenes yet — there is nothing to deliver." };
  }
  const unfinished = rows.filter((scene) => scene.status !== "done").length;
  if (unfinished > 0) {
    return {
      error:
        `${unfinished} of ${rows.length} scene${rows.length === 1 ? "" : "s"} ` +
        "still has not rendered. Delivering now would freeze the project with clips missing — " +
        "finish or remove them first.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({ status: "delivered", updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (error) {
    throw new Error(`Failed to mark project ${projectId} delivered: ${error.message}`);
  }

  revalidatePath(deliverPath(project.id));
}

/**
 * Explicit way back out of 'delivered' (docs/architecture.md § "User flow"
 * step 9) — the "client says fix scene 3" workflow. Delivered is the
 * commitment point every project-level lock in this codebase now reads
 * (lib/editable-guard.ts's header comment, actions/character.ts,
 * actions/project.ts, actions/character-library.ts): Character/Brief/
 * Frames stay frozen while `project.status === 'delivered'`, and this is
 * the control that clears it so they unfreeze again. A scene-level
 * correction (unfreezeScene, actions/brief.ts) and a re-render
 * (retryScene/retryAllFailed/rerenderScene, actions/enqueue.ts) ALSO clear
 * 'delivered' on their own, unconditionally, the moment they touch a
 * project's assets — see those functions' own doc comments — because a
 * stale 'delivered' pointing at a final asset that was just deleted is
 * worse than a project that briefly reads as its derived, non-delivered
 * status. This action exists for the case those don't cover: an operator
 * who wants to fix the Character reference, the script, or a Brief prompt
 * BEFORE touching any scene's render state at all.
 *
 * Writes 'complete', not any other non-delivered value: deriveProjectStatus
 * (lib/project-status.ts) only ever trusts the stored column for
 * 'delivered' itself, so the exact value written here is overwritten by the
 * real, scene-derived status on every subsequent read — but
 * deriveReachedSteps (same file) also reads the RAW stored value to decide
 * which pipeline steps the step-rail shows as ever-reached, and 'complete'
 * is a member of both its FRAMES_REACHED_STORED_STATUSES and
 * RENDER_REACHED_STORED_STATUSES sets. A delivered project got there by
 * having every scene finish, i.e. by having actually reached 'complete' at
 * some point, so this is the honest choice, not just a safe one.
 *
 * A no-op, not a refusal, when the project isn't currently delivered —
 * reachable from a stale tab (e.g. two tabs open on the same Deliver page,
 * one of which already reopened it) with nothing wrong to report.
 *
 * Returns `{ reopened }` rather than void so a caller whose own optimistic
 * client state might disagree with the server (clip-grid.tsx's
 * SceneFixPromptDialog calls this unconditionally, from whatever project
 * status the client currently believes) can tell whether this call actually
 * flipped anything, instead of assuming it did. See clip-grid.tsx's
 * handleSceneReopened for the caller this matters to.
 */
export async function reopenProject(projectId: string): Promise<{ reopened: boolean }> {
  const { project } = await requireProject(projectId);

  if (project.status !== "delivered") {
    return { reopened: false };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({ status: "complete", updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (error) {
    throw new Error(`Failed to reopen project ${projectId}: ${error.message}`);
  }

  revalidatePath(deliverPath(project.id));
  revalidatePath(`/projects/${project.id}/character`);
  revalidatePath(`/projects/${project.id}/brief`);
  revalidatePath(`/projects/${project.id}/frames`);

  return { reopened: true };
}

/**
 * Re-packs `idx` to match a caller-supplied order for the Deliver page's
 * drag-to-reorder-the-assembled-cut UI. Same signature and persistence
 * (persistOrder, actions/brief.ts) as reorderScenes there, and it exists as
 * its OWN action rather than a flag on reorderScenes for a reason worth
 * spelling out, not just repeating.
 *
 * reorderScenes exists to protect the brief stage: a project mid-render can
 * have some scenes still in draft/frame_ready and others already rendered,
 * and assertLockedOrderPreserved (lib/editable-guard.ts) is what lets the
 * former move freely while pinning the latter's relative order, because
 * moving a rendered scene there would "silently change what 'scene N'
 * means in the assembled video without re-rendering anything" (that
 * function's doc comment). On the Deliver page every scene is already
 * 'done' or 'failed' — assertLockedOrderPreserved would see every scene as
 * locked and reject 100% of cut reorders, not as an edge case but as the
 * only case. Weakening that guard to admit this would reopen the brief
 * stage's hole it exists to close; adding a flag would just be that
 * weakening with extra steps.
 *
 * So this function deliberately does NOT call assertLockedOrderPreserved.
 * That is safe here specifically because of this function's own
 * precondition, checked below: every scene must be terminal ('done' or
 * 'failed') before a reorder is accepted. With nothing in draft/frame_ready
 * and nothing queued/rendering, there is no in-flight render that could
 * land in a slot the operator didn't choose, and no not-yet-rendered
 * scene's position is being decided behind their back — the exact silent
 * divergence assertLockedOrderPreserved was written to prevent simply
 * cannot occur. And unlike the brief stage, "what changed" here is not
 * silent: reassembleProject (above) is an explicit, operator-initiated
 * action that opens a final version whose recipe records whatever order
 * `scenes.idx` holds at that moment, and the worker builds it — with fresh
 * captions — from that, and getCutStatus (above) tells the operator when a
 * `final` no longer matches the current order. assertLockedOrderPreserved
 * itself is unchanged and remains the correct, load-bearing guard for
 * reorderScenes and the brief stage — this is a one-off, narrowly-scoped
 * exception to it, not a reason to remove or relax it (see the
 * cross-reference left on that function).
 *
 * Preconditions, refused as `{error}` rather than thrown so the operator
 * reads why (lib/action-result.ts):
 *   - owner-only via requireProject (never requireProjectReadable) — this
 *     rewrites `scenes.idx` and `projects.cut_order_updated_at`, both
 *     writes gated on ownership everywhere else in this codebase.
 *   - refused once `project.status === 'delivered'`, same commitment-point
 *     lock and message convention as reassembleProject above — the cut
 *     order is part of what was already handed to the client.
 *   - refused unless every scene is terminal ('done' or 'failed') — see
 *     above for why this is what makes skipping assertLockedOrderPreserved
 *     honest. Reuses isEditable/isSceneInFlight (lib/editable-guard.ts)
 *     rather than a third copy of the status lists those already are.
 *   - `orderedIds` must be the project's complete scene set, the same
 *     validation reorderScenes performs. A 'failed' scene has no clip and
 *     so never appears in the Deliver grid — the caller (UI) is
 *     responsible for still including its id here; this function refuses
 *     rather than silently dropping it from the order.
 *
 * On success: rewrites `scenes.idx` via persistOrder (actions/brief.ts,
 * the same two-phase negative-range write reorderScenes uses, reused
 * rather than reimplemented), stamps `projects.cut_order_updated_at =
 * now()` exactly as reorderScenes does — this is the column getCutStatus
 * (above) compares a `final` asset's created_at against to report "stale"
 * — and revalidates both the Deliver route (where this ran) and the Brief
 * route (whose scene numbering is driven by the same `idx` column),
 * matching reorderScenes's own revalidatePath call.
 */
export async function reorderCut(projectId: string, orderedIds: string[]): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return {
      error:
        "This project has already been delivered — reopen it (Deliver page) before " +
        "reordering the assembled cut.",
    };
  }

  const admin = createAdminClient();
  const { data: existing, error: scenesError } = await admin
    .from("scenes")
    .select("id, status")
    .eq("project_id", projectId)
    .order("idx", { ascending: true });

  if (scenesError) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${scenesError.message}`);
  }

  const scenes = existing ?? [];

  const notTerminal = scenes.find(
    (scene) => isEditable(scene.status) || isSceneInFlight(scene.status),
  );
  if (notTerminal) {
    return {
      error:
        `Scene ${notTerminal.id} is still "${notTerminal.status}" — every scene must finish ` +
        "rendering, or fail and be retried, before the assembled cut can be reordered. Finish " +
        "or retry the outstanding scene(s) first.",
    };
  }

  const existingIds = new Set(scenes.map((scene) => scene.id));
  const orderedIdSet = new Set(orderedIds);
  const isCompleteMatch =
    orderedIds.length === scenes.length &&
    scenes.length === orderedIdSet.size &&
    scenes.every((scene) => orderedIdSet.has(scene.id)) &&
    orderedIds.every((id) => existingIds.has(id));

  if (!isCompleteMatch) {
    return {
      error:
        "reorderCut: orderedIds must be exactly this project's complete scene set, including " +
        "any failed scenes — they have no clip in the Deliver grid but still occupy a slot in " +
        "the assembled cut.",
    };
  }

  await persistOrder(admin, orderedIds);

  const { error: stampError } = await admin
    .from("projects")
    .update({ cut_order_updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (stampError) {
    throw new Error(
      `Failed to stamp cut_order_updated_at for project ${projectId}: ${stampError.message}`,
    );
  }

  revalidatePath(deliverPath(projectId));
  revalidatePath(briefPath(projectId));
}
