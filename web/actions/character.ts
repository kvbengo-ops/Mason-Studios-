"use server";

// Step 2 of the pipeline (docs/architecture.md § "User flow"): character and
// product reference photos/library, and the generated composite. The narrow
// text writes that used to live here (saveCharacterSetup, covering title,
// script, the six lib/direction.ts columns, captions, character_desc and
// product_name/appearance in one shot) moved to actions/setup.ts's
// saveCharacter/saveProduct/saveScript and actions/settings.ts's
// saveDirection/saveTitle once the single Character Setup page split into
// /character, /product, /script and /settings — see actions/setup.ts's
// header for why that write had to split the same way the page did. This
// file keeps every photo/upload/regenerate/library action exactly as it was.
//
// Was one of the two files left throwing when the rest of the app was moved
// onto lib/action-result.ts's pattern — see that file for the full
// rationale. Short version, restated here because it's easy to get
// backwards mid-edit: if a human can act on the message, return it as an
// ActionResult; if it only means something broke, keep throwing and let
// production redact it (React error #441) — a raw Postgres/Storage/vendor
// failure is more useful to us in a server log than a leaked driver message
// would be to an operator who can't do anything about it anyway.

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireProject, isAdmin, AuthorizationError } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { generateImage, modelForImageArgs, ImageGenerationError } from "@/lib/kie";
import { classifyRenderError } from "@/lib/render-error";
import {
  uploadFromUrl,
  uploadFile,
  removeStorageObjects,
  resolveStagedUploads,
  signedUrl,
} from "@/lib/storage";
import { estimatedRefFrameCostUsd, applySceneCostUsd, parseCompilerModel } from "@/lib/models";
import { assertWithinSpendCaps } from "@/lib/spend";
import { recordRun, failedRunFields } from "@/lib/runs";
import {
  improveDescriptionText,
  describePhotoAppearance,
  CLAUDE_VENDOR,
  type ImproveDescriptionArgs,
} from "@/lib/claude";
import {
  formatFileSizeMB,
  isAcceptedReferenceImage,
  isAcceptedReferenceImageSize,
  MAX_REFERENCE_IMAGE_BYTES,
} from "@/lib/file-type";
import { nextProductRefPosition, promotedPrimaryId } from "@/lib/product-ref-position";
import type { ActionResult } from "@/lib/action-result";
import type { AssetKind, Database } from "@/types/db";

function characterPath(projectId: string): string {
  return `/projects/${projectId}/character`;
}

// Product photos, primary designation and the character+product composite
// now render on their own route (/product) rather than sharing /character —
// see this feature's task for the split. character_ref/regenerateCharacter
// still revalidate characterPath above; every function below that only
// touches product_ref/composite_ref rows revalidates this instead.
function productPath(projectId: string): string {
  return `/projects/${projectId}/product`;
}

// The commitment point for every field in this file is `projects.status ===
// 'delivered'` (actions/deliver.ts's markDelivered/reopenProject), NOT "a
// scene has left draft/frame_ready" — see lib/editable-guard.ts's header
// comment for why those are different questions. Rendering has already
// started is exactly the case this file now lets through: changing a
// character reference, a product photo, or the script after clips exist
// doesn't corrupt those clips (nothing re-reads this project-level state to
// produce them), it just means they no longer match the reference until
// they're re-rendered — a warning the Character page surfaces (see
// character/page.tsx's `hasCommittedScenes` banner), not a write refusal.
// `project` is already available from requireProject/requireScene in every
// caller below (its `.status` is deriveProjectStatus's output — see
// actions/guard.ts — so 'delivered' here is the same trusted, human-set
// value markDelivered wrote, not a stale cache read), so there is no
// separate scene query to run here anymore.
const LOCKED_MESSAGE =
  "This project has already been delivered — references are locked so the delivered copy stays " +
  "meaningful. Reopen the project (Deliver page) to make changes; existing clips won't reflect " +
  "the change until they're re-rendered.";

/**
 * Deletes the project's composite_ref row (Storage object AND the `assets`
 * row, same fail-safe ordering as removeReferenceAsset below) — called by
 * every write in this file, and by useCharacter
 * (actions/character-library.ts), that changes EITHER input the composite
 * was built from: the character reference photo or the product reference
 * photo.
 *
 * The bug this closes: nothing in the codebase ever invalidated
 * composite_ref before this. regenerateComposite (below) conditions kie's
 * edit model on both references at once specifically so the image is
 * provably "this exact person holding this exact product" — but once
 * generated, it just sits there as an ordinary asset row. If an operator
 * then swaps the character photo (a new spokesperson, a retake, a
 * different library pick) without also clicking "Regenerate Combined," the
 * stale composite still shows the OLD person. lib/reference-selection.ts
 * routes every product-shot scene to that composite while every
 * talking-head scene picks up the NEW character_ref — so the same ad ends
 * up with two different people in it, the exact defect class
 * source_character_id going stale was already fixed for (see
 * clearCharacterSource above / 0021_project_character_source.sql). Same
 * fix shape here: delete the stale artifact rather than leave it pointing
 * at inputs that no longer match reality. The next visit to this page
 * shows "Not generated yet" and the operator has to explicitly pay to
 * regenerate it from the current references, which is the only way the
 * composite can ever be trusted again.
 *
 * A no-op, not a throw, when no composite exists yet — most projects
 * haven't generated one, and every call site below runs this
 * unconditionally rather than checking first.
 */
export async function invalidateComposite(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
): Promise<void> {
  const { data: composites, error } = await admin
    .from("assets")
    .select("storage_key")
    .eq("project_id", projectId)
    .eq("kind", "composite_ref");

  if (error) {
    throw new Error(`Failed to load composite asset for project ${projectId}: ${error.message}`);
  }

  if (!composites || composites.length === 0) {
    return;
  }

  await removeStorageObjects(composites.map((asset) => asset.storage_key));

  const { error: deleteError } = await admin
    .from("assets")
    .delete()
    .eq("project_id", projectId)
    .eq("kind", "composite_ref");

  if (deleteError) {
    throw new Error(
      `Failed to delete stale composite asset for project ${projectId}: ${deleteError.message}`,
    );
  }
}

/**
 * Blanks `projects.source_character_id` back to null — called by every
 * write in this file that replaces or removes the character reference photo
 * (upload, regenerate, remove), since useCharacter (character-library.ts) is
 * the only action allowed to SET it. See 0021_project_character_source.sql:
 * the column is a label for "this copy still matches that library row," and
 * once this file's own writes have moved the copy, leaving the old label in
 * place would show an "in use" badge for a character the project no longer
 * actually carries.
 */
async function clearCharacterSource(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
): Promise<void> {
  const { error } = await admin
    .from("projects")
    .update({ source_character_id: null })
    .eq("id", projectId);

  if (error) {
    throw new Error(
      `Failed to clear character source label for project ${projectId}: ${error.message}`,
    );
  }
}

/**
 * Rejects a missing, wrong-type, or oversized upload before it's written
 * anywhere. The dropzone (components/reference-dropzone.tsx) already checks
 * type and size client-side, but that's a convenience, not a boundary —
 * anyone can POST a Server Action directly, past whatever the browser would
 * have refused to submit. This is the actual boundary.
 *
 * The size check is redundant in the one case that matters most: a file
 * over Next's `serverActions.bodySizeLimit` (next.config.ts) never reaches
 * this code at all — Next itself rejects the request with a 413 first, and
 * *that* rejection is what threw a redacted #441 in production. This check
 * only catches an oversized file smaller than the body limit but larger
 * than what we're willing to store/generate from.
 */
function validateReferenceFile(
  file: FormDataEntryValue | null,
): { error: string } | { file: File } {
  if (!(file instanceof File) || file.size === 0) {
    return { error: "A photo file is required." };
  }
  if (!isAcceptedReferenceImage(file)) {
    return { error: "Photo must be a JPG, PNG, or WebP file." };
  }
  if (!isAcceptedReferenceImageSize(file)) {
    return {
      error:
        `Photo is ${formatFileSizeMB(file.size)} — the limit is ` +
        `${formatFileSizeMB(MAX_REFERENCE_IMAGE_BYTES)}.`,
    };
  }
  return { file };
}

/**
 * Uploads a real photo as the character reference instead of generating one.
 *
 * Admin-only, on every project — brand control (see 0020_characters.sql):
 * only an admin may add a character to the shared library, and this
 * per-project upload is the other way a character photo enters the system,
 * so it has to carry the same restriction or an editor could route around
 * the library entirely by uploading straight onto their own project. The
 * upload dropzone that calls this is already hidden from an editor in the
 * UI (character/page.tsx) — reaching this at all with a non-admin profile
 * means that was bypassed, hence AuthorizationError (thrown, not returned
 * as an ActionResult) rather than a locked-style refusal an operator could
 * hit in the ordinary course of using the page.
 */
export async function uploadCharacterRef(
  projectId: string,
  formData: FormData,
): Promise<ActionResult> {
  const { user, profile, project } = await requireProject(projectId);
  await resolveStagedUploads(formData, user.id);

  if (!isAdmin(profile)) {
    throw new AuthorizationError(
      "Only admins can upload a character reference photo — editors pick from the Character Library.",
    );
  }

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const validated = validateReferenceFile(formData.get("file"));
  if ("error" in validated) {
    return validated;
  }

  const { storageKey } = await uploadFile({
    file: validated.file,
    projectId,
    kind: "character_ref",
  });

  const admin = createAdminClient();
  const { error } = await admin.from("assets").insert({
    project_id: projectId,
    kind: "character_ref",
    storage_key: storageKey,
    // Stamped from THIS process's clock, not left to the database's
    // default. Every staleness banner on the Character and Product screens
    // compares this created_at against a *_edited_at written by the web
    // server (actions/setup.ts), so leaving the two on different clocks
    // makes any skew between them decide whether a just-generated image is
    // announced as "made from the older description".
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to record character reference asset: ${error.message}`);
  }

  // A fresh upload replaces the reference photo outright — unlike
  // saveCharacter's description edit (actions/setup.ts) there is no "did it
  // actually change" to weigh, every upload is a different file. Whatever
  // source_character_id claimed no longer describes what's in the project.
  await clearCharacterSource(admin, projectId);

  // The character half of the composite's inputs just changed — see
  // invalidateComposite's doc comment for the two-different-people failure
  // this prevents.
  await invalidateComposite(admin, projectId);

  revalidatePath(characterPath(projectId));
}

/**
 * Loads every product_ref asset for a project, ordered by position
 * ascending — position 0 (when any row exists) is always the primary, per
 * the partial unique index 0023_asset_position.sql adds. Every other
 * function in this file that needs to know "which product photo" or "what
 * position is free next" goes through this, so there's exactly one query
 * shape for it.
 */
async function loadProductRefs(
  admin: SupabaseClient<Database>,
  projectId: string,
): Promise<{ id: string; storage_key: string; position: number }[]> {
  const { data, error } = await admin
    .from("assets")
    .select("id, storage_key, position")
    .eq("project_id", projectId)
    .eq("kind", "product_ref")
    .order("position", { ascending: true });

  if (error) {
    throw new Error(
      `Failed to load product reference assets for project ${projectId}: ${error.message}`,
    );
  }

  return data ?? [];
}

/**
 * The primary (position 0) product reference's storage key, or null if the
 * project has no product photo yet. Replaces the old `.order(created_at
 * desc).limit(1)` reads in regenerateComposite below and
 * actions/frames.ts's loadConditioningRefs — with more than one photo now
 * allowed, "most recently uploaded" and "the one the operator designated
 * primary" are no longer guaranteed to be the same row (see
 * setPrimaryProductRef below).
 */
export async function primaryProductRefStorageKey(
  admin: SupabaseClient<Database>,
  projectId: string,
): Promise<string | null> {
  const rows = await loadProductRefs(admin, projectId);
  return rows.find((row) => row.position === 0)?.storage_key ?? null;
}

/**
 * Uploads a product reference photo (optional, used for product-shot
 * scenes). Spec §3.2: "Product Photos (optional — upload multiple angles
 * for better consistency)" — a grid, not a single slot, so this is an ADD,
 * not a replace: every call appends a new `assets` row rather than
 * superseding whatever's already there. Where it lands decides whether it
 * becomes primary: position 0 (and therefore primary — see
 * 0023_asset_position.sql) if this is the very first product photo,
 * otherwise appended after every photo already here.
 *
 * An operator who wants a LATER upload to become primary uses
 * setPrimaryProductRef (the "Make primary" control on product/page.tsx)
 * explicitly — every upload silently reassigning primary would mean the
 * photo the compiled brief and the composite condition on could change out
 * from under an operator who was just adding a second angle, not replacing
 * the first.
 */
export async function uploadProductRef(
  projectId: string,
  formData: FormData,
): Promise<ActionResult> {
  const { user, project } = await requireProject(projectId);
  await resolveStagedUploads(formData, user.id);

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const validated = validateReferenceFile(formData.get("file"));
  if ("error" in validated) {
    return validated;
  }

  const { storageKey } = await uploadFile({ file: validated.file, projectId, kind: "product_ref" });

  const admin = createAdminClient();
  const existing = await loadProductRefs(admin, projectId);
  const position = nextProductRefPosition(existing);

  const { error } = await admin.from("assets").insert({
    project_id: projectId,
    kind: "product_ref",
    storage_key: storageKey,
    position,
  });

  if (error) {
    throw new Error(`Failed to record product reference asset: ${error.message}`);
  }

  // Only the FIRST product photo (position 0) changes what
  // regenerateComposite/loadConditioningRefs actually condition on — see
  // primaryProductRefStorageKey above. Every photo after that is appended
  // at a non-zero position and leaves the primary, and therefore the
  // composite's input, untouched. Invalidating on every upload (this
  // action's pre-multi-photo behaviour) would now delete a perfectly good
  // composite every time an operator adds a second angle that isn't
  // primary.
  if (position === 0) {
    await invalidateComposite(admin, projectId);
  }

  revalidatePath(productPath(projectId));
}

/**
 * Re-runs image generation from the already-saved character description.
 *
 * Deliberately text-only — it does NOT pass the current character
 * reference image to kie's edit model as a conditioning input. An edit
 * call is only as good as its reference: when that reference is the wrong
 * subject entirely (the reported incident was a product bag uploaded into
 * the character slot), no prompt can ever make /edit produce a matching
 * image, and every "Regenerate" click would repeat the identical
 * "no_media_generated" failure forever with no way out except leaving the
 * page. Regenerating from `character_desc` alone sidesteps that failure
 * mode structurally rather than trying to detect it after the fact — the
 * description is independent of whatever photo currently occupies the
 * reference slot, so it always has a chance of succeeding. The trade-off:
 * regeneration cannot inherit visual details that only exist in the photo
 * (an uploaded photo's exact lighting/pose), only in the typed description
 * — acceptable here because this control's only reachable state already
 * requires a saved description (see the disabled-state comment in
 * character/page.tsx). If this call fails for an unrelated reason (a bad
 * prompt on its own), the failure is no longer silent either — see
 * ImageGenerationError below.
 *
 * Admin-only, on every project — same brand-control boundary as
 * uploadCharacterRef above, and for the identical reason: this is the
 * other way a character photo gets produced outside the library, so it has
 * to be restricted the same way or the upload restriction would be trivial
 * to route around. Both the "Regenerate" and the "Generate reference image"
 * buttons on character/page.tsx call this same function, and both are
 * already hidden from an editor there.
 */
export async function regenerateCharacter(projectId: string): Promise<ActionResult> {
  const { user, profile, project } = await requireProject(projectId);

  if (!isAdmin(profile)) {
    throw new AuthorizationError(
      "Only admins can generate a character reference image — editors pick from the Character Library.",
    );
  }

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  // No saved description is an ordinary state (e.g. the character
  // reference came from an uploaded photo, not a typed description) — not
  // a permission problem, so this must not be an AuthorizationError. The
  // "Regenerate" control is also disabled in this state (see
  // character/page.tsx) so this is a backstop, not the primary UX.
  const description = project.character_desc?.trim();
  if (!description) {
    return { error: "Type a description first — there is nothing to regenerate from." };
  }

  const refFrameUsd = estimatedRefFrameCostUsd();
  const capResult = await assertWithinSpendCaps(user.id, profile, refFrameUsd);
  if (capResult) return capResult;

  const genArgs = { prompt: description };
  const model = modelForImageArgs(genArgs);

  let url: string;
  let costUsd: number | null;
  try {
    ({ url, costUsd } = await generateImage(genArgs));
  } catch (err) {
    // failedRunFields, not a hand-written costUsd/error pair: a poll-budget
    // timeout means kie is STILL DRAWING and will still bill, so it keeps the
    // task id and HOLDS the estimate instead of recording the paid call as
    // free. Every other failure records exactly as it did before — null cost,
    // raw message — for the reason recordRun's own doc comment gives.
    await recordRun({
      projectId,
      vendor: "kie",
      model,
      ...failedRunFields(err, refFrameUsd),
    });
    if (err instanceof ImageGenerationError) {
      // Through classifyRenderError, not raw: kie's own message is whatever
      // the vendor echoed back, and in the signing path that can contain the
      // signed reference-image URL we sent — a Supabase signed URL carries an
      // access token (see lib/render-error.ts). It also turns a recognised
      // cause into something the operator can act on: a content-policy
      // refusal is inconsistent about the same input, and saying "try again"
      // is the difference between a dead end and a retry that usually works.
      // Anything unrecognised falls through as the sanitised original.
      return { error: classifyRenderError(err.message).message };
    }
    throw err;
  }

  const { storageKey } = await uploadFromUrl({ url, projectId, kind: "character_ref" });

  const admin = createAdminClient();
  const { error } = await admin.from("assets").insert({
    project_id: projectId,
    kind: "character_ref",
    storage_key: storageKey,
    // Stamped from THIS process's clock, not left to the database's
    // default. Every staleness banner on the Character and Product screens
    // compares this created_at against a *_edited_at written by the web
    // server (actions/setup.ts), so leaving the two on different clocks
    // makes any skew between them decide whether a just-generated image is
    // announced as "made from the older description".
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to record character reference asset: ${error.message}`);
  }

  // costUsd is the vendor-reported actual whenever the call returned one
  // non-null on every successful call — kie's response always carries a
  // billing figure. See
  // GenerateImageResult.costUsd's doc comment (lib/kie.ts).
  await recordRun({
    projectId,
    vendor: "kie",
    model,
    costUsd: costUsd ?? estimatedRefFrameCostUsd(),
  });

  // Same reasoning as uploadCharacterRef: a regenerated photo is a new
  // image, so any "in use" label is now describing a copy that no longer
  // exists in this project.
  await clearCharacterSource(admin, projectId);

  // Same reasoning as uploadCharacterRef: the character half of the
  // composite's inputs just changed underneath it.
  await invalidateComposite(admin, projectId);

  revalidatePath(characterPath(projectId));
}

/**
 * Deletes every stored reference of the given kind for a project — the
 * Storage object(s) AND the matching `assets` row(s) together, never one
 * without the other (an orphaned row breaks `signedUrl`; an orphaned object
 * is invisible, paid-for storage). Every row of the kind is removed, not
 * just the newest: uploadCharacterRef/regenerateCharacter both INSERT a new
 * row rather than replacing the old one, so leaving an older
 * row behind would make it silently reappear as "the" reference the next
 * time character/page.tsx (character_ref) or product/page.tsx (composite_ref)
 * queries "most recent by kind" — the operator
 * would see Remove appear to work and then watch the old photo come back.
 *
 * character_ref and composite_ref ONLY — product_ref has its own dedicated
 * removeProductRef below, and must NOT be routed through here. Before
 * multi-photo product references (0023_asset_position.sql), "delete every
 * row of this kind" was correct for product_ref too, because only one row
 * could ever exist at a time; now that a project can have many, this
 * would delete an operator's whole product grid over a single ✕ click. See
 * removeProductRef's own doc comment for the replacement.
 *
 * Removing character_ref also invalidates the composite — it's half of
 * what the composite was built from, so removing it leaves the composite
 * describing a reference that no longer exists (see invalidateComposite's
 * doc comment). Removing composite_ref itself (the ✕ on the composite
 * card, via removeComposite below) needs no separate invalidation call —
 * the generic delete just above already did it.
 */
async function removeReferenceAsset(
  projectId: string,
  kind: Extract<AssetKind, "character_ref" | "composite_ref">,
): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const admin = createAdminClient();
  const { data: assets, error } = await admin
    .from("assets")
    .select("storage_key")
    .eq("project_id", projectId)
    .eq("kind", kind);

  if (error) {
    throw new Error(`Failed to load ${kind} assets for project ${projectId}: ${error.message}`);
  }

  if (!assets || assets.length === 0) {
    // Nothing to remove — the ✕ shouldn't even render in this state, but a
    // stale tab reaching here is a no-op, not a failure.
    return;
  }

  // Storage first, `assets` row second — see removeStorageObjects for why
  // this order is the one that fails safe.
  await removeStorageObjects(assets.map((asset) => asset.storage_key));

  const { error: deleteError } = await admin
    .from("assets")
    .delete()
    .eq("project_id", projectId)
    .eq("kind", kind);

  if (deleteError) {
    throw new Error(
      `Failed to delete ${kind} asset rows for project ${projectId}: ${deleteError.message}`,
    );
  }

  // Only a removed character_ref (not composite_ref) touches the character
  // source label — removing the photo the library copy became means the
  // project no longer carries that copy at all, so "in use" would be
  // outright false rather than merely stale.
  if (kind === "character_ref") {
    await clearCharacterSource(admin, projectId);
    // The character half of the composite's inputs just changed — see
    // invalidateComposite's doc comment. composite_ref needs no such call:
    // removing the composite IS the invalidation.
    await invalidateComposite(admin, projectId);
  }

  // character_ref renders on /character; composite_ref renders on /product
  // now — see productPath's doc comment above.
  revalidatePath(kind === "character_ref" ? characterPath(projectId) : productPath(projectId));
}

/** Removes the character reference photo (and any prior ones it superseded). */
export async function removeCharacterRef(projectId: string): Promise<ActionResult> {
  return removeReferenceAsset(projectId, "character_ref");
}

/**
 * Removes ONE product reference photo by asset id — NOT every product_ref
 * row for the project, unlike removeReferenceAsset above. character_ref and
 * composite_ref still only ever have one meaningful row at a time; product
 * photos are now a grid (spec §3.2, 0023_asset_position.sql), and a Remove
 * click on photo 3 of 8 must not take the other seven with it. This is the
 * fix for the gap this whole feature closes: the prior removeReferenceAsset
 * behaviour (delete every row of a kind) was correct back when only one
 * product photo could exist and became actively wrong the moment a second
 * one could.
 *
 * Ownership of `assetId` is checked here (project_id AND kind must match),
 * not assumed from the id alone — this is a Server Action, reachable
 * directly with any string a caller chooses, and requireProject only
 * proves the caller owns `projectId`, not that `assetId` is really one of
 * ITS rows.
 *
 * Removing the PRIMARY photo (position 0) promotes the next one in line and
 * invalidates the composite, since the input regenerateComposite/
 * loadConditioningRefs actually condition on just changed — either to a
 * different photo, or to none. Removing a non-primary photo changes
 * nothing about that input, so it does neither.
 */
export async function removeProductRef(projectId: string, assetId: string): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const admin = createAdminClient();
  const { data: asset, error } = await admin
    .from("assets")
    .select("storage_key, position")
    .eq("id", assetId)
    .eq("project_id", projectId)
    .eq("kind", "product_ref")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load product reference asset ${assetId}: ${error.message}`);
  }

  if (!asset) {
    // Already gone, or never belonged to this project/kind — a stale tab
    // reaching here is a no-op, not a failure (same reasoning as
    // removeReferenceAsset's empty-result case above).
    return;
  }

  // Storage first, `assets` row second — see removeStorageObjects for why
  // this order is the one that fails safe.
  await removeStorageObjects([asset.storage_key]);

  const { error: deleteError } = await admin.from("assets").delete().eq("id", assetId);

  if (deleteError) {
    throw new Error(`Failed to delete product reference asset ${assetId}: ${deleteError.message}`);
  }

  if (asset.position === 0) {
    // The photo that just left WAS the primary. Promote whichever photo is
    // next in line (lowest remaining position) so the grid — and the
    // vendor call — always have a primary the moment any product photo
    // exists at all. See promotedPrimaryId's doc comment
    // (lib/product-ref-position.ts).
    const remaining = await loadProductRefs(admin, projectId);
    const promotedId = promotedPrimaryId(remaining);

    if (promotedId) {
      const { error: promoteError } = await admin
        .from("assets")
        .update({ position: 0 })
        .eq("id", promotedId);

      if (promoteError) {
        throw new Error(
          `Failed to promote product reference ${promotedId} to primary: ${promoteError.message}`,
        );
      }
    }

    // Either a different photo is primary now, or none is — both change
    // what the composite was built from, same as removing character_ref
    // does above.
    await invalidateComposite(admin, projectId);
  }

  revalidatePath(productPath(projectId));
}

/**
 * Re-designates which product photo is primary — the "Make primary"
 * control on a non-primary card in the grid (product/page.tsx). Swaps
 * positions with whatever currently holds position 0 rather than
 * renumbering the whole grid, so every other photo's position (and
 * therefore its place in the grid) is untouched.
 *
 * The swap goes through a transient pivot position (one past the current
 * max — see nextProductRefPosition's doc comment in
 * lib/product-ref-position.ts for why it doubles as this) rather than a
 * single UPDATE that sets both rows' positions at once: this file has no
 * database function or transaction wrapper — every write here is a
 * sequence of plain awaited Supabase calls, same as every other action in
 * this file — and leaning on Postgres's same-statement unique-constraint
 * timing for a direct two-row swap is exactly the kind of unverified
 * engine-shape assumption this codebase has been burned by before (see
 * c79f82b — verify vendor/engine request shape before relying on it, not
 * after). Three small, unambiguous writes cost one extra round trip and
 * remove all doubt.
 */
export async function setPrimaryProductRef(
  projectId: string,
  assetId: string,
): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const admin = createAdminClient();
  const rows = await loadProductRefs(admin, projectId);
  const target = rows.find((row) => row.id === assetId);

  if (!target) {
    return { error: "That product photo no longer exists." };
  }

  if (target.position === 0) {
    // Already primary — the UI hides "Make primary" on the primary card,
    // so reaching here means a stale tab. A no-op, not a failure.
    return;
  }

  const currentPrimary = rows.find((row) => row.position === 0);
  const pivot = nextProductRefPosition(rows);

  const { error: pivotError } = await admin
    .from("assets")
    .update({ position: pivot })
    .eq("id", target.id);
  if (pivotError) {
    throw new Error(`Failed to re-designate primary product reference: ${pivotError.message}`);
  }

  if (currentPrimary) {
    const { error: demoteError } = await admin
      .from("assets")
      .update({ position: target.position })
      .eq("id", currentPrimary.id);
    if (demoteError) {
      throw new Error(`Failed to re-designate primary product reference: ${demoteError.message}`);
    }
  }

  const { error: promoteError } = await admin
    .from("assets")
    .update({ position: 0 })
    .eq("id", target.id);
  if (promoteError) {
    throw new Error(`Failed to re-designate primary product reference: ${promoteError.message}`);
  }

  // Re-designating primary always changes what regenerateComposite/
  // loadConditioningRefs condition on, even though no photo was added or
  // removed — same "the input changed" reasoning as removeProductRef's
  // primary-removal branch above.
  await invalidateComposite(admin, projectId);

  revalidatePath(productPath(projectId));
}

/**
 * Removes the generated character+product composite directly — an
 * operator-initiated discard (the ✕ on the composite card,
 * product/page.tsx), not the automatic invalidation every other write in
 * this file applies as a side effect of changing an input (see
 * invalidateComposite above for that path). Both end up deleting the same
 * row the same way; this one just lets the operator do it on demand,
 * e.g. to force a clean re-generation without first touching either
 * reference photo.
 */
export async function removeComposite(projectId: string): Promise<ActionResult> {
  return removeReferenceAsset(projectId, "composite_ref");
}

/**
 * Most-recently-uploaded storage key for one asset kind, or null if none
 * exists yet. Only called for character_ref now — product_ref moved to
 * primaryProductRefStorageKey above once more than one product photo could
 * exist (0023_asset_position.sql); character_ref still has no grid or
 * primary concept, so "most recent" remains the right read for it.
 */
async function latestAssetStorageKey(
  admin: SupabaseClient<Database>,
  projectId: string,
  kind: AssetKind,
): Promise<string | null> {
  const { data, error } = await admin
    .from("assets")
    .select("storage_key")
    .eq("project_id", projectId)
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load ${kind} asset for project ${projectId}: ${error.message}`);
  }

  return data?.storage_key ?? null;
}

// NEVER refer to the references by position ("the first reference photo",
// "the second image"). Verified against the live API with real assets: an
// otherwise identical request phrased that way is rejected with HTTP 422
// `no_media_generated` every single time, while the same two images and the
// same instruction phrased demonstratively — "this person", "this product" —
// succeed. Nothing in the error names the prompt as the cause, so this cost
// a round of bisecting arity, file format and aspect ratio to find. The
// model reads the attachments as context, not as an indexed list.
const COMPOSITE_PROMPT_BASE =
  "Show this exact person holding and presenting this exact product package in their hand, " +
  "facing the camera. Keep their face, hair, clothing and setting unchanged, and keep the " +
  "package's label, colours and shape exactly as shown. Do not substitute a different person " +
  "or a different package.";

/**
 * project.product_name is folded into the composite's own generation
 * prompt (not just the compiled brief — see actions/setup.ts's saveProduct)
 * because a
 * named product gives kie's edit model one more anchor for which object
 * in frame is "the product" when the reference photo is ambiguous (e.g. a
 * jar next to other kitchen items).
 */
function compositePrompt(productName: string | null, visualIdea: string | null): string {
  const parts = [COMPOSITE_PROMPT_BASE];
  if (productName) {
    parts.push(`The product is "${productName}".`);
  }
  // The visual idea reaches every scene prompt through the compiler, so
  // leaving it out here made the composite the one image shot on a
  // different set: the clips came back on plastic sheeting under a warm
  // lamp while the composite was a clean bright office. This image is the
  // reference those clips condition on, so a mismatch here pulls against
  // the very consistency it exists to provide.
  if (visualIdea?.trim()) {
    parts.push(visualIdea.trim());
  }
  return parts.join(" ");
}

/**
 * Generates the "character with product" composite — spec §3.2's entire
 * reason for the Product step to exist: "We'll generate one combined image
 * of the character holding/showing the product — that's the only product
 * shot we need." Conditions kie's edit model (lib/kie.ts) on BOTH
 * reference photos at once, character first then product, rather than
 * generating from a text description of either: a description can drift
 * from the actual uploaded photo, and the entire point of this image is
 * that it is provably built from the two references the operator already
 * approved, the same way every other reference-conditioned call in this
 * file works.
 *
 * The product half is the PRIMARY product photo (position 0 —
 * 0023_asset_position.sql), not "most recently uploaded": with a grid of
 * photos now allowed, an operator can add a third angle after already
 * designating the first as primary, and that later upload must not
 * silently become what this call conditions on. See
 * primaryProductRefStorageKey above.
 *
 * Only ONE product photo is ever sent here, deliberately, even though spec
 * §3.2 says "all [uploaded photos] are passed as references at image-gen
 * time." kie's nano-banana-edit `image_urls` field carries no documented cap on
 * how many references it accepts, but this repo has only ever verified TWO
 * references work end-to-end against the live endpoint — c79f82b's incident bisected arity as one of the
 * suspects for a 422 `no_media_generated` failure at exactly that count
 * (2) and ruled it out, which proves 2 is safe but says nothing about 3+.
 * Expanding this call to every uploaded product photo would be an
 * unverified vendor-shape change made without spending real money to prove
 * it first — the same category of mistake c79f82b itself was. So: primary
 * only, arity stays at the proven-safe 2 (character + primary product).
 * If the full spec behaviour is wanted later, that's a follow-up that
 * starts by testing 3+ images against the live endpoint outside the app,
 * not a blind change here.
 *
 * Requires both a character and a product reference to already be saved.
 * Unlike regenerateCharacter there is no text-only fallback here, because
 * there is no text description of the product to fall back to —
 * uploadProductRef never collects one, only a photo.
 */
export async function regenerateComposite(projectId: string): Promise<ActionResult> {
  const { user, profile, project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const admin = createAdminClient();

  const [characterKey, productKey] = await Promise.all([
    latestAssetStorageKey(admin, projectId, "character_ref"),
    primaryProductRefStorageKey(admin, projectId),
  ]);

  if (!characterKey || !productKey) {
    return {
      error:
        "Upload both a character reference and a product photo before generating the combined image.",
    };
  }

  const refFrameUsd = estimatedRefFrameCostUsd();
  const capResult = await assertWithinSpendCaps(user.id, profile, refFrameUsd);
  if (capResult) return capResult;

  // No transform here, deliberately: these feed generateImage's
  // refImageUrls below, not a <img> tag. A downscaled, lossily recompressed
  // reference would silently degrade the composite generateImage produces from it —
  // this must stay full-fidelity, unlike this same project's display-only
  // reads of these storage_keys on character/page.tsx and product/page.tsx.
  const [characterUrl, productUrl] = await Promise.all([
    signedUrl(characterKey),
    signedUrl(productKey),
  ]);

  const genArgs = {
    prompt: compositePrompt(project.product_name, project.visual_idea),
    refImageUrls: [characterUrl, productUrl],
  };
  const model = modelForImageArgs(genArgs);

  let url: string;
  let costUsd: number | null;
  try {
    ({ url, costUsd } = await generateImage(genArgs));
  } catch (err) {
    // failedRunFields, not a hand-written costUsd/error pair: a poll-budget
    // timeout means kie is STILL DRAWING and will still bill, so it keeps the
    // task id and HOLDS the estimate instead of recording the paid call as
    // free. Every other failure records exactly as it did before — null cost,
    // raw message — for the reason recordRun's own doc comment gives.
    await recordRun({
      projectId,
      vendor: "kie",
      model,
      ...failedRunFields(err, refFrameUsd),
    });
    if (err instanceof ImageGenerationError) {
      // See the note on the first ImageGenerationError catch in this file.
      return { error: classifyRenderError(err.message).message };
    }
    throw err;
  }

  const { storageKey } = await uploadFromUrl({ url, projectId, kind: "composite_ref" });

  const { error } = await admin.from("assets").insert({
    project_id: projectId,
    kind: "composite_ref",
    storage_key: storageKey,
    // Stamped from THIS process's clock, not left to the database's
    // default. Every staleness banner on the Character and Product screens
    // compares this created_at against a *_edited_at written by the web
    // server (actions/setup.ts), so leaving the two on different clocks
    // makes any skew between them decide whether a just-generated image is
    // announced as "made from the older description".
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to record composite reference asset: ${error.message}`);
  }

  // costUsd is the vendor-reported actual whenever the call returned one —
  // see the note on the first recordRun in this file.
  await recordRun({
    projectId,
    vendor: "kie",
    model,
    costUsd: costUsd ?? estimatedRefFrameCostUsd(),
  });

  revalidatePath(productPath(projectId));
}

/**
 * Result shape for improveDescription/describeProductFromPhoto below —
 * deliberately NOT lib/action-result.ts's ActionResult (`{error} |
 * undefined`), since both calls succeed with data an operator has to see
 * and explicitly accept, not merely a "the write went through" signal. Both
 * still follow ActionResult's own rule for which failures are returned vs.
 * thrown (see that file's header): a guard the operator can act on
 * (unowned/locked project, over spend cap, nothing to work from) comes back
 * as `{ error }`; a genuine vendor/infrastructure failure stays thrown.
 */
export type DescriptionSuggestionResult = { error: string } | { suggestion: string };

/**
 * Suggests a filled-in character or product description without writing it
 * anywhere — the operator previews it (components/improve-description-
 * button.tsx) and explicitly accepts or discards, mirroring applyScenePrompt's
 * (actions/brief.ts) own doc comment on why a generated value must never
 * silently replace what a human already typed. This function's entire job
 * ends at "return the suggestion"; CharacterDescriptionField/
 * ProductAppearanceField's onChange (via the accept button) is what puts it
 * in the field, and actions/setup.ts's saveCharacter/saveProduct — completely
 * unchanged by this function's existence — are still the only things that
 * ever write
 * character_desc/product_appearance to the database.
 *
 * Priced and cap-checked exactly like applyScenePrompt (actions/brief.ts):
 * the project's own chosen compiler model (parseCompilerModel), at that
 * model's applySceneCostUsd rate — this is a single small Claude call, the
 * same shape and cost class as a per-scene Apply, so it reuses that
 * function's exact pricing rather than inventing a third figure. Every
 * attempt is recorded via recordRun regardless of outcome, costUsd null on
 * a failed call — see applyScenePrompt's own doc comment for why a failed
 * attempt is never guessed at as billed or not.
 */
export async function improveDescription(
  projectId: string,
  subject: ImproveDescriptionArgs["subject"],
  description: string,
): Promise<DescriptionSuggestionResult> {
  const { user, profile, project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const trimmed = description.trim();
  if (trimmed.length === 0) {
    return { error: "Type something first — there's nothing to improve yet." };
  }

  const compilerModel = parseCompilerModel(project.render_settings);
  const costUsd = applySceneCostUsd(compilerModel);

  const capResult = await assertWithinSpendCaps(user.id, profile, costUsd);
  if (capResult) return capResult;

  const claudeModel = compilerModel.id;
  let result: Awaited<ReturnType<typeof improveDescriptionText>>;
  try {
    result = await improveDescriptionText({ description: trimmed, subject, model: claudeModel });
  } catch (err) {
    // costUsd null — see applyScenePrompt's identical recordRun/catch
    // (actions/brief.ts) for why this codebase won't guess whether a
    // failed Claude call was billed.
    await recordRun({
      projectId,
      vendor: CLAUDE_VENDOR,
      model: claudeModel,
      costUsd: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordRun({
    projectId,
    vendor: CLAUDE_VENDOR,
    model: claudeModel,
    costUsd,
  });

  return { suggestion: result.description };
}

/**
 * Reads the project's already-uploaded PRIMARY product reference photo and
 * suggests product_appearance text written from it — the direct fix for
 * the green-pouch incident (a lime-green pouch photo next to a hand-typed
 * "matte kraft-paper" description): the right answer was already sitting
 * in the app, in the photo, while a human typed a wrong one. Same
 * preview-then-accept contract as improveDescription above — this never
 * writes product_appearance itself.
 *
 * Refuses with an actionable message (not a throw) when there's no product
 * photo yet — an ordinary state for a project that hasn't uploaded one,
 * same treatment regenerateComposite gives the equivalent "nothing to
 * generate from" case above.
 */
export async function describeProductFromPhoto(
  projectId: string,
): Promise<DescriptionSuggestionResult> {
  const { user, profile, project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const admin = createAdminClient();
  const productKey = await primaryProductRefStorageKey(admin, projectId);
  if (!productKey) {
    return { error: "Upload a product photo first — there's nothing to describe from yet." };
  }

  const compilerModel = parseCompilerModel(project.render_settings);
  const costUsd = applySceneCostUsd(compilerModel);

  const capResult = await assertWithinSpendCaps(user.id, profile, costUsd);
  if (capResult) return capResult;

  // No transform, same reasoning as regenerateComposite's own signedUrl
  // calls above — this feeds a vendor's image input, not an <img> tag.
  const productUrl = await signedUrl(productKey);
  const claudeModel = compilerModel.id;
  let result: Awaited<ReturnType<typeof describePhotoAppearance>>;
  try {
    result = await describePhotoAppearance({
      imageUrl: productUrl,
      productName: project.product_name ?? undefined,
      // Everything the operator has already said about this product, so one
      // call can reconcile the words with the picture instead of replacing
      // them. Read from the SCENE of truth — the projects row — rather than
      // taken as a client argument, so a stale form value cannot smuggle in
      // text the operator has since changed.
      currentText: project.product_appearance ?? undefined,
      model: claudeModel,
    });
  } catch (err) {
    await recordRun({
      projectId,
      vendor: CLAUDE_VENDOR,
      model: claudeModel,
      costUsd: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordRun({
    projectId,
    vendor: CLAUDE_VENDOR,
    model: claudeModel,
    costUsd,
  });

  return { suggestion: result.description };
}
