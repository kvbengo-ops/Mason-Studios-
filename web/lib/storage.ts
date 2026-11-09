// The only file in the repo allowed to touch `supabase.storage`.
//
// docs/architecture.md calls this out as a deliberate boundary: every asset
// upload, download URL, and key-shaping decision funnels through the three
// functions below so the storage vendor (Supabase Storage today) can be
// swapped for S3/R2/etc. in one file, without hunting `.storage.from(...)`
// calls across actions and pages.
//
// Storage keys are shaped `projects/{projectId}/{kind}/{uuid}.{ext}` — kind
// matches `assets.kind` (see supabase/migrations/0001_init.sql) so a key's
// path segment always agrees with the DB row that references it. The one
// exception is the Character Library (0020_characters.sql): a library entry
// has no project until it's picked, so its keys live under `library/{uuid}.
// {ext}` instead — see buildLibraryStorageKey.

import { STAGED_UPLOAD_PREFIX } from "@/lib/staged-upload";
import type { StagedUpload } from "@/lib/staged-upload";
import { createAdminClient } from "@/lib/supabase/server";
import { toJpeg } from "@/lib/to-jpeg";
import type { AssetKind } from "@/types/db";

export const MEDIA_BUCKET = "media";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;

// Objects in this bucket are immutable once written: buildStorageKey and
// buildLibraryStorageKey both mint a fresh crypto.randomUUID() per call, and
// every upload* function below passes upsert: false, so nothing in this app
// ever overwrites the bytes sitting at an existing key (verified by grepping
// the repo for every `.storage.` call — they all live in this file, per the
// header comment above). copyStorageObject also always writes to a freshly
// built destination key, never an existing one. That means there is no "the
// file changed under this URL" case to guard against — only "the key was
// deleted" (removeStorageObjects), and a long Cache-Control doesn't make
// that any worse: a deleted object 404s on the next real fetch no matter how
// long a browser was willing to cache the previous response.
//
// Supabase's own upload() default (when cacheControl is unset) is "3600" —
// see storage-js's FileOptions default — which happens to equal
// DEFAULT_SIGNED_URL_TTL_SECONDS above today, but that's a coincidence, not
// a contract: nothing keeps the two in sync, and a future bump to one of
// this app's per-caller TTL constants (MANIFEST_SIGNED_URL_TTL_SECONDS,
// ARCHIVE_SIGNED_URL_TTL_SECONDS, DELIVER_SIGNED_URL_TTL_SECONDS) would
// silently undercut the browser cache if it relied on that implicit
// default. Set it explicitly and generously instead, decoupled from any
// signed-URL TTL — the value is a plain seconds-count string because that's
// the shape storage-js's FileOptions.cacheControl expects (it gets embedded
// directly into a `Cache-Control: max-age=<value>` response header).
const STORAGE_OBJECT_CACHE_CONTROL_SECONDS = "31536000"; // 1 year.

// Passed straight through to Supabase Storage's own image transformation
// (Storage → Image Transformations; confirmed live on this project's Pro
// plan against this exact bucket — see the display call sites that pass
// this in). Mirrors @supabase/storage-js's own TransformOptions
// (node_modules/@supabase/storage-js/dist/index.d.mts) but is declared
// locally rather than imported from it: storage-js is only a transitive
// dependency here (pulled in by @supabase/supabase-js, which this file's
// admin client is typed against — see lib/supabase/server.ts — and which
// does not re-export the type itself), not a direct one this repo's
// package.json lists. Deliberately missing storage-js's `format` field: its
// only non-default value is `'origin'` (force the original format), and
// leaving `format` unset entirely is what makes Supabase negotiate WebP
// against the browser's Accept header — the format swap is where nearly
// all of this transform's savings actually come from, so no caller here
// should ever set it.
//
// A second gotcha, verified empirically against this bucket's live render
// endpoint rather than trusted from storage-js's docstring (which says
// resize "Defaults to cover" but doesn't say what happens when only one of
// width/height is given): passing `width` alone with `resize` left unset
// (equivalently, left at its 'cover' default) does NOT scale
// proportionally — it resizes ONLY the width and leaves height at the
// source's native pixel height, silently squashing the image. `resize:
// "contain"` with `width` alone (no `height`) is the combination that
// actually scales proportionally, computing height from the source's own
// aspect ratio. Every display call site that passes `width` below MUST
// also pass `resize: "contain"` for exactly this reason — omitting it
// doesn't error, it just quietly distorts the image. (Supabase also never
// upscales past the source's native resolution — requesting a `width`
// larger than the original just returns the original size — so it's
// always safe to pick a generous target width without checking the
// source's real dimensions first.)
export interface ImageTransform {
  width?: number;
  height?: number;
  resize?: "cover" | "contain" | "fill";
  quality?: number;
}

// Shared by every avatar display call site (app/(app)/profile/page.tsx,
// app/(app)/layout.tsx's account menu) so they request signedUrl() with the
// IDENTICAL transform object — same "contain, not the default cover" rule
// this file's own header documents above, and required because
// signedUrlCacheKey() below folds the transform's values into its cache
// key: two call sites passing differently-shaped transform literals for the
// same storageKey would simply miss each other's cache entry and pay for a
// second createSignedUrl call, not corrupt anything, but there is no reason
// to pay that cost twice for the same 128x128 avatar within one cache TTL.
export const AVATAR_TRANSFORM: ImageTransform = { width: 128, height: 128, resize: "contain" };

// The image extensions this file's own extFromContentType/extFromFilename
// ever produce. Everything else stored under a different extension in this
// bucket is video (.mp4 — see extFromContentType's video/mp4 case). Used
// only by assertTransformableImage below.
const TRANSFORMABLE_IMAGE_EXTENSIONS = new Set(["png", "webp", "gif", "jpg", "jpeg"]);

// Guards signedUrl()'s `transform` parameter: Supabase's image-transform
// endpoint decodes and re-encodes whatever bytes sit at the key, so pointing
// it at an .mp4 would not fail cleanly — it would either error deep inside
// Supabase's transformer or hand back something that looks like a URL but
// breaks playback/export the moment a caller tries to use it. Failing loudly
// here, at the one file that ever calls createSignedUrl, catches a
// `transform` passed for the wrong key before it ever reaches a <video> tag
// or ffmpeg.
function assertTransformableImage(storageKey: string): void {
  const ext = storageKey.split(".").pop()?.toLowerCase();
  if (!ext || !TRANSFORMABLE_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(
      `signedUrl: a transform was requested for "${storageKey}", which this file does not ` +
        `recognize as an image (expected one of: ${[...TRANSFORMABLE_IMAGE_EXTENSIONS].join(", ")}). ` +
        "Supabase's image-transform endpoint only serves images — the most likely cause is a " +
        "video key (.mp4) accidentally reaching a display call site.",
    );
  }
}

// ---------------------------------------------------------------------
// signedUrl() memoization.
//
// Verified empirically before writing this: Supabase's createSignedUrl()
// embeds an `iat` (issued-at) claim in the signed JWT alongside
// `url`/`scope`/`exp`. Two calls with the SAME storageKey and SAME
// expiresIn still produce DIFFERENT tokens whenever they land in different
// wall-clock seconds, because `iat` is "now," not a function of the
// inputs. That rules out making the URL deterministic by rounding
// expiresIn to a fixed boundary ("bucketing") — the token differs
// regardless of what exp works out to, since iat rides along unchanged.
// The only way to make repeated renders emit the same url= string (so the
// browser's HTTP cache can ever hit) is to not call createSignedUrl again:
// memoize the result.
//
// This Map is process-local, not a shared cache (Redis/KV/etc.). It lives
// for the lifetime of one server instance and is empty again after every
// deploy or cold start — acceptable here because this app runs as a single
// small instance (see docs/architecture.md), so "empty after a deploy"
// just means the first render of each asset after a deploy pays for one
// fresh createSignedUrl call, same as it does today on every render. It
// would NOT be sufficient if this ran as multiple instances behind a load
// balancer with no sticky sessions (each instance caches independently —
// still correct, just less effective) or as short-lived serverless
// functions that don't keep warm module state between invocations (which
// would make this cache a no-op).
interface SignedUrlCacheEntry {
  url: string;
  cachedAtMs: number;
  expiresInSeconds: number;
}

const signedUrlCache = new Map<string, SignedUrlCacheEntry>();

// Fraction of the caller's requested expiresIn that a cached URL is served
// for before this file asks Supabase for a fresh one. Kept well under 1.0
// so a URL handed out by a page render is never close to the moment
// Supabase's own token actually expires — e.g. a video whose download
// starts near the end of this cache's freshness window shouldn't have its
// token lapse mid-download. Lower = fresher tokens but more
// createSignedUrl calls (worse browser cache-hit rate, since url= changes
// more often). Higher = better cache hits but a longer window where this
// cache keeps serving a URL that's already burned down more of its own
// remaining lifetime.
const SIGNED_URL_CACHE_FRESH_FRACTION = 0.5;

// Hard cap on distinct (storageKey, expiresIn) entries held at once, so a
// long-lived instance that keeps getting asked to sign URLs for new keys
// (new projects, new renders, over weeks of uptime) can't grow this Map
// without bound. 2000 is generous for this app's scale — a handful of
// assets per project, a small number of concurrently active projects (see
// docs/architecture.md) — while keeping worst-case memory to a couple
// thousand short strings.
const MAX_SIGNED_URL_CACHE_ENTRIES = 2000;

function signedUrlCacheKey(
  storageKey: string,
  expiresInSeconds: number,
  transform: ImageTransform | undefined,
  download: string | boolean | undefined,
): string {
  // expiresIn is part of the key, not just storageKey, because different
  // call sites request different TTLs for the same kind of asset (e.g. a
  // page render's DEFAULT_SIGNED_URL_TTL_SECONDS vs.
  // actions/deliver.ts's MANIFEST_SIGNED_URL_TTL_SECONDS). Keying on
  // storageKey alone could hand a caller that asked for a long-lived URL a
  // cached copy that was actually signed for a much shorter window,
  // silently shortening its real remaining lifetime. A NUL byte is a safe
  // separator here: every storage key this file mints (see
  // buildStorageKey/buildLibraryStorageKey above) is a printable
  // slash-and-dot-shaped path, so this can't collide across different keys.
  //
  // transform is part of the key for the same reason, one level sharper: a
  // display call site (transform set, quality 80) and a source-of-truth
  // call site (no transform — fal conditioning input, video) can ask for
  // the SAME storageKey at the SAME TTL. Without transform in the key,
  // whichever of the two called signedUrl() first would silently hand its
  // cached URL to the other — a lossy, recompressed image handed to fal as
  // conditioning input, or an untransformed multi-MB PNG served where a
  // transformed one was wanted. Serialized with fixed field order, not
  // `JSON.stringify(transform)` (which would key on whatever order a
  // caller happened to write its object literal in), so two calls that
  // mean the same transform always produce the same cache key.
  const transformFragment = transform
    ? `\0t:${transform.width ?? ""},${transform.height ?? ""},${transform.resize ?? ""},${transform.quality ?? ""}`
    : "";
  // Keep previews, attachments and different download filenames separate.
  // JSON preserves the distinction between true and a filename of "true".
  const downloadFragment = download ? `\0d:${JSON.stringify(download)}` : "";
  return `${storageKey}\0${expiresInSeconds}${transformFragment}${downloadFragment}`;
}

function isSignedUrlCacheEntryFresh(entry: SignedUrlCacheEntry, nowMs: number): boolean {
  const freshForMs = entry.expiresInSeconds * 1000 * SIGNED_URL_CACHE_FRESH_FRACTION;
  return nowMs - entry.cachedAtMs < freshForMs;
}

// Called only when the cache is about to grow past MAX_SIGNED_URL_CACHE_ENTRIES.
// Sweeps stale entries first; if that alone doesn't free room, evicts the
// single oldest entry. This runs in O(cache size), but only on the rare,
// capped path where the cache is full — every other signedUrl() call stays
// O(1).
function evictFromSignedUrlCache(nowMs: number): void {
  for (const [key, entry] of signedUrlCache) {
    if (!isSignedUrlCacheEntryFresh(entry, nowMs)) {
      signedUrlCache.delete(key);
    }
  }

  if (signedUrlCache.size < MAX_SIGNED_URL_CACHE_ENTRIES) {
    return;
  }

  let oldestKey: string | undefined;
  let oldestAtMs = Infinity;
  for (const [key, entry] of signedUrlCache) {
    if (entry.cachedAtMs < oldestAtMs) {
      oldestAtMs = entry.cachedAtMs;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    signedUrlCache.delete(oldestKey);
  }
}

export function extFromContentType(contentType: string | null): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    default:
      return "jpg";
  }
}

export function extFromFilename(filename: string, fallback: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return match?.[1]?.toLowerCase() ?? fallback;
}

export function buildStorageKey(args: { projectId: string; kind: AssetKind; ext: string }): string {
  const { projectId, kind, ext } = args;
  return `projects/${projectId}/${kind}/${crypto.randomUUID()}.${ext}`;
}

// Character Library entries have no project — they're the thing projects
// copy FROM (see 0020_characters.sql), not something scoped to one. `library/`
// sits outside the `projects/{projectId}/...` shape every other key here
// uses, and deliberately doesn't need to: nothing in this file's storage.objects
// RLS policies (0005_storage_bucket.sql) reads a `library/` path, because
// every access to it — upload, sign, copy, remove — goes through
// web/actions/character-library.ts's admin client, same as every other
// write in this app. Those policies exist for a hypothetical
// anon/authenticated client path, and there isn't one here to protect.
export function buildLibraryStorageKey(ext: string): string {
  return `library/${crypto.randomUUID()}.${ext}`;
}

// An avatar belongs to an ACCOUNT, not a project (buildStorageKey) or the
// shared Character Library (buildLibraryStorageKey) — see
// 0034_profile_avatar.sql's own header. `{user_id}` sits at path element 2
// (element 1 is the fixed `avatars` literal) specifically so that migration's
// storage RLS policies can scope insert/update/delete to
// `(storage.foldername(name))[2] = auth.uid()::text`.
//
// `projects/{projectId}/...` keys follow the SAME convention: a fixed literal
// at element 1, the id at element 2. 0005_storage_bucket.sql originally
// claimed otherwise — that a project key "has no fixed literal ahead of it"
// and so carries its id at element 1 — and wrote all four media_* policies
// against that. It is wrong: every key this file and the worker mint begins
// with the literal `projects/`, so element 1 is that literal and the id is at
// element 2, exactly as for avatars. The policies matched nothing for as long
// as that stood; 0048_fix_media_policy_folder_index.sql corrects them.
export function buildAvatarStorageKey(userId: string, ext: string): string {
  return `avatars/${userId}/${crypto.randomUUID()}.${ext}`;
}

// An asset owned by an ACCOUNT rather than a project — the project-less Image
// Generator (0085_personal_image_generator.sql) is the first thing to produce
// one. Same convention as `avatars/` and `projects/` above and for the same
// reason: a fixed literal at path element 1, the id at element 2, so
// 0048_fix_media_policy_folder_index.sql's `(storage.foldername(name))[2]`
// scoping keeps working if a media policy is ever written for this prefix.
//
// `users/`, not a second `projects/` shape with a user id in it: a key that
// lies about what its id refers to is how a cleanup routine deletes the wrong
// object. Nothing today reads this prefix through anon/authenticated — every
// access goes through the admin client, same as `library/`.
export function buildUserStorageKey(args: {
  userId: string;
  kind: AssetKind;
  ext: string;
}): string {
  const { userId, kind, ext } = args;
  return `users/${userId}/${kind}/${crypto.randomUUID()}.${ext}`;
}

/**
 * Exactly one owner, enforced by the type rather than by a runtime check:
 * `projectId` puts the object under `projects/<id>/`, `userId` under
 * `users/<id>/` (0085_personal_image_generator.sql). A union, not two
 * optional fields, so "neither" and "both" are compile errors instead of a
 * key silently built from whichever the implementation happened to read
 * first.
 */
export type UploadFromUrlArgs = {
  url: string;
  kind: AssetKind;
  sceneId?: string;
} & ({ projectId: string; userId?: never } | { userId: string; projectId?: never });

/** uploadFromUrl's owner rule, for an operator-supplied file. Same union, same reason. */
export type UploadFileArgs = {
  file: File;
  kind: AssetKind;
  sceneId?: string;
} & ({ projectId: string; userId?: never } | { userId: string; projectId?: never });

export interface UploadResult {
  storageKey: string;
  /** Size of the stored object — differs from the input when toJpeg re-encoded it. */
  bytes?: number;
}

/**
 * Downloads a remote file (typically a fal result URL, which expires — see
 * architecture.md § "Webhook rules") and re-uploads it into our own bucket
 * so it doesn't disappear out from under us.
 */
export async function uploadFromUrl(args: UploadFromUrlArgs): Promise<UploadResult> {
  const { url, kind } = args;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`uploadFromUrl: failed to fetch ${url} (status ${response.status}).`);
  }

  const contentType = response.headers.get("content-type");
  const buffer = await response.arrayBuffer();
  const ext = extFromContentType(contentType);
  const storageKey = args.projectId
    ? buildStorageKey({ projectId: args.projectId, kind, ext })
    : buildUserStorageKey({ userId: args.userId!, kind, ext });

  const admin = createAdminClient();
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(storageKey, buffer, {
    contentType: contentType ?? "application/octet-stream",
    cacheControl: STORAGE_OBJECT_CACHE_CONTROL_SECONDS,
    upsert: false,
  });

  if (error) {
    throw new Error(`uploadFromUrl: failed to upload to storage: ${error.message}`);
  }

  return { storageKey };
}

/** Uploads an operator-supplied file (e.g. a real character photo); WebP is stored as JPEG (toJpeg); PNG and JPEG are kept as uploaded. */
export async function uploadFile(args: UploadFileArgs): Promise<UploadResult> {
  const { kind } = args;
  const file = await toJpeg(args.file);

  const ext = extFromFilename(file.name, extFromContentType(file.type || null));
  const storageKey = args.projectId
    ? buildStorageKey({ projectId: args.projectId, kind, ext })
    : buildUserStorageKey({ userId: args.userId!, kind, ext });

  const admin = createAdminClient();
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(storageKey, file, {
    contentType: file.type || "application/octet-stream",
    cacheControl: STORAGE_OBJECT_CACHE_CONTROL_SECONDS,
    upsert: false,
  });

  if (error) {
    throw new Error(`uploadFile: failed to upload to storage: ${error.message}`);
  }

  return { storageKey, bytes: file.size };
}

/**
 * uploadFromUrl/uploadFile's library-scoped siblings: same fal-result and
 * operator-upload paths (used by createCharacterFromDescription and
 * createCharacterFromUpload, web/actions/character-library.ts), but keyed
 * under buildLibraryStorageKey's `library/` prefix instead of a project's,
 * since a library entry has no project until it's picked. Kept as separate
 * functions rather than an optional `projectId` on the existing two: every
 * other caller of those always has a project, so making it optional would
 * let a forgotten argument silently fall through to a library key instead
 * of failing type-checking.
 */
export async function uploadLibraryFromUrl(args: { url: string }): Promise<UploadResult> {
  const response = await fetch(args.url);
  if (!response.ok) {
    throw new Error(
      `uploadLibraryFromUrl: failed to fetch ${args.url} (status ${response.status}).`,
    );
  }

  const contentType = response.headers.get("content-type");
  const buffer = await response.arrayBuffer();
  const ext = extFromContentType(contentType);
  const storageKey = buildLibraryStorageKey(ext);

  const admin = createAdminClient();
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(storageKey, buffer, {
    contentType: contentType ?? "application/octet-stream",
    cacheControl: STORAGE_OBJECT_CACHE_CONTROL_SECONDS,
    upsert: false,
  });

  if (error) {
    throw new Error(`uploadLibraryFromUrl: failed to upload to storage: ${error.message}`);
  }

  return { storageKey };
}

export async function uploadLibraryFile(args: { file: File }): Promise<UploadResult> {
  const file = await toJpeg(args.file);
  const ext = extFromFilename(file.name, extFromContentType(file.type || null));
  const storageKey = buildLibraryStorageKey(ext);

  const admin = createAdminClient();
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(storageKey, file, {
    contentType: file.type || "application/octet-stream",
    cacheControl: STORAGE_OBJECT_CACHE_CONTROL_SECONDS,
    upsert: false,
  });

  if (error) {
    throw new Error(`uploadLibraryFile: failed to upload to storage: ${error.message}`);
  }

  return { storageKey, bytes: file.size };
}

/**
 * uploadFile's avatar-scoped sibling (actions/profile.ts's uploadAvatar):
 * same operator-upload path, keyed under buildAvatarStorageKey's
 * `avatars/{user_id}/...` prefix instead of a project's. Kept separate for
 * the same reason uploadLibraryFile is: every other uploadFile caller has a
 * projectId in hand, so folding this into that signature would let a
 * forgotten argument silently fall through to the wrong prefix instead of
 * failing type-checking.
 */
export async function uploadAvatarFile(args: {
  userId: string;
  file: File;
}): Promise<UploadResult> {
  const { userId } = args;
  const file = await toJpeg(args.file);
  const ext = extFromFilename(file.name, extFromContentType(file.type || null));
  const storageKey = buildAvatarStorageKey(userId, ext);

  const admin = createAdminClient();
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(storageKey, file, {
    contentType: file.type || "application/octet-stream",
    cacheControl: STORAGE_OBJECT_CACHE_CONTROL_SECONDS,
    upsert: false,
  });

  if (error) {
    throw new Error(`uploadAvatarFile: failed to upload to storage: ${error.message}`);
  }

  return { storageKey, bytes: file.size };
}

/**
 * Uploads a pasted/dropped screenshot from the "Report a problem" dialog and
 * returns its filename — not a URL. The dialog inserts a short link to our
 * own /api/issue-image/{file} redirect route instead of a ~500-char signed
 * URL, so a report with several screenshots doesn't blow the description's
 * character limit; that route resolves the filename back to a signed URL at
 * request time via issueImageStorageKey below. No toJpeg: GitHub renders
 * PNG/GIF/WebP fine, and re-encoding a screenshot the reporter is about to
 * look at buys nothing.
 */
export async function uploadIssueImage(args: { file: File }): Promise<string> {
  const { file } = args;
  const ext = extFromContentType(file.type || null);
  const filename = `${crypto.randomUUID()}.${ext}`;
  const storageKey = `issue-reports/${filename}`;

  const admin = createAdminClient();
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(storageKey, file, {
    contentType: file.type || "application/octet-stream",
    cacheControl: STORAGE_OBJECT_CACHE_CONTROL_SECONDS,
    upsert: false,
  });

  if (error) {
    throw new Error(`uploadIssueImage: failed to upload to storage: ${error.message}`);
  }

  return filename;
}

/**
 * Resolves an /api/issue-image/{file} route param back to a storage key, or
 * null if it isn't a UUID-shaped filename we could have minted — the path
 * traversal guard for that route, since the unguessable uuid is its only
 * access control (no auth check; see the route's own comment).
 */
export function issueImageStorageKey(file: string): string | null {
  const match =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/.test(file);
  return match ? `issue-reports/${file}` : null;
}

/**
 * Duplicates a stored object under a new key via Supabase Storage's own
 * server-side copy, rather than downloading and re-uploading through this
 * process the way uploadFromUrl does for a fal result. That distinction is
 * deliberate: a fal URL is a third party's temporary link that has to pass
 * through us to become durable, but a library character's photo is already
 * durable, already ours, and already sitting on the same storage backend the
 * destination lives on — round-tripping it through this process's memory
 * would spend bandwidth and time proving something the storage vendor can
 * already guarantee atomically. Used by useCharacter
 * (web/actions/character-library.ts) to give a project its OWN copy of a
 * library character's photo, never a pointer at the library's copy — see
 * that function's doc comment for why copying, not referencing, is the
 * point.
 */
export async function copyStorageObject(fromKey: string, toKey: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(MEDIA_BUCKET).copy(fromKey, toKey);

  if (error) {
    throw new Error(`copyStorageObject: failed to copy ${fromKey} to ${toKey}: ${error.message}`);
  }
}

/**
 * Deletes one or more objects from the media bucket.
 *
 * There are two orders a caller can delete in, and neither is safe in both
 * directions — the choice is about which orphan you would rather be left
 * with when the second step fails.
 *
 *   Storage first, then the row. If THIS call throws, nothing has been
 *   touched and the operation is retriable. If it succeeds and the row
 *   delete then fails, you get an `assets` row pointing at an object that
 *   is gone: `signedUrl` breaks the next time anything displays it — but
 *   the row is right there to find and clean up.
 *
 *   Row first, then storage. If the row delete throws, nothing has been
 *   touched. If it succeeds and this call then fails, the object is
 *   orphaned — and because the storage key lived on the row that was just
 *   deleted, nothing knows the key any more. That garbage is invisible and
 *   unreclaimable.
 *
 * An earlier version of this comment claimed storage-first AVOIDS the
 * dangling-row case. It does not: storage-first is the only order that can
 * produce it. The real argument for storage-first is the one above — a
 * visible break you can repair beats silent garbage you cannot find.
 *
 * So storage-first is the default, and the character/product reference
 * "remove" actions use it. reassembleProject (actions/deliver.ts)
 * deliberately does not — see its own comment for why the tradeoff inverts
 * when the row's whole purpose is to gate a rebuild.
 */
export async function removeStorageObjects(storageKeys: string[]): Promise<void> {
  if (storageKeys.length === 0) {
    return;
  }

  const admin = createAdminClient();
  const { error } = await admin.storage.from(MEDIA_BUCKET).remove(storageKeys);

  if (error) {
    throw new Error(`removeStorageObjects: failed to delete from storage: ${error.message}`);
  }
}

/**
 * Signed, time-limited URL for a private storage key.
 *
 * Memoized (see the signedUrl() memoization block above this file's upload
 * functions) so that repeat server renders of the same asset — which is
 * every page in this app, since Server Components re-run signedUrl() on
 * every request — emit the SAME url= string instead of a fresh one every
 * time. That's what lets the browser's HTTP cache ever hit on an image or
 * video at all: a signed URL's query string is part of the cache key, and
 * Supabase's token is never byte-identical across calls (it carries an
 * `iat` claim), so without this memoization every navigation re-downloads
 * every asset from scratch.
 *
 * `transform` (see ImageTransform above) requests Supabase's Storage image
 * transformation on top of that. Pass it ONLY at a call site that renders
 * the result for a human to look at: it recompresses (and, left unset,
 * format-negotiates to WebP) the bytes the browser gets back, which is
 * exactly wrong for anything this app treats as a source of truth —
 * reference-image input to fal (actions/frames.ts, actions/character.ts)
 * must stay full-fidelity, and video (actions/deliver.ts, the archive
 * route) isn't an image the render endpoint can serve at all.
 * assertTransformableImage throws up front if `transform` is requested for
 * a key that isn't one of this file's image extensions, so a video reaching
 * this by mistake fails loudly here instead of quietly breaking export.
 *
 * `download` requests an attachment: true uses the stored filename, or a
 * string supplies a download filename. Omit `transform` for original bytes.
 */
export interface SignedUrlWithExpiry {
  url: string;
  expiresInSeconds: number;
}

/**
 * Same as `signedUrl`, but also returns the accurate remaining lifetime in seconds
 * (`1800..3600s` on a cache hit or `expiresInSeconds` on a fresh sign) so
 * `GET /api/v1/jobs/[id]` never advertises a stale `3600` TTL on a cached URL.
 */
export async function signedUrlWithExpiry(
  storageKey: string,
  expiresInSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  transform?: ImageTransform,
  download?: string | boolean,
): Promise<SignedUrlWithExpiry> {
  if (transform) {
    assertTransformableImage(storageKey);
  }

  const cacheKey = signedUrlCacheKey(storageKey, expiresInSeconds, transform, download);
  const now = Date.now();

  const cached = signedUrlCache.get(cacheKey);
  if (cached && isSignedUrlCacheEntryFresh(cached, now)) {
    const remainingSeconds = Math.max(
      1,
      cached.expiresInSeconds - Math.ceil((now - cached.cachedAtMs) / 1000),
    );
    return { url: cached.url, expiresInSeconds: remainingSeconds };
  }

  const admin = createAdminClient();
  const options =
    transform || download !== undefined
      ? {
          ...(transform ? { transform } : {}),
          ...(download !== undefined ? { download } : {}),
        }
      : undefined;
  const { data, error } = await admin.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(storageKey, expiresInSeconds, options);

  if (error || !data) {
    throw new Error(
      `signedUrl: failed to sign ${storageKey}: ${error?.message ?? "unknown error"}`,
    );
  }

  if (transform && !data.signedUrl.includes("/render/image/")) {
    warnTransformDropped(storageKey);
  }

  if (signedUrlCache.size >= MAX_SIGNED_URL_CACHE_ENTRIES) {
    evictFromSignedUrlCache(now);
  }
  signedUrlCache.set(cacheKey, { url: data.signedUrl, cachedAtMs: now, expiresInSeconds });

  return { url: data.signedUrl, expiresInSeconds };
}

export async function signedUrl(
  storageKey: string,
  expiresInSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  transform?: ImageTransform,
  download?: string | boolean,
): Promise<string> {
  const { url } = await signedUrlWithExpiry(storageKey, expiresInSeconds, transform, download);
  return url;
}

/**
 * Says it once per process, not once per image.
 *
 * The picker signs every element in one render, so an unguarded warning
 * would print eighteen identical lines and teach the reader to scroll past
 * the whole class of message.
 */
let transformDropWarned = false;
function warnTransformDropped(storageKey: string): void {
  if (transformDropWarned) return;
  transformDropWarned = true;
  console.warn(
    `signedUrl: a transform was requested for "${storageKey}" and Storage returned an ` +
      "untransformed object URL — this environment serves the ORIGINAL bytes for every " +
      "thumbnail. Expected in local development (the local stack has no /render/image route); " +
      "in production it means image transformations are off for this project.",
  );
}

const STAGED_KEY_PATTERN =
  /^staging\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export class StagedUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
    readonly code: "invalid_staged_key" | "forbidden_staged_key" | "staged_file_missing",
  ) {
    super(message);
  }
}

/** A signed URL the browser can upload exactly one object to, under the user's own staging prefix. See lib/staged-upload.ts. */
export async function createStagedUploadUrl(
  userId: string,
): Promise<{ key: string; token: string; signedUrl: string }> {
  const key = `staging/${userId}/${crypto.randomUUID()}`;
  const { data, error } = await createAdminClient()
    .storage.from(MEDIA_BUCKET)
    .createSignedUploadUrl(key);
  if (error || !data) {
    throw new Error(`createStagedUploadUrl: ${error?.message ?? "no upload token returned"}`);
  }
  return { key, token: data.token, signedUrl: data.signedUrl };
}

/** Downloads and consumes one staged object after verifying its owner prefix. */
export async function downloadStagedUpload(
  key: string,
  userId: string,
  filename: string,
  type: string,
): Promise<File> {
  const match = STAGED_KEY_PATTERN.exec(key);
  if (!match) throw new StagedUploadError("Invalid staged upload key.", 400, "invalid_staged_key");
  if (match[1] !== userId) {
    throw new StagedUploadError(
      "That staged upload belongs to another account.",
      403,
      "forbidden_staged_key",
    );
  }

  const admin = createAdminClient();
  try {
    const { data, error } = await admin.storage.from(MEDIA_BUCKET).download(key);
    if (error || !data) {
      throw new StagedUploadError("Staged upload was not found.", 404, "staged_file_missing");
    }
    return new File([data], filename, { type });
  } finally {
    await admin.storage
      .from(MEDIA_BUCKET)
      .remove([key])
      .catch(() => undefined);
  }
}

/**
 * Replaces every staged-upload marker in `formData` with the File the browser
 * uploaded, in place, so an action's existing `formData.get(...)` validation
 * runs unchanged. Refuses a key outside the caller's own staging prefix. The
 * staging object is removed once read (best effort). A FormData with no
 * markers — the old direct-File path — passes through untouched.
 */
export async function resolveStagedUploads(formData: FormData, userId: string): Promise<void> {
  const admin = createAdminClient();
  for (const [name, value] of [...formData.entries()]) {
    if (typeof value !== "string" || !value.startsWith(STAGED_UPLOAD_PREFIX)) continue;
    const staged = JSON.parse(value.slice(STAGED_UPLOAD_PREFIX.length)) as StagedUpload;
    if (STAGED_KEY_PATTERN.exec(staged.key)?.[1] !== userId) {
      throw new Error("That upload does not belong to this account.");
    }
    const { data, error } = await admin.storage.from(MEDIA_BUCKET).download(staged.key);
    if (error || !data) {
      throw new Error(`Could not read the uploaded file: ${error?.message ?? "not found"}`);
    }
    formData.set(name, new File([data], staged.filename, { type: staged.type }));
    await admin.storage
      .from(MEDIA_BUCKET)
      .remove([staged.key])
      .catch(() => undefined);
  }
}
