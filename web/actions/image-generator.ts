"use server";

// The Image Generator (docs/image-generation-route-plan.md): a standalone
// text-to-image console at /image-generator, owned by an ACCOUNT.
//
// It used to need a project. 0083/0084 gave it one of its own kind because two
// NOT NULLs said it had to -- assets.project_id for the file, runs.project_id
// for the charge -- and the console at /images/[id] was therefore preceded by
// a picker. 0085_personal_image_generator.sql gave both tables an owner column
// instead, so the picker is gone and generating an image asks for nothing but
// a prompt.
//
// BOTH SHAPES ARE LIVE, and that is the whole structure of this file. Every
// existing image project keeps working at /images/[id], unchanged, because its
// images and its cost history are real and deleting the route to them would
// throw both away. So each paid path here is ONE core function taking an
// `ImageOwner`, wrapped by two entry points that differ only in which guard
// establishes that owner:
//
//   generateProjectImage  -> requireProject (strict, owner-only) -> core
//   generatePersonalImage -> requireUser                         -> core
//
// Two entry points, one body. A second copy of the reserve/generate/settle
// sequence is the shape this file must never grow: the money path has five
// failure branches that have to stay in agreement, and they cannot if they are
// written twice.
//
//   prompt -> estimate -> atomic reserve -> Nano Banana -> settle -> store
//
// It is NOT connected to /ugc or video generation. The only link between them
// is a human downloading a file and choosing to upload it later; there is no
// code path from a generated image into a render, and adding one would change
// what the wizard conditions on (see the generated_image note in
// 0083_image_generator.sql).
//
// WHY THE MONEY PATH LOOKS THE WAY IT DOES. Reserving means one round trip to
// public.reserve_image_attempt, not an insert followed by assertWithinSpendCaps.
// Two calls are not atomic and double-count: requests interleave between the
// insert and the check, and the check adds this request's own estimate to a sum
// that already contains that reservation, refusing at half the real headroom.
// assertWithinSpendCaps is therefore deliberately NOT called when GENERATING --
// calling both is the exact bug the RPC exists to prevent. Every other paid
// path still uses it, unchanged.
//
// The guard-free core (reserve -> generate -> settle -> store, and recovery)
// lives in lib/image-generation.ts so /api/v1/images can share it; every
// export HERE is a Server Action and calls a guard first.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireProject, requireProjectReadable, requireUser } from "@/actions/guard";
import { IMAGE_MODELS } from "@/lib/models";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import type { ImageHistoryCursor, ImageHistoryPage } from "@/components/image-generator-history";
import { signedUrl } from "@/lib/storage";
import {
  ATTEMPT_COLUMNS,
  generateImageFor,
  reconcileImageAttemptFor,
  toImageAttempt,
  type GeneratedImage,
  type GenerateProjectImageResult,
  type ImageAttempt,
} from "@/lib/image-generation";

// Types only: a "use server" module may export nothing but async functions,
// and a type export is erased before that rule applies.
export type { GeneratedImage, GenerateProjectImageResult, ImageAttempt };

const LOCKED_MESSAGE =
  "This project has been delivered — generating new images is locked. Duplicate it to keep working.";

/**
 * The project shape. Guard notes above apply to this entry point specifically:
 * `projectId` is bound server-side, and the strict guard here is what pairs
 * with /images/[id]'s permissive one.
 */
export async function generateProjectImage(
  projectId: string,
  formData: FormData,
): Promise<GenerateProjectImageResult> {
  const { user, profile, project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  return generateImageFor({ userId: user.id, profile, projectId }, formData);
}

/**
 * The personal shape (0085_personal_image_generator.sql) — /image-generator.
 *
 * requireUser is the entire authorization, and it is sufficient because there
 * is no row whose ownership could be in question: the account it returns IS
 * the owner, every read below is keyed on that id, and the account-approval
 * gate (canUseApp -> /pending) is inside it. There is no "delivered" state to
 * check, because there is no project to deliver.
 *
 * The charge lands on the same weekly allowance a project image would: the
 * reservation carries `runs.user_id`, and user_spend_usd resolves the owner as
 * coalesce(runs.user_id, projects.user_id) since 0085. A project-less image is
 * NOT invisible to the caps — that was the whole condition on removing the
 * project, and 0030's header is where the failure it would otherwise be is
 * written down.
 */
export async function generatePersonalImage(
  formData: FormData,
): Promise<GenerateProjectImageResult> {
  const { user, profile } = await requireUser();
  return generateImageFor({ userId: user.id, profile, projectId: null }, formData, true);
}

// ---------------------------------------------------------------------------
// The personal console's two READ actions.
//
// They live here rather than as inline `"use server"` functions on the page —
// where /images/[id]'s project-scoped twins still live — for one concrete
// reason: lib/client-boundary.test.ts allows a function to cross into a Client
// Component only when it is imported from a "use server" module or written as
// `fn.bind(null, …)`. The project page satisfies that by binding its id. This
// page has no id to bind, so the binding form is not available and the module
// form is the one that is.
//
// Neither takes an owner argument, and that is the security property: the
// account comes from requireUser() on every call, so a client that could name
// one has nothing to name. Both also filter `project_id is null` alongside
// `user_id`, so a project-backed asset is unreachable here even if its id is
// known — see the page for why the two namespaces stay separate.
// ---------------------------------------------------------------------------

const HISTORY_PAGE_SIZE = 20;
const assetIdSchema = z.string().uuid();
const historyCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    assetId: assetIdSchema,
  })
  .nullable();

/** One page of the signed-in account's own generated images, newest first. */
export async function loadPersonalImageHistory(
  cursor: ImageHistoryCursor | null,
): Promise<ImageHistoryPage> {
  const { user } = await requireUser();

  // .or() accepts raw PostgREST syntax. Validate both values before using them
  // in the filter, and retain timestamp microseconds instead of passing
  // through Date.toISOString(), which would truncate the pagination boundary.
  const parsedCursor = historyCursorSchema.safeParse(cursor);
  if (!parsedCursor.success) throw new Error("Invalid image history cursor.");

  // The SESSION client, not the admin one: assets_select (0085) is then a
  // second, independent gate under the explicit user_id filter below. An admin
  // reading their own /image-generator gets their own images and nobody
  // else's, which is what a personal surface should say.
  const supabase = await createClient();
  let query = supabase
    .from("assets")
    .select("id, created_at, storage_key")
    .eq("user_id", user.id)
    .is("project_id", null)
    .eq("kind", "generated_image")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    // One lookahead row tells us whether Load More has anything to fetch.
    // Only the first 20 are signed and returned to the UI.
    .limit(HISTORY_PAGE_SIZE + 1);

  if (parsedCursor.data) {
    const { createdAt, assetId } = parsedCursor.data;
    query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${assetId})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load image history: ${error.message}`);

  const rows = data ?? [];
  const pageRows = rows.slice(0, HISTORY_PAGE_SIZE);
  const lastRow = pageRows.at(-1);
  const images = await Promise.all(
    pageRows.map(async (asset) => ({
      assetId: asset.id,
      createdAt: asset.created_at,
      // THE ORIGINAL, no transform. Supabase's resize does not keep a picture's
      // shape — "cover" crops (a landscape portrait-cropped to a face) and
      // "contain" pads with white — and the wall's whole job is to show each
      // picture's real shape, which it reads off the loaded image itself.
      url: await signedUrl(asset.storage_key),
    })),
  );

  return {
    images,
    nextCursor:
      rows.length > HISTORY_PAGE_SIZE && lastRow
        ? { createdAt: lastRow.created_at, assetId: lastRow.id }
        : null,
  };
}

/** A download URL for one of the caller's own generated images. */
export async function getPersonalImageDownloadUrl(assetId: string): Promise<string> {
  const { user } = await requireUser();

  const parsedId = assetIdSchema.safeParse(assetId);
  if (!parsedId.success) throw new Error("Invalid generated image.");

  // The id arrives from the browser. The owner filter is what makes a guessed
  // or copied id useless — without it this would sign anyone's image for
  // anyone who could name it.
  const supabase = await createClient();
  const { data: asset, error } = await supabase
    .from("assets")
    .select("storage_key")
    .eq("user_id", user.id)
    .is("project_id", null)
    .eq("kind", "generated_image")
    .is("deleted_at", null)
    .eq("id", parsedId.data)
    .maybeSingle();

  if (error) throw new Error(`Failed to load generated image: ${error.message}`);
  if (!asset) throw new Error("This generated image is no longer available.");

  // Sign on click, without the thumbnail transform. The preview URL may be
  // old; the download must request original bytes with attachment disposition.
  return signedUrl(asset.storage_key, undefined, undefined, true);
}

/** What the image viewer's side panel shows. Either field null when not recorded. */
/** `url` is the full-resolution picture for the viewer, signed on open. */
export type GeneratedImageDetails = {
  prompt: string | null;
  model: string | null;
  /** The picker's id for `model`, so Reuse can select it. Null when unknown. */
  modelId: string | null;
  url: string | null;
};

/**
 * The prompt and model behind a generated image the caller has ALREADY proved
 * they can see. Not exported: it filters on nothing but the asset id.
 */
async function detailsForAsset(asset: {
  id: string;
  storage_key: string;
}): Promise<GeneratedImageDetails> {
  const [{ data }, url] = await Promise.all([
    createAdminClient()
      .from("runs")
      .select("prompt, model")
      .eq("asset_id", asset.id)
      .limit(1)
      .maybeSingle(),
    // Original bytes, no transform: the gallery tile is a thumbnail, and the
    // viewer showing that same thumbnail stretched to the screen was blurry.
    signedUrl(asset.storage_key),
  ]);
  if (!data) return { prompt: null, model: null, modelId: null, url };
  // runs.model is the kie id actually called; show the picker's label for it.
  const known = IMAGE_MODELS.find((m) => m.textToImageId === data.model || m.editId === data.model);
  return {
    prompt: data.prompt,
    model: known?.label ?? data.model,
    modelId: known?.id ?? null,
    url,
  };
}

/** The prompt and model behind one of the caller's own generated images. */
export async function getPersonalImageDetails(assetId: string): Promise<GeneratedImageDetails> {
  const { user } = await requireUser();
  const parsedId = assetIdSchema.safeParse(assetId);
  if (!parsedId.success) throw new Error("Invalid generated image.");

  // Same owner filter as getPersonalImageDownloadUrl: the id is from the browser.
  const supabase = await createClient();
  const { data: asset } = await supabase
    .from("assets")
    .select("id, storage_key")
    .eq("user_id", user.id)
    .is("project_id", null)
    .eq("kind", "generated_image")
    .eq("id", parsedId.data)
    .maybeSingle();
  return asset ? detailsForAsset(asset) : { prompt: null, model: null, modelId: null, url: null };
}

/**
 * The project shape. READABLE guard, like /images/[id] itself — viewing an
 * image's details is a read, and a non-owning admin may look.
 */
export async function getProjectImageDetails(
  projectId: string,
  assetId: string,
): Promise<GeneratedImageDetails> {
  await requireProjectReadable(projectId);
  const parsedId = assetIdSchema.safeParse(assetId);
  if (!parsedId.success) throw new Error("Invalid generated image.");

  const supabase = await createClient();
  const { data: asset } = await supabase
    .from("assets")
    .select("id, storage_key")
    .eq("project_id", projectId)
    .eq("kind", "generated_image")
    .eq("id", parsedId.data)
    .maybeSingle();
  return asset ? detailsForAsset(asset) : { prompt: null, model: null, modelId: null, url: null };
}

/** Move a personal generated image to Bin without deleting its file or charge. */
export async function deletePersonalImage(assetId: string): Promise<void> {
  await requireUser();
  const parsedId = assetIdSchema.safeParse(assetId);
  if (!parsedId.success) throw new Error("Invalid generated image.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("manage_personal_image", {
    p_asset_id: parsedId.data,
    p_operation: "trash",
  });
  if (error) throw new Error("Could not move this image to Bin.");
  revalidatePath("/image-generator");
  revalidatePath("/bin");
}

// ---------------------------------------------------------------------------
// RECOVERY (0095_image_attempt_recovery.sql)
//
// The problem: an operator who leaves /image-generator while an image is
// drawing loses the whole browser-held picture of it — spinner, preview, and
// any idea whether the request is still running, finished, or failed. The
// charge is real regardless, so "I don't know what happened to that" is a
// question about money, not about a spinner.
//
// The fix is that the SERVER already knew. A reservation exists before the
// vendor is called (0083), the task id is written the moment kie returns one,
// and 0088 records which image came back. These two actions read that and let
// the client finish what the abandoned request started.
//
// BOTH ARE PERSONAL-SHAPE ONLY, matching the read actions above: requireUser is
// the whole guard, every query is keyed on the id it returns, and both filter
// `project_id is null` so a project-backed attempt is unreachable here even by
// a known id. /images/[id] keeps its existing behaviour untouched — its page
// guards with requireProjectReadable, and adding a recovery action there means
// deciding what a non-owning admin may resume, which is a different question
// from this one.
// ---------------------------------------------------------------------------

/** How many recent attempts the console shows. Two rows of history, no more. */
const ATTEMPT_HISTORY_LIMIT = 8;

/**
 * One image attempt as the operator sees it.
 *
 * `status` is DERIVED on every read (lib/image-attempt.ts), never stored — see
 * 0088's header for why a status column would be a sixth fact that drifts from
 * the five that already exist.
 */
/**
 * The signed-in account's recent image attempts, newest first — what the
 * console shows when the operator comes back.
 *
 * The SESSION client, so runs_select (0085: `runs.user_id = auth.uid()`) is an
 * independent gate beneath the explicit user_id filter. `idempotency_key is not
 * null` is what makes this the Image Generator's own attempts and not every run
 * the account has ever produced — the same predicate the stale sweep uses to
 * recognise its own rows.
 */
export async function loadPersonalImageAttempts(): Promise<ImageAttempt[]> {
  const { user } = await requireUser();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("runs")
    .select(ATTEMPT_COLUMNS)
    .eq("user_id", user.id)
    .is("project_id", null)
    .not("idempotency_key", "is", null)
    .order("created_at", { ascending: false })
    .limit(ATTEMPT_HISTORY_LIMIT);

  if (error) throw new Error(`Failed to load image attempts: ${error.message}`);

  return Promise.all((data ?? []).map((row) => toImageAttempt(supabase, user.id, row)));
}

/** Finishes an abandoned attempt — see reconcileImageAttemptFor (lib/image-generation.ts). */
export async function reconcilePersonalImageAttempt(runId: string): Promise<ImageAttempt> {
  // Not rate-limited: the image panel polls this every 5s per unfinished image,
  // and it is an owner-scoped read that spends nothing.
  const { user } = await requireUser({ rateLimit: false });
  return reconcileImageAttemptFor(createClient, user.id, runId);
}
