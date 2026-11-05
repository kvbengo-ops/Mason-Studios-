// @tag resolution for the /ugc prompt editor.
//
// 0065_elements.sql's own header forecasts this file by name ("the @tag
// resolver, once it exists") — an operator types "@jen" into the prompt and
// this is what turns that into "a known reference, here's what it looks
// like" or "a miss, nothing renders from this word".
//
// Deliberately does NOT rewrite the prompt that reaches kie: the vendor
// gets the literal text, "@name" included, exactly like every other word in
// the prompt — see actions/ugc.ts's generateClip, which still sends
// `prompt` verbatim. There is no vendor path that understands
// multi-reference input at all (ugc-column.tsx's own InfoHint: "Image only
// today"), so an @tag is prose, not a directive the render actually obeys.
// This file exists purely to make the TEXTAREA legible — which @tag
// resolves to a real reference the operator already saved, and which one is
// a typo they are about to pay to discover, per the standing rule "an
// unknown tag must be visibly a miss".

import type { AssetKind, ElementCategory } from "@/types/db";

/**
 * The picture extensions Kling's Start/End frame slots may actually submit.
 *
 * KLING-ONLY. kie's Kling 3.0 rejects webp at submit — `code=422 msg="Only
 * jpeg/jpg/png image formats are supported"` (prod scene d532c7a0, whose end
 * frame was a .webp element) — while every OTHER model this route offers
 * (Seedance) accepts webp fine and has been rendering it since the first
 * upload. So this allowlist gates exactly the two call sites that read
 * ElementTag.imageExt for Kling: ugc-column.tsx's frame-slot check and
 * ugc-reference-picker.tsx's own grid filter when opened elementsOnly.
 *
 * Lowercase, no dot — matches what ElementTag.imageExt and
 * lib/storage.ts's extFromFilename both already produce.
 */
export const KLING_FRAME_EXTS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg"]);

export interface ElementTag {
  /** Saved personal copies stay out of the shared grid. */
  readonly isShared?: boolean;
  readonly id: string;
  readonly name: string;
  readonly category: ElementCategory;
  readonly description: string | null;
  /**
   * The generated fallback description (0072_element_ai_description.sql).
   * Only added for ugc-prompt-preview.ts's benefit: descriptionFor
   * (element-tags.ts) prefers `description` and falls back to this, and
   * actions/ugc.ts's resolveElementTags reads BOTH columns when it resolves
   * @tags server-side. Omitting this from the client-side ElementTag would
   * make the prompt preview under-substitute — showing "@tag" unresolved for
   * an element that has only ever been AI-described — so it rides along
   * even though the picker UI itself has no use for it.
   *
   * OPTIONAL, not required: making it mandatory would force every existing
   * ElementTag test fixture across the codebase to grow a field they have no
   * use for. Absent reads as "no fallback", the same as an explicit null.
   */
  readonly aiDescription?: string | null;
  /**
   * WHO SAVED IT (`elements.user_id`) — the column the shared Elements Library
   * decides read-only-versus-editable against, per card.
   *
   * Only meaningful on the library page, which since
   * 0091_shared_elements_library.sql loads every account's rows rather than one
   * account's. The @tag consumers never need it: their read is already scoped
   * to a single owner (lib/element-library.ts's `ownerId`), so every row they
   * hold has the same answer.
   *
   * OPTIONAL for the same reason aiDescription is: making it mandatory would
   * force every ElementTag fixture across the codebase to grow a field it has
   * no use for. Absent must therefore never read as "mine" — see
   * elements-library.tsx's canEdit, which compares against the viewer id and so
   * treats `undefined` as not-mine, the safe direction.
   */
  readonly userId?: string;
  /** Signed URL for the underlying asset, resolved server-side — see ugc/[id]/page.tsx. */
  readonly previewUrl: string;
  /**
   * Full-size signed URL, for "View" on a shared card. `previewUrl` is a 320px
   * rendition sized for a grid thumbnail, so it is the wrong thing to open when
   * somebody wants to actually look at the picture.
   *
   * OPTIONAL like the two above, and for the same reason: every existing
   * ElementTag fixture and both @tag consumers build this type without one, and
   * neither of them shows a View control. Absent simply means the card falls
   * back to the preview.
   */
  readonly fullUrl?: string;
  /**
   * Signed URL that downloads instead of rendering, filename included.
   *
   * A SEPARATE URL, not `fullUrl` plus an HTML `download` attribute: the object
   * is served from Supabase, a different origin, and the browser ignores
   * `download` cross-origin. Supabase's own `download` option is what turns the
   * response into an attachment, and it has to be baked into the signed URL at
   * mint time — see lib/storage.ts's signedUrl.
   */
  readonly downloadUrl?: string;
  /**
   * What the file actually IS, straight off `assets.kind` — not inferred
   * from `category`.
   *
   * These two agree for anything uploaded since 0081 — registerElement sets
   * category "audio" for any sound file — but they are not the same fact and
   * they come apart on older rows: every element saved before 0081 carries
   * character, product or location, and a picture filed as "character" is
   * still a picture. Reading "is this a sound file?" off the label is how a
   * PNG ends up in an <audio> element that plays nothing, and how those
   * older pictures fell out of the Image filter.
   */
  readonly assetKind: AssetKind;
  /**
   * How long this reference is, in seconds, or null when nobody measured it.
   *
   * ONLY A VIDEO'S IS BILLED, and that is the whole reason this rides along
   * to the client at all. kie charges a video-conditioned render for the
   * reference's own seconds on top of the clip's, at a different per-second
   * rate (lib/kie/rates.ts's `video` table, measured 2026-09-10). The
   * server-side cap check has read this from the database since then; the
   * PRICE ON THE CONFIRM DIALOG had no way to, so it quoted the clip alone
   * and asked the operator to approve a number that was 21% under the bill
   * on a 4s render, and 9% over on an 8s one.
   *
   * OPTIONAL, like aiDescription and userId above and for the same reason:
   * making it mandatory would force every ElementTag fixture in the codebase
   * to grow a field it has no use for. Absent and null both mean "not
   * measured", which is NOT zero — a quote that cannot see a video's length
   * must refuse rather than price the render as though the video were free.
   */
  readonly durationS?: number | null;
  /**
   * The underlying asset's file extension, lowercased and without the dot
   * (e.g. "png", "jpg", "webp") — straight off `assets.storage_key`, the
   * same source signedUrl reads to build `previewUrl` above.
   *
   * WHY THIS RIDES ALONG AT ALL: Kling's Start/End frame slots (ugc-
   * column.tsx) can only take a picture, but kie's Kling 3.0 rejects webp
   * outright at submit — `code=422 msg="Only jpeg/jpg/png image formats are
   * supported"` (prod scene d532c7a0's end frame, a .webp element) — while
   * kie's OTHER models (Seedance) accept webp fine and have been rendering
   * it. That is a Kling-only rule about a FILE'S BYTES, which `assetKind`
   * cannot answer (a "character_ref" is a character_ref whether it is a
   * .png or a .webp) — so the column needs the extension itself to warn and
   * disable before a Kling submission reaches the server's own refusal.
   *
   * OPTIONAL, like aiDescription/userId/durationS above and for the same
   * reason: every existing ElementTag fixture in the codebase builds this
   * type without one, and only the Kling frame slots read it. Absent skips
   * the CLIENT-SIDE warning rather than blocking on it — same "a failed
   * lookup must not invent a refusal" reasoning actions/ugc.ts's
   * unknownElementTags follows — because the server refuses the actual
   * webp regardless of what this optional field says, so the client check
   * is a courtesy, not the enforcement.
   */
  readonly imageExt?: string;
}

/**
 * One shared pattern for every consumer that has to agree on what counts as
 * a tag — the prompt-editor overlay, the autocomplete trigger, and any
 * future consumer that walks a prompt string. A leading '@' followed by
 * 1-64 word/hyphen characters; deliberately does not allow spaces, so
 * "@jen," and "@jen doing a thing" both stop the tag at the comma/space,
 * matching what an operator visually reads as one "word" here.
 *
 * Carries the `g` flag for the split function below. A caller that needs a
 * single match and reuses this constant directly must reset `.lastIndex`
 * (or clone via `new RegExp(TAG_PATTERN)`, which is what splitPromptIntoTagSegments
 * does) — a shared stateful RegExp is exactly the kind of bug that only
 * shows up on the second call.
 */
export const TAG_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,63})/g;

/**
 * Case-insensitive lookup — `elements.name` has no enforced case (the
 * unique index is on the raw column, not `lower(name)`), and typing "@Jen"
 * for an element saved as "jen" is the common case, not the exception.
 */
export function findElementByTag(
  elements: readonly ElementTag[],
  tagName: string,
): ElementTag | undefined {
  const lower = tagName.toLowerCase();
  return elements.find((el) => el.name.toLowerCase() === lower);
}

export interface PromptTagSegment {
  /** Raw slice of the prompt this segment covers — plain text, or the WHOLE "@name" token including the '@'. */
  text: string;
  tag: { name: string; element: ElementTag | undefined } | null;
}

/**
 * Splits a prompt into alternating plain-text and @tag segments, in order,
 * covering the whole string with no gaps. Shared by ugc-prompt-editor.tsx's
 * mirrored overlay so the highlight logic exists in exactly one place,
 * testable without mounting a component.
 */
export function splitPromptIntoTagSegments(
  prompt: string,
  elements: readonly ElementTag[],
): PromptTagSegment[] {
  const segments: PromptTagSegment[] = [];
  // A fresh RegExp, not the shared TAG_PATTERN constant: `g`-flagged
  // RegExps carry `.lastIndex` as mutable state across calls, and reusing
  // the module-level one here would make this function's result depend on
  // whether it had already been called an odd or even number of times.
  const pattern = new RegExp(TAG_PATTERN);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(prompt))) {
    if (match.index > lastIndex) {
      segments.push({ text: prompt.slice(lastIndex, match.index), tag: null });
    }
    const name = match[1]!;
    segments.push({
      text: match[0],
      tag: { name, element: findElementByTag(elements, name) },
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < prompt.length) {
    segments.push({ text: prompt.slice(lastIndex), tag: null });
  }
  return segments;
}

/** The @tag the caret is currently sitting inside, or null when it isn't inside one. */
export interface ActiveTagQuery {
  /** Index of the '@' itself, so the caller can splice it out on completion. */
  start: number;
  /** Characters typed after '@' so far — may be empty ("@" alone). */
  query: string;
}

/**
 * Scans backward from `cursor` for the nearest '@' not separated from the
 * caret by whitespace or punctuation — i.e. the token the caret is
 * currently typing, if any. "@jen" with the caret right after it is active;
 * "@jen " (caret past the trailing space) is not, because the token is
 * already finished and autocomplete has nothing left to offer.
 */
export function activeTagQuery(prompt: string, cursor: number): ActiveTagQuery | null {
  let i = cursor;
  while (i > 0) {
    const ch = prompt[i - 1]!;
    if (ch === "@") {
      return { start: i - 1, query: prompt.slice(i, cursor) };
    }
    if (!/[A-Za-z0-9_-]/.test(ch)) {
      return null;
    }
    i--;
  }
  return null;
}

/**
 * Elements whose name starts with `query` (case-insensitive), for the
 * autocomplete list.
 *
 * EVERY KIND IS REPRESENTED, by taking a round from each non-empty kind in
 * turn rather than the first `limit` of whatever order they arrive in. A
 * plain slice let one kind take the whole menu: twelve voice clips uploaded
 * in an afternoon filled all eight rows, and the twenty-two pictures in the
 * same library were unreachable through @ — present, matching the query, and
 * never offered.
 *
 * GENERALISED TO N KINDS, not a hardcoded picture/audio zip, since a third
 * kind (video, 0093) means the starvation this function exists to prevent
 * can now happen between any two of three, not just the original two — a
 * library thick with pictures and clips could just as easily bury a matching
 * video, or the reverse. Bucketing by kind and round-robining the buckets
 * keeps the fix correct for however many kinds `elements` actually holds,
 * today or after the next one.
 *
 * Buckets are built in a FIXED priority order (pictures, audio, video), not
 * the order kinds happen to appear in `matched` — the round-robin has to
 * pick a first bucket every round, and a first-encountered order would make
 * that pick depend on upload history, which is exactly the kind of
 * no-code-change regression the original two-kind bug was.
 *
 * Alternating rather than reserving a fixed share per kind: when only one
 * kind matches the prefix it still fills the menu, which is the common case
 * once an operator has typed two or three letters.
 *
 * Order within each kind is preserved, so the caller's sort (newest first)
 * still decides which of each kind are the ones shown.
 */
/**
 * Does this element match what somebody typed into the library's search box?
 *
 * SUBSTRING, ACROSS THREE FIELDS — deliberately not matchElementsByPrefix
 * above, which exists for a different question. That one completes an @tag
 * mid-prompt, so it matches the START of the name only: you are typing the
 * identifier and it is finishing it for you. Here you are looking for a
 * reference you already saved and may only half remember, so "bottle" has to
 * find "blue_bottle_2", and the description is often the only place the thing
 * you remember was ever written down.
 *
 * aiDescription is searched alongside the human one because for a picture it
 * is usually the ONLY description — descriptionFor (element-tags.ts) already
 * treats the two as one field with a preference order, and a search that
 * disagreed with it would find nothing for exactly the elements nobody got
 * round to describing by hand.
 *
 * Caller passes the raw box contents; trimming and casing happen here so
 * every call site cannot get them subtly different. An empty or
 * whitespace-only query matches EVERYTHING rather than nothing — it means
 * "not searching", which is the state the box is in most of the time.
 */
export function elementMatchesSearch(element: ElementTag, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [element.name, element.description, element.aiDescription].some((field) =>
    field?.toLowerCase().includes(needle),
  );
}

export function matchElementsByPrefix(
  elements: readonly ElementTag[],
  query: string,
  limit = 8,
): ElementTag[] {
  const lower = query.toLowerCase();
  const matched = elements.filter((el) => el.name.toLowerCase().startsWith(lower));

  const buckets: ElementTag[][] = [
    matched.filter((el) => el.assetKind !== "audio" && el.assetKind !== "video_ref"),
    matched.filter((el) => el.assetKind === "audio"),
    matched.filter((el) => el.assetKind === "video_ref"),
  ].filter((bucket) => bucket.length > 0);

  // Nothing to alternate between with at most one kind present — the
  // starvation this function guards against needs two competing kinds.
  if (buckets.length <= 1) return matched.slice(0, limit);

  const out: ElementTag[] = [];
  for (let i = 0; out.length < limit && buckets.some((bucket) => i < bucket.length); i++) {
    for (const bucket of buckets) {
      if (out.length >= limit) break;
      const el = bucket[i];
      if (el !== undefined) out.push(el);
    }
  }
  return out;
}
