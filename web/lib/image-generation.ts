// The Image Generator's guard-free core, shared by the Server Actions in
// actions/image-generator.ts (session guards) and /api/v1/images (API token).
//
// NOT "use server", and that is the security property: every export of a
// "use server" module is a callable endpoint, and nothing in here authorizes
// anyone — `owner` / `userId` is a fact each CALLER has already established
// through its own guard (requireUser, requireProject, requireApiToken). See
// actions/image-generator.ts's header for the money path's design.
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AccountCapProfile } from "@/lib/spend";
import {
  checkImageTask,
  generateImage,
  modelForImageArgs,
  ImageGenerationError,
  KieTaskPendingError,
} from "@/lib/kie";
import {
  imageAttemptReason,
  imageAttemptStatus,
  isImageAttemptUnfinished,
  type ImageAttemptStatus,
} from "@/lib/image-attempt";
import {
  blocksInline,
  getImageModel,
  imageCostUsd,
  IMAGE_MODELS,
  kieIdForImageModel,
  observedSecondsForPath,
  type ImageModelDescriptor,
} from "@/lib/models";
import { getKieAccountBalanceUsd } from "@/lib/kie-balance";
import { SEEDREAM_PRO_ID } from "@/lib/seedream";
import { isDev } from "@/lib/mode";
import { assertKieBalanceCoversEstimate, resolveImageAttemptCeilings } from "@/lib/spend";
import {
  attachKieTaskId,
  attachRunAsset,
  holdRunBillingUnknown,
  isRunInFlight,
  releaseRun,
  reserveImageAttempt,
  settleRunSuccess,
  sweepStaleImageReservations,
} from "@/lib/runs";
import { createAdminClient } from "@/lib/supabase/server";
import { removeStorageObjects, signedUrl, uploadFromUrl } from "@/lib/storage";
import { guardResult } from "@/lib/action-result";
import { isImageAspectRatio } from "@/lib/image-aspect-ratios";
import { BASE_IMAGE_RESOLUTION, isImageResolution } from "@/lib/image-resolutions";
import { saveGeneratedImageAsElement } from "@/lib/generated-image-element";
import { descriptionFor, substituteElementTags, tagsInOrder } from "@/lib/element-tags";
import type { Database } from "@/types/db";

/**
 * A stored image, returned so the form can preview it immediately without
 * waiting for the history list to refetch.
 */
export type GeneratedImage = {
  assetId: string;
  /**
   * Signed URL for preview only, and short-lived by construction. The history
   * list mints its own; do not persist this one or hand it to a download
   * control that may be clicked long after render.
   */
  url: string;
  createdAt: string;
};

/**
 * Every outcome the operator is meant to read.
 *
 * Refusals are RETURNED, never thrown: React redacts anything thrown from a
 * Server Action in production down to "Minified React error #441", which would
 * turn "You have reached this week's limit" into nothing an operator can act on
 * (see lib/action-result.ts for the full reasoning). Genuine surprises -- a
 * Postgres error, a null nobody expected -- stay thrown, because correct
 * redaction is the right answer for those.
 *
 * The mirrored `?: undefined` fields are the idiom from lib/action-result.ts:
 * they let a caller read `.error` or `.image` off the union without narrowing.
 */
export type GenerateProjectImageResult =
  | {
      image: GeneratedImage;
      error?: undefined;
      keyExhausted?: undefined;
      pendingRunId?: undefined;
    }
  /**
   * `keyExhausted` says the submitted idempotency key can never succeed again,
   * so the next press must mint a fresh one (0088).
   *
   * It exists because holding a key across presses — which is what stops a
   * navigate-away-and-return from charging twice — would otherwise trap the
   * operator: an attempt that reserved a row and then failed leaves that key
   * permanently resolving to a settled, imageless run, and every later press
   * would be refused as a duplicate of it. The client cannot tell that case
   * from "still processing" without matching on message text, which is exactly
   * the fragile check lib/action-result.ts exists to avoid. So the server, which
   * knows, says so in a field.
   *
   * Absent means KEEP the key. Every refusal that happens before a row is
   * reserved — validation, a cap block, an empty vendor balance — leaves the key
   * unused and perfectly reusable.
   */
  | { error: string; image?: undefined; keyExhausted?: boolean; pendingRunId?: undefined }
  /**
   * Submitted to kie and still drawing; the KEY IS KEPT. Only the personal
   * generator returns this (`handOff`): the form then waits by calling
   * reconcilePersonalImageAttempt(pendingRunId) on an interval, and re-submits
   * the same key once it completes to get the image back free (the duplicate
   * branch below).
   *
   * Why not block here: Next.js runs a page's Server Actions one at a time, so a
   * generate holding its request for up to KIE_POLL_BUDGET_MS made every other
   * action on the page — Save to Elements, delete — wait behind it.
   */
  | { pendingRunId: string; image?: undefined; error?: undefined; keyExhausted?: undefined };

// Nothing branches on the wording of the messages below -- callers render
// `result.error` as text.

/**
 * Refused because an attempt with this idempotency key is still running.
 *
 * Not an error in the sense that something broke -- the first request is doing
 * exactly what was asked. Resubmitting cannot help and must not charge again.
 */
/**
 * What a DELIBERATE hand-off says, as opposed to a request that waited and gave
 * up (ALREADY_PROCESSING_MESSAGE below).
 *
 * Both arrive as KieTaskPendingError and both leave the attempt running, but
 * only one of them is a surprise. Telling someone their slow model "is still
 * processing" after it returned in two seconds reads as a fault; naming the
 * measured duration and where the picture will appear reads as the design.
 *
 * A function rather than a const because it names the model and its measured
 * time — and because a "use server" file may only export async functions, this
 * stays module-private like every other message here.
 */
function handedOffMessage(model: ImageModelDescriptor): string {
  const seconds = observedSecondsForPath(model, true);
  const about = seconds ? ` (about ${Math.round(seconds)}s)` : "";
  return (
    `${model.label} takes longer than this page will wait${about}, so it is running in the background. ` +
    `It will appear under Runs when kie finishes — do not press Generate again, that starts a second paid image.`
  );
}

const ALREADY_PROCESSING_MESSAGE =
  "That request is still processing — wait for it to finish rather than pressing Generate again.";

/**
 * Refused because this key already settled WITHOUT producing an image.
 *
 * Narrower than it used to be. It once covered every settled attempt, because
 * no durable runs<->assets link existed and the image therefore could not be
 * identified from the attempt. 0088 added runs.asset_id, so a key whose attempt
 * succeeded now returns that picture instead of this message, and what is left
 * here is the genuinely empty case: an attempt that settled failed, was held as
 * billing-unknown, or lost its image to a later delete.
 */
const ALREADY_COMPLETED_MESSAGE =
  "That request already completed — refresh the image history to see it.";

/**
 * Upper bound on a prompt, enforced before anything is reserved.
 *
 * Not a vendor limit -- kie's own is higher and undocumented. This is a guard
 * against a paste of an entire script arriving as one prompt: the cost is the
 * same either way, so a runaway input spends real money on something nobody
 * meant to submit. Generous enough that no deliberate prompt hits it.
 */
const MAX_PROMPT_LENGTH = 2000;

/**
 * At most this many tagged references reach the vendor.
 *
 * nano-banana-edit accepts several, and the character path already sends two
 * (actions/character.ts). The cap is about TIME, not correctness: the edit
 * model was measured at 70s against this file's 100s poll budget, and every
 * extra reference is more work inside a window that platform proxies already
 * cut somewhere in the 30-100s range. Three is enough to say "this person,
 * holding this product, in this place" and still finish.
 */
const MAX_REFERENCE_IMAGES = 3;

interface ResolvedPrompt {
  /** Tag descriptions substituted in; what actually gets sent. */
  prompt: string;
  /** Signed URLs for the tagged elements that are pictures, in prompt order. */
  refImageUrls: string[];
  /** Tags naming no saved element at all — a rename or a typo. */
  unresolved: string[];
}

/**
 * Turns "@jen holding the bottle" into a prompt plus the pictures behind those
 * tags.
 *
 * ONE tag, two effects, deliberately: it pastes the element's description into
 * the prompt AND attaches that element's image as a conditioning reference.
 * Either alone is worse -- description without the picture loses the likeness,
 * picture without the description loses everything the operator wrote about it.
 *
 * THE AUTHORIZATION THAT MATTERS: elements are looked up `where user_id =
 * userId` and nowhere else. Names are not unique across accounts, so resolving
 * a tag globally would let anyone reference a stranger's saved photo by
 * guessing its name -- and it would be invisible, because the only evidence
 * would be a better image than they should have got.
 *
 * Fail-soft on a lookup failure, matching resolveElementTags in actions/ugc.ts:
 * an unsubstituted tag is a worse image, not a lost one, and refusing here
 * would turn a transient read error into a refusal the operator cannot act on.
 */
export async function resolvePromptReferences(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  prompt: string,
): Promise<ResolvedPrompt> {
  // Most prompts name nothing. Costs two round trips only when one does.
  if (!prompt.includes("@")) return { prompt, refImageUrls: [], unresolved: [] };

  const { data: elements, error } = await admin
    .from("elements")
    .select("name, description, ai_description, asset_id")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (error || !elements) return { prompt, refImageUrls: [], unresolved: [] };

  const byName = new Map(elements.map((e) => [e.name.toLowerCase(), e]));
  const tags = tagsInOrder(prompt);
  const unresolved = tags.filter((t) => !byName.has(t.toLowerCase()));

  // ONE assets LOOKUP, covering every element this user owns, not just the
  // ones tagged in this prompt -- reordered ahead of the descriptions loop
  // below rather than added as a second query, because descriptions now
  // needs `kind` for the SAME reason refImageUrls already did (see the
  // comment on that filter): elements.ai_description used to be an
  // image-only concern, so building `descriptions` from every element with
  // no kind check was safe. It stopped being safe the moment an audio
  // element could carry a description at all (lib/kie-audio-describe.ts) --
  // without this, an @voice1 tag in an IMAGE prompt would get replaced with
  // prose about a voice, a reference that cannot condition an image and
  // would silently corrupt the prompt instead.
  const assetIdsAll = elements.map((e) => e.asset_id).filter((id): id is string => Boolean(id));
  const { data: allAssets } =
    assetIdsAll.length > 0
      ? await admin.from("assets").select("id, storage_key, kind").in("id", assetIdsAll)
      : { data: [] as { id: string; storage_key: string; kind: string }[] };
  const assetById = new Map((allAssets ?? []).map((a) => [a.id, a]));

  // Descriptions first -- substitution is independent of whether the element
  // also has a usable picture, and an element with no description still
  // attaches as a reference. Read kind off `assets`, never the element's
  // category label: a picture saved before 0081 is filed as "character" and
  // is still a picture, and a sound file cannot condition an image at all --
  // same rule ElementTag.assetKind (lib/elements.ts) applies, extended here
  // to the text half of the substitution, not only the image half.
  const descriptions = new Map<string, string>();
  for (const element of elements) {
    const asset = element.asset_id ? assetById.get(element.asset_id) : undefined;
    if (asset?.kind === "audio") continue;
    const text = descriptionFor(element);
    if (text) descriptions.set(element.name.toLowerCase(), text);
  }

  // In prompt order, de-duplicated: "@jen and @jen again" is one reference,
  // and the order the operator wrote is the order the vendor is given.
  const assetIds: string[] = [];
  for (const tag of tags) {
    const element = byName.get(tag.toLowerCase());
    if (element?.asset_id && !assetIds.includes(element.asset_id)) {
      assetIds.push(element.asset_id);
    }
  }

  const refImageUrls: string[] = [];
  for (const assetId of assetIds) {
    if (refImageUrls.length >= MAX_REFERENCE_IMAGES) break;
    const asset = assetById.get(assetId);
    if (!asset || asset.kind === "audio") continue;
    // No transform: this URL feeds the vendor, not an <img>. A downscaled,
    // recompressed thumbnail is a worse reference — same reasoning as
    // actions/frames.ts.
    refImageUrls.push(await signedUrl(asset.storage_key));
  }

  return { prompt: substituteElementTags(prompt, descriptions), refImageUrls, unresolved };
}

/**
 * WHO an image and its charge belong to, and the one thing every paid path
 * below is parameterised on.
 *
 * `projectId === null` is the personal shape (0085_personal_image_generator.
 * sql): the asset carries `user_id`, the run carries `user_id`, and every
 * per-user spend read resolves the owner as coalesce(runs.user_id,
 * projects.user_id) so the charge counts against the same weekly allowance a
 * project-backed one would. A non-null `projectId` is the pre-0085 shape,
 * unchanged in every respect.
 *
 * `userId` is ALWAYS the account that owns the work -- for the project shape
 * that is the project owner, which requireProject has already proved is the
 * caller. It is never read off a form field: the whole point of binding the
 * project id server-side (see generateProjectImage's own note) is that a
 * forged field cannot redirect a charge, and an owner field would reopen
 * exactly that.
 */
export interface ImageOwner {
  userId: string;
  profile: AccountCapProfile;
  projectId: string | null;
}

/**
 * WHERE an image lands — the half of ImageOwner that the storing tail needs.
 *
 * Separated because settleAndStore and imageForRun price nothing and reserve
 * nothing: handing them a whole ImageOwner would mean the recovery path had to
 * invent a cap profile it has no use for, and a fabricated `profile` sitting in
 * the money file is exactly the kind of thing a later reader trusts.
 */
type ImageDestination = Pick<ImageOwner, "userId" | "projectId">;

/** Where a change to this owner's images shows up. */
function imagePathFor(owner: ImageDestination): string {
  return owner.projectId ? `/images/${owner.projectId}` : "/image-generator";
}

const BLOCKED_MESSAGES = {
  global: "The company-wide image budget is used up.",
  weekly: "You have reached your weekly allowance. Request more from the sidebar to keep going.",
  daily: "You have reached today's limit. It resets at midnight Manila time.",
  hourly:
    "You have reached your hourly image limit. Earlier spend will free up over the next hour.",
} as const;

/**
 * The image an attempt produced, or null if it produced none (0088).
 *
 * SCOPED TO THE OWNER on the asset, not just the run: the run id reaches this
 * function from reserve_image_attempt, which is trustworthy, but the asset is
 * still re-checked against the same owner the caller was guarded as, so this
 * can never sign a picture belonging to somebody else. The personal shape
 * narrows on `project_id is null` for the reason resolvePromptReferences does —
 * the two namespaces must not be reachable from each other by a leaked id.
 *
 * Mints a FRESH signed URL every call. The stored durable fact is the asset id
 * and its storage key; a signed URL expires, so persisting one would hand the
 * operator a preview that works until it silently does not.
 */
async function imageForRun(owner: ImageDestination, runId: string): Promise<GeneratedImage | null> {
  const admin = createAdminClient();
  const { data: run } = await admin.from("runs").select("asset_id").eq("id", runId).maybeSingle();
  if (!run?.asset_id) return null;

  const scoped = admin
    .from("assets")
    .select("id, created_at, storage_key")
    .eq("id", run.asset_id)
    .eq("kind", "generated_image")
    .is("deleted_at", null);
  const { data: asset } = await (
    owner.projectId
      ? scoped.eq("project_id", owner.projectId)
      : scoped.is("project_id", null).eq("user_id", owner.userId)
  ).maybeSingle();
  if (!asset) return null;

  return {
    assetId: asset.id,
    url: await signedUrl(asset.storage_key),
    createdAt: asset.created_at,
  };
}

/**
 * Generate one image, charging the owner's allowance. The shared body behind
 * both entry points below; it performs NO authorization of its own and must
 * never be exported — `owner` is a fact its caller has already established
 * through a guard, exactly as lib/allowance-grants.ts's revokeActiveGrantsFor
 * relies on its callers' requireAdmin.
 *
 * TWO THINGS THAT MUST NOT CHANGE, both enforced by tests rather than review:
 *
 * 1. generateProjectImage guards with the STRICT, owner-only `requireProject`,
 *    while the page it lives on guards with the permissive
 *    `requireProjectReadable` so a non-owning admin can look. That combination
 *    is only safe because the action is handed to the client as
 *    `generateProjectImage.bind(null, id)` and runs on submit. It must NEVER
 *    be awaited in a page's module body: lib/guard-seam.test.ts sweeps for
 *    exactly that shape, because a readable door in front of a strict action
 *    notFound()s an admin out of a page they were just admitted to,
 *    mid-render. /image-generator has no such seam — one guard, one shape.
 *
 * 2. For the PROJECT shape, ownership is checked at the entry point AND
 *    derived independently inside the RPC from the locked project row. The
 *    second is not redundant: it is what makes the function safe on its own
 *    terms, without depending on this call site. The PERSONAL shape has no
 *    project row to derive from, so the RPC takes the owner as an argument —
 *    see 0085's section 5 for why that is acceptable there and would not have
 *    been here.
 *
 * @param formData `prompt` (string) and `idempotencyKey` (string, one per
 *                 Generate press, stable across retries of that same press).
 */
export async function generateImageFor(
  owner: ImageOwner,
  formData: FormData,
  // Submit and return { pendingRunId } instead of waiting on kie. Only for a
  // caller whose page can finish the attempt (reconcilePersonalImageAttempt).
  handOff = false,
): Promise<GenerateProjectImageResult> {
  const prompt = String(formData.get("prompt") ?? "").trim();
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();

  if (!prompt) {
    return { error: "Describe the image you want before generating." };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      error: `That prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT_LENGTH}.`,
    };
  }
  if (!idempotencyKey) {
    // The form always sends one. A missing key means a caller this action does
    // not know about, and proceeding would forfeit the only protection against
    // a double charge -- so refuse rather than mint one here.
    return { error: "This request was missing its submission key. Reload the page and try again." };
  }

  const admin = createAdminClient();

  // @tags resolve to BOTH the element's description (pasted into the prompt)
  // and its picture (attached as a conditioning reference). Done before the
  // estimate because it decides which model runs.
  const resolved = await resolvePromptReferences(admin, owner.userId, prompt);

  // CHAINING. The previous beat's image, conditioning this one, so a sequence
  // reads as one moment continuing rather than three unrelated pictures of a
  // similar man. Sent by the client, which drives the chain one beat at a time
  // — see image-generator-form.tsx for why the browser orchestrates this
  // instead of the server looping (each beat must finish inside its own
  // request, or the whole batch dies on the platform's 30-100s cut).
  //
  // SCOPED TO THIS OWNER, and that is the security check, not a tidiness
  // one: the id arrives from the browser, and without this filter anyone could
  // condition their generation on any asset id they could guess or had ever
  // seen — another account's image, reached through their own project. RLS is
  // not the backstop here because this uses the admin client.
  //
  // The personal shape narrows on `user_id` AND `project_id is null`, not
  // user_id alone: user_id is set on a project-backed run but NOT on a
  // project-backed asset, so the null check is what keeps the two namespaces
  // from being reachable from each other by an id that leaked between them.
  const chainFromAssetId = String(formData.get("chainFromAssetId") ?? "").trim();
  let chainUrl: string | null = null;
  if (chainFromAssetId) {
    const scoped = admin
      .from("assets")
      .select("storage_key")
      .eq("id", chainFromAssetId)
      .eq("kind", "generated_image")
      .is("deleted_at", null);
    const { data: previous } = await (
      owner.projectId
        ? scoped.eq("project_id", owner.projectId)
        : scoped.is("project_id", null).eq("user_id", owner.userId)
    ).maybeSingle();
    // Missing is not fatal. A deleted or foreign id means this beat generates
    // without continuity, which is a weaker picture; refusing would throw away
    // a sequence mid-run over a reference that is merely absent.
    if (previous) chainUrl = await signedUrl(previous.storage_key);
  }

  // Previous frame FIRST: it is the dominant conditioning for continuity, and
  // the tagged references are supporting identity. Capped as a whole, so a
  // chained beat with three tags does not quietly send four images.
  const refImageUrls = (
    chainUrl ? [chainUrl, ...resolved.refImageUrls] : resolved.refImageUrls
  ).slice(0, MAX_REFERENCE_IMAGES);

  // The operator's chosen model (lib/models.ts's IMAGE_MODELS), or the default.
  const imageModel = getImageModel(formData.get("imageModel"));
  if (imageModel.costUsd === null) {
    return {
      error: `${imageModel.label} is awaiting pricing verification and cannot generate yet.`,
    };
  }
  const kieId = kieIdForImageModel(imageModel, refImageUrls.length > 0);

  // REFUSED, not quietly downgraded. A model with no reference-conditioned
  // variant is handed image_urls and IGNORES them (lib/kie.ts's header), so
  // sending it anyway would charge for a picture that used none of the
  // references — and nothing in the result would say so. Silently swapping to
  // a model the operator did not pick would be its own surprise, on the bill.
  if (kieId === null) {
    if (imageModel.referenceDisabledReason) return { error: imageModel.referenceDisabledReason };
    // Name the ACTUAL reference, not a generic one. A sequence beat carries a
    // chained reference even when the prompt has no @tags at all, and telling
    // someone to "remove the @tags" they never wrote sends them looking for a
    // mistake that is not there. Which model to pick is the useful half.
    const alternative = IMAGE_MODELS.find((m) => m.editId !== null && m.costUsd !== null)?.label;
    const because = chainUrl
      ? "continuing a sequence needs the previous image as a reference"
      : "the prompt names references with @tags";
    return {
      error:
        `${imageModel.label} cannot use references, and ${because}. ` +
        (alternative ? `Switch to ${alternative}` : "Switch to a model that supports references") +
        (chainUrl ? " to generate a sequence." : ", or remove the @tags."),
    };
  }

  // modelForImageArgs with an explicit id: it is what generateImage calls, so
  // the model recorded on runs is the one actually attempted, including on the
  // failure path where generateImage throws before returning anything.
  const aspectRatio = formData.get("aspectRatio") ?? "9:16";
  if (!isImageAspectRatio(aspectRatio) || !imageModel.aspectRatios.includes(aspectRatio)) {
    return { error: "Choose a supported aspect ratio before generating." };
  }
  // THE PIXEL TIER. Checked against what kie documents for THIS model, because
  // a field kie does not know is dropped while the render is still billed.
  const resolution = formData.get("resolution") ?? BASE_IMAGE_RESOLUTION;
  if (
    !isImageResolution(resolution) ||
    (resolution !== BASE_IMAGE_RESOLUTION && !imageModel.resolutions?.includes(resolution))
  ) {
    return { error: "Choose a supported resolution before generating." };
  }
  // A tier nobody has been billed at is not for sale — the same rule as a
  // model with no price (above).
  const estimateUsd = imageCostUsd(imageModel, resolution);
  if (estimateUsd === null) {
    return {
      error: `${imageModel.label} at ${resolution} is awaiting pricing verification and cannot generate yet.`,
    };
  }
  const args = { prompt: resolved.prompt, refImageUrls, model: kieId, aspectRatio, resolution };
  const model = modelForImageArgs(args);

  // MEASURED per model, not a flat rate — see IMAGE_MODELS. This figure is what
  // the reservation holds and what the caps compare against, so it has to be
  // the same number the UI quoted.

  // OUTSIDE the transaction, and first: an external HTTP call cannot live in a
  // Postgres function, and asking first means an unfunded account never writes
  // a reservation it would only have to release.
  //
  // Skipped in development for the same reason assertWithinSpendCaps skips it:
  // a mocked generation costs nothing, so a real drained balance would refuse a
  // call that was never going to spend. A failed READ also skips -- see
  // getKieAccountBalanceUsd, which returns null rather than throwing.
  // Seedream bills BytePlus, not kie (lib/byteplus-image.ts).
  if (!isDev() && estimateUsd > 0 && model !== SEEDREAM_PRO_ID) {
    const balanceUsd = await getKieAccountBalanceUsd();
    if (balanceUsd !== null) {
      const refusal = guardResult(() => assertKieBalanceCoversEstimate(balanceUsd, estimateUsd));
      if (refusal) return refusal;
    }
  }

  // Crash recovery, without a cron: a previous generation that died mid-flight
  // is still counting its estimate, and this is the natural moment to settle it.
  // Deliberately not fatal -- failing to tidy up must not refuse a request that
  // is otherwise fine.
  const scope = owner.projectId
    ? ({ projectId: owner.projectId } as const)
    : ({ projectId: null, userId: owner.userId } as const);
  try {
    await sweepStaleImageReservations(scope);
  } catch (error) {
    console.error(`generateImageFor: sweep failed for ${JSON.stringify(scope)}`, error);
  }

  const ceilings = await resolveImageAttemptCeilings(owner.userId, owner.profile);
  const reservation = await reserveImageAttempt({
    projectId: owner.projectId,
    userId: owner.userId,
    idempotencyKey,
    estimateUsd,
    model,
    ...ceilings,
  });

  if (reservation.outcome === "blocked") {
    const globalReset =
      ceilings.globalCapPeriod === "weekly"
        ? " It resets on Monday."
        : " It resets at midnight Manila time.";
    const message =
      reservation.blockedBy === "global"
        ? `${BLOCKED_MESSAGES.global}${globalReset}`
        : BLOCKED_MESSAGES[reservation.blockedBy];
    return { error: message };
  }
  // A KEY THAT HAS BEEN HERE BEFORE. Since 0088 this is no longer only a
  // refusal: an attempt that already succeeded can hand back the picture it
  // produced, free, because runs.asset_id now says which one that is.
  //
  // That is what makes recovery and sequence resumption safe. The operator who
  // navigated away and came back presses Generate on the restored draft with
  // the SAME key, and gets their image instead of a second charge; a resumed
  // sequence replays every beat it already paid for and only draws the ones it
  // has not. Without this the duplicate branch could only refuse, so the client
  // had to avoid resubmitting by never reusing a key — which is exactly how the
  // double charge got in.
  if (reservation.outcome === "duplicate") {
    const existing = await imageForRun(owner, reservation.runId);
    if (existing) return { image: existing };
    const { data: previous, error: previousError } = await createAdminClient()
      .from("runs")
      .select("kie_task_id")
      .eq("id", reservation.runId)
      .maybeSingle();
    if (previousError)
      return { error: "Could not check the previous attempt. Please try checking again." };
    if (previous?.kie_task_id) {
      let check;
      try {
        check = await checkImageTask(previous.kie_task_id);
      } catch {
        return {
          error:
            "Could not check kie. Keep this request and try again; no new generation was submitted.",
        };
      }
      if (check.state === "pending") {
        return handOff
          ? { pendingRunId: reservation.runId }
          : { error: ALREADY_PROCESSING_MESSAGE };
      }
      if (check.state === "success") {
        return settleAndStore(owner, reservation.runId, check);
      }
      return { error: `kie reported failure: ${check.message}`, keyExhausted: true };
    }
    // In flight: the key is alive and must be kept, or the next press starts a
    // second paid attempt beside the one already running. Settled without an
    // image: it failed or was held, and this key can never produce anything.
    if (await isRunInFlight(reservation.runId)) {
      return handOff ? { pendingRunId: reservation.runId } : { error: ALREADY_PROCESSING_MESSAGE };
    }
    return { error: ALREADY_COMPLETED_MESSAGE, keyExhausted: true };
  }

  const runId = reservation.runId;

  // The prompt as typed, @tags intact, for the image viewer's details panel
  // (0116). Never fatal: a missing prompt is a blank panel, not a lost image.
  const { error: promptError } = await admin.from("runs").update({ prompt }).eq("id", runId);
  if (promptError)
    console.error(`generateImageFor: prompt not recorded for run ${runId}`, promptError);

  // THE DISCRIMINATOR BETWEEN RELEASE AND HOLD, and why it is this and not the
  // error message.
  //
  // lib/kie.ts throws one ImageGenerationError for every failure and says
  // plainly that telling them apart by string is the fragile check the typed
  // error exists to avoid. What IS reliable is whether kie ever handed back a
  // task id: before createTask returns there is no submission to bill, and
  // after it there is one that may have been. That is the same signal the Go
  // side uses (see store.MarkFailed, quoted in lib/runs.ts's costUsd doc).
  //
  // So a failure with no task id RELEASES -- evidence of no charge -- and a
  // failure after one HOLDS at the estimate. Note MODE=development returns
  // before createTask, so a mocked failure releases, correctly: nothing was
  // ever submitted.
  let submitted = false;

  // BLOCK, OR SUBMIT AND HAND OFF.
  //
  // A model measured slower than the poll budget is not waited on: blocking
  // 100s to rediscover that a kie path takes 149 costs a
  // server worker, the operator's time, and nothing else — the timeout was
  // going to fire either way. Passing 0 makes generateImage submit, persist the
  // task id, and return at once; the attempt panel finishes it by task id.
  //
  // The measured number is the whole gate, so an unmeasured model still blocks
  // (see blocksInline) rather than being quietly moved to a path nobody has
  // watched work.
  const inline = !handOff && blocksInline(imageModel, refImageUrls.length > 0);

  let generated;
  try {
    generated = await generateImage({
      ...args,
      pollBudgetMs: inline ? undefined : 0,
      onTaskCreated: async (taskId) => {
        submitted = true;
        await attachKieTaskId(runId, taskId);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // WE STOPPED WAITING; KIE DID NOT STOP DRAWING.
    //
    // This branch used to fall through to holdRunBillingUnknown below, and that
    // is what lost the image: a held row is SETTLED, settled is terminal, and
    // isImageAttemptUnfinished therefore reads false — so the attempt panel,
    // whose entire job is to finish exactly this attempt, stopped asking kie one
    // tick after the timeout. The account was charged for a picture nothing ever
    // collected. With a measured 149s generation against a 100s budget that is
    // the ordinary outcome, not an edge case.
    //
    // So: leave the row UNSETTLED. The estimate stays counted meanwhile (only
    // releaseRun ever frees money, and nothing here has evidence to free any),
    // the panel keeps calling reconcilePersonalImageAttempt until kie reaches a
    // terminal state — settling the real cost and storing the image if it lands
    // — and sweepStaleImageReservations is still the backstop that holds the row
    // if it never does.
    //
    // keyExhausted is deliberately ABSENT, which means KEEP the key. It is the
    // handle that makes the next press resolve to this in-flight attempt through
    // the duplicate branch above instead of submitting a second paid task.
    if (error instanceof KieTaskPendingError) {
      if (handOff) return { pendingRunId: runId };
      return { error: inline ? ALREADY_PROCESSING_MESSAGE : handedOffMessage(imageModel) };
    }

    if (submitted) {
      await holdRunBillingUnknown(runId, message);
    } else {
      await releaseRun(runId, message);
    }
    // The row is reserved and now settled either way, so this key is spent.
    return {
      error:
        error instanceof ImageGenerationError
          ? message
          : "The image could not be generated. Try again in a moment.",
      keyExhausted: true,
    };
  }

  const stored = await settleAndStore(owner, runId, generated);
  if (stored.error !== undefined) return stored;

  revalidatePath(imagePathFor(owner));
  return stored;
}

/**
 * Settle the charge, keep the picture, and point the attempt at it.
 *
 * ONE copy, called by the blocking generate above and by the recovery path
 * below. This file's header says a second copy of the money sequence is the
 * shape it must never grow, and this tail is the half where that matters most:
 * five failure branches that have to stay in agreement about what has been
 * charged and what has been kept.
 *
 * Does NOT revalidate — the two callers refresh different things, and a read
 * action that revalidated its own page would loop.
 */
async function settleAndStore(
  owner: ImageDestination,
  runId: string,
  generated: { url: string; costUsd: number | null; vendor?: string },
): Promise<GenerateProjectImageResult> {
  const admin = createAdminClient();

  // reserve_image_attempt writes vendor 'kie' for every image; correct it when another
  // vendor served the call. Spend categories key on the model, so they are unaffected.
  if (generated.vendor && generated.vendor !== "kie") {
    const { error: vendorError } = await admin
      .from("runs")
      .update({ vendor: generated.vendor })
      .eq("id", runId);
    if (vendorError) console.error(`settleAndStore: vendor not recorded for ${runId}`, vendorError);
  }

  // Settle BEFORE storing. The charge is real the moment kie returns an image,
  // whether or not we manage to keep the file, and a settlement that waited for
  // a successful upload would lose the true cost every time storage failed.
  //
  // costUsd is kie's own reported charge and overwrites the estimate; null when
  // kie reported none, which settleRunSuccess writes as-is rather than guessing.
  await settleRunSuccess(runId, generated.costUsd);

  let storageKey: string;
  try {
    ({ storageKey } = await uploadFromUrl(
      owner.projectId
        ? { url: generated.url, projectId: owner.projectId, kind: "generated_image" }
        : { url: generated.url, userId: owner.userId, kind: "generated_image" },
    ));
  } catch (error) {
    console.error(`generateProjectImage: storage upload failed for run ${runId}`, error);
    // Honest, because the alternative is worse: the charge is settled and
    // visible in /spend, and pressing Generate again is a second real charge.
    // Saying "try again" without saying that would hide a cost from the person
    // paying it.
    return {
      error:
        "The image was generated and charged, but could not be saved. Generating again will charge again.",
      keyExhausted: true,
    };
  }

  // Exactly one owner column, never both. Unlike a `runs` row -- where
  // reserve_image_attempt writes user_id on both shapes so an in-flight
  // attempt survives its project being deleted -- an asset has nothing to
  // survive: deleting a project cascades its assets away with it, and a row
  // carrying both would then claim a personal image that no longer exists.
  const { data: asset, error: assetError } = await admin
    .from("assets")
    .insert({
      project_id: owner.projectId,
      user_id: owner.projectId ? null : owner.userId,
      kind: "generated_image",
      storage_key: storageKey,
    })
    .select("id, created_at")
    .single();

  if (assetError || !asset) {
    // The row is what makes the object findable; without it the upload is an
    // orphan nothing will ever reference or clean up.
    await removeStorageObjects([storageKey]).catch((cleanupError) => {
      console.error(`generateProjectImage: orphan cleanup failed for ${storageKey}`, cleanupError);
    });
    throw new Error(
      `Failed to record generated image for ${owner.projectId ? `project ${owner.projectId}` : `user ${owner.userId}`}: ${assetError?.message ?? "no row returned"}`,
    );
  }

  // LAST, and never fatal (0088). The attempt now names the image it produced,
  // which is the whole basis of the recovery flow: without it, an operator who
  // navigated away has a settled charge and no way to find what it bought.
  //
  // A COMPARE-AND-SWAP since recovery became a button an operator can press
  // twice (attachRunAsset, lib/runs.ts). The blocking generate path above always
  // wins it — its reservation is brand new and its asset_id is null — so nothing
  // changes there. What it protects is two concurrent recoveries of the SAME
  // attempt: both read the finished task from kie (a free GET, so no second
  // charge either way), both upload, and both insert. Only one may be the
  // attempt's image.
  const link = await attachRunAsset(runId, asset.id);

  if (link === "taken") {
    // We lost. Everything this call made is a duplicate of what the winner
    // already linked, so remove the duplicate row before its object and
    // return the winner's image. Duplicates do not belong in Bin.
    // The operator sees one picture either way, and the charge was settled once:
    // settleRunSuccess writes the same vendor-reported figure whichever call
    // gets there first, so there is nothing to undo on the money side.
    const { error: dropError } = await admin.from("assets").delete().eq("id", asset.id);
    if (dropError) {
      console.error(`settleAndStore: duplicate asset ${asset.id} could not be removed`, dropError);
    } else {
      await removeStorageObjects([storageKey]).catch((cleanupError) => {
        console.error(
          `settleAndStore: duplicate object cleanup failed for ${storageKey}`,
          cleanupError,
        );
      });
    }

    const winner = await imageForRun(owner, runId);
    // Only if the winner's asset has itself gone missing between the two reads.
    // Falling back to our own (now deleted) row would hand back a broken card.
    if (!winner) {
      return {
        error: "The image was recovered by another request. Reload to see it.",
        keyExhausted: true,
      };
    }
    revalidatePath(imagePathFor(owner));
    return { image: winner };
  }

  // FILED AS A PRIVATE ELEMENT, so the picture is @-taggable at once. Never
  // fatal: the image is already stored, charged and linked, and a missing
  // element only costs a "Save as element" press.
  try {
    await saveGeneratedImageAsElement(admin, owner.userId, asset.id);
    revalidatePath("/elements");
  } catch (error) {
    console.warn(`settleAndStore: could not file ${asset.id} as an element`, error);
  }

  // "unknown" falls through with the image kept. The bookkeeping write failed,
  // which says nothing about whether another writer exists — and deleting a
  // real, paid-for picture on that guess is the one mistake with no way back.
  // An unlinked asset is still in the operator's history; a deleted one is gone.
  revalidatePath(imagePathFor(owner));

  return {
    image: {
      assetId: asset.id,
      url: await signedUrl(storageKey),
      createdAt: asset.created_at,
    },
  };
}

export type ImageAttempt = {
  runId: string;
  idempotencyKey: string | null;
  createdAt: string;
  status: ImageAttemptStatus;
  model: string;
  /**
   * kie's task id, whenever the attempt has one.
   *
   * It used to be blanked for every status except billing_unknown, on the
   * reasoning that only a human about to re-pay needs to look a task up on
   * kie's dashboard. Recovery made it load-bearing instead: the panel's
   * "Check status / Recover image" button is rendered off this field, so
   * blanking it hides the only control that can collect an image the account
   * has already been charged for.
   */
  kieTaskId: string | null;
  /** Vendor or system reason, with the billing-unknown marker stripped. */
  reason: string | null;
  /** Freshly signed on every read; never persisted. Null unless completed. */
  image: GeneratedImage | null;
  /** runs.cost_usd: what this attempt is held at, null when nothing was billed. */
  costUsd: number | null;
};

type AttemptRow = {
  id: string;
  idempotency_key: string | null;
  created_at: string;
  model: string;
  error: string | null;
  settled_at: string | null;
  kie_task_id: string | null;
  asset_id: string | null;
  cost_usd: number | null;
};

/**
 * Shapes one `runs` row into the attempt the client renders, minting a fresh
 * signed URL when the attempt produced an image.
 *
 * The asset is read through the SESSION client alongside the run, so RLS
 * (assets_select, 0085) is a second gate under the explicit owner filter — the
 * same belt-and-braces loadPersonalImageHistory uses.
 */
export async function toImageAttempt(
  supabase: SupabaseClient<Database>,
  userId: string,
  row: AttemptRow,
): Promise<ImageAttempt> {
  const status = imageAttemptStatus({
    settledAt: row.settled_at,
    kieTaskId: row.kie_task_id,
    error: row.error,
  });

  let image: GeneratedImage | null = null;
  if (row.asset_id) {
    const { data: asset } = await supabase
      .from("assets")
      .select("id, created_at, storage_key")
      .eq("id", row.asset_id)
      .eq("user_id", userId)
      .is("project_id", null)
      .eq("kind", "generated_image")
      .is("deleted_at", null)
      .maybeSingle();
    if (asset) {
      image = {
        assetId: asset.id,
        // Thumbnail-sized, like the history list: this is a recovery card, not
        // the full preview. Signed here and now — the durable record is the
        // asset id, never the URL, which expires.
        url: await signedUrl(asset.storage_key, undefined, {
          width: 320,
          resize: "contain",
          quality: 80,
        }),
        createdAt: asset.created_at,
      };
    }
  }

  return {
    runId: row.id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    status,
    model: row.model,
    kieTaskId: row.kie_task_id,
    reason: imageAttemptReason(row.error),
    image,
    costUsd: row.cost_usd,
  };
}

export const ATTEMPT_COLUMNS =
  "id, idempotency_key, created_at, model, error, settled_at, kie_task_id, asset_id, cost_usd";
const runIdSchema = z.string().uuid();

/**
 * Finishes what an abandoned request started: one read of kie, then settle,
 * store, or leave it running.
 *
 * ONE READ, NOT A POLL. The client calls this on an interval, so each request
 * stays far inside any proxy's window — the opposite of the blocking generate
 * path, whose 100s budget is a race it can only just win (lib/kie.ts). That is
 * the whole reason recovery works where the original request did not.
 *
 * MONEY RULES, unchanged from the generate path and deliberately identical:
 * kie having returned a task id is the discriminator between releasing and
 * holding. A task that reports `fail` HOLDS at the estimate rather than
 * releasing, because a submission we cannot prove was free must not hand budget
 * back — see lib/runs.ts's releaseRun/holdRunBillingUnknown pair.
 *
 * Development mode never reaches kie at all: generateImage short-circuits
 * before createTask, so a mocked attempt is settled by the time it returns and
 * no row here ever carries a task id to check.
 */
export async function reconcileImageAttemptFor(
  // A factory, not a client: a malformed id is refused before any client exists
  // (image-generator-recovery.test.ts pins that order).
  getClient: () => SupabaseClient<Database> | Promise<SupabaseClient<Database>>,
  userId: string,
  runId: string,
): Promise<ImageAttempt> {
  const parsedRunId = runIdSchema.safeParse(runId);
  if (!parsedRunId.success) throw new Error("Invalid image attempt.");

  const supabase = await getClient();

  // OWNER-SCOPED READ, through the session client so RLS gates it too. A run id
  // arriving from the browser is exactly the id an attacker would guess.
  const read = async (): Promise<AttemptRow> => {
    const { data, error } = await supabase
      .from("runs")
      .select(ATTEMPT_COLUMNS)
      .eq("id", parsedRunId.data)
      .eq("user_id", userId)
      .is("project_id", null)
      .not("idempotency_key", "is", null)
      .maybeSingle();
    if (error) throw new Error(`Failed to load image attempt: ${error.message}`);
    if (!data) throw new Error("This image attempt is no longer available.");
    return data;
  };

  const row = await read();
  const status = imageAttemptStatus({
    settledAt: row.settled_at,
    kieTaskId: row.kie_task_id,
    error: row.error,
  });

  // A settled timeout (or a successful task whose upload failed) can still
  // have an image waiting at kie. Never submit again to recover that image.
  const recoverable =
    row.kie_task_id && !row.asset_id && (status === "billing_unknown" || status === "completed");
  if (!isImageAttemptUnfinished(status) && !recoverable) {
    return toImageAttempt(supabase, userId, row);
  }

  // Reserved but never submitted: the process died between the reservation and
  // createTask. There is nothing to reconcile against, so this is the sweep's
  // job and not ours — and the sweep only fires once the row is old enough that
  // it cannot still be a live attempt. Calling the existing helper rather than
  // settling here keeps ONE definition of "abandoned".
  if (!row.kie_task_id) {
    await sweepStaleImageReservations({ projectId: null, userId: userId });
    return toImageAttempt(supabase, userId, await read());
  }

  let check;
  try {
    check = await checkImageTask(row.kie_task_id);
  } catch (error) {
    // A failed READ is not a failed attempt. The task may be drawing perfectly
    // well behind a transient network error, and settling on that would turn a
    // hiccup into a lost image the operator still paid for. Report the attempt
    // as it stands; the next poll asks again.
    console.error(`reconcilePersonalImageAttempt: kie read failed for run ${row.id}`, error);
    return {
      ...(await toImageAttempt(supabase, userId, row)),
      reason: "Could not check kie. Check status again; no new generation was submitted.",
    };
  }

  if (check.state === "pending") {
    return {
      ...(await toImageAttempt(supabase, userId, row)),
      status: "generating",
      reason: "Still generating at kie. Checking this same task automatically.",
    };
  }

  if (check.state === "failed") {
    // HELD, not released. kie was given the work; that it reported failure is
    // not proof it charged nothing, and only evidence may free budget.
    await holdRunBillingUnknown(row.id, `kie task ${row.kie_task_id} failed: ${check.message}`);
    return {
      ...(await toImageAttempt(supabase, userId, await read())),
      reason: `kie reported failure: ${check.message}. A refund has not been confirmed.`,
    };
  }

  // Success the original request never got to see. Same settle-store-link tail
  // the blocking path runs, so the charge, the file and the link are written
  // exactly once and in the same order either way.
  // Nothing here reserves or prices anything — the attempt was reserved, and
  // its ceilings checked, when it was created. So this passes the DESTINATION
  // only, not a whole ImageOwner with a fabricated cap profile.
  const stored = await settleAndStore({ userId: userId, projectId: null }, row.id, {
    url: check.url,
    costUsd: check.costUsd,
  });
  if (stored.error !== undefined) {
    // Settled and charged, but not saved. settleAndStore has already logged the
    // detail; the attempt below then reads as completed-without-an-image, which
    // is the honest shape and exactly what ALREADY_COMPLETED_MESSAGE covers.
    console.error(`reconcilePersonalImageAttempt: ${stored.error} (run ${row.id})`);
  }

  revalidatePath("/image-generator");
  return toImageAttempt(supabase, userId, await read());
}
