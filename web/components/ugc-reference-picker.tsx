"use client";

// The reference control's modal: Uploads and Elements tabs behind one
// trigger, replacing what used to be a single hidden <input type="file">
// opened directly via a click-through ref. Two ways in:
//
//   Uploads — pick a fresh file, name it, and press one button. That button
//   both persists it as a reusable @tag (registerElement, actions/elements.ts)
//   AND hands the file straight to the parent (ugc-column.tsx) as this
//   generation's conditioning frame.
//
//   IT USED TO BE TWO BUTTONS. "Use this image for this clip" attached the
//   file with no server round trip and nothing persisted; "Save reference"
//   persisted it and attached nothing. They could be pressed independently,
//   in either order, or just one of them — which meant the common case (use
//   this picture, and let me use it again later) took two presses, and
//   pressing only the save left the operator staring at an open dialog with
//   the clip still unattached and no sign anything had happened.
//
//   Merging them costs the "use once, save nothing" path. That is the
//   deliberate trade: every upload is now named and reusable, which is what
//   the Elements tab already implied was true. It also costs saving several
//   references back to back without reopening, since the dialog now closes on
//   success like the old attach did.
//
//   Elements — pick from references already saved this way (0065_elements.sql).
//   Picking one copies its underlying image into THIS project when the
//   clip is actually generated (actions/ugc.ts's generateClip) rather than
//   pointing at it directly — see that file's own comment for why.
//
// The hidden file input lives inside the <form> (the ActionForm wrapping
// registerElement) so the picked File — which cannot be carried in a hidden
// field — reaches the server the ordinary way, via that form's own FormData.
// Moving that input out of the form breaks the save silently, with no type
// error to catch it.
//
// THE UPLOAD TAB ASKS FOR A PICTURE AND NOTHING ELSE. Name, category and
// description used to be three fields under the dropzone; they are filled in
// by registerElement now (newN, "character", and a description Claude writes
// from the image) and corrected on the Elements tab. Asking for a name up
// front asked for it before there was anything to name it after, and an
// operator who skipped the description saved a tag that steers no render.

import { toast } from "sonner";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm } from "@/components/action-form";
import { PendingFieldset } from "@/components/pending-fieldset";
import { SubmitButton } from "@/components/submit-button";
import { ElementTagNameField } from "@/components/element-tag-name-field";
import { checkElementUploadName } from "@/actions/check-element-upload-name";
import { deleteElement, registerElement, updateElement } from "@/actions/elements";
import { stageFiles } from "@/lib/stage-files";
import { redescribeElement } from "@/actions/ugc";
import { elementDescribeEstimateUsd, uploadDescribeEstimateUsd } from "@/lib/element-describe-cost";
import { Spinner } from "@/components/spinner";
import { useUploadProgress, useUploadProgressSetter } from "@/components/upload-progress-store";
import {
  FileIcon,
  ImagePlusIcon,
  CheckIcon,
  MusicIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UploadIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { KLING_FRAME_EXTS, type ElementTag } from "@/lib/elements";
import type { AssetKind, ElementCategory } from "@/types/db";
import { cn } from "@/lib/utils";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import {
  formatFileSizeMB,
  isAcceptedReferenceAudio,
  isAcceptedReferenceAudioDuration,
  isAcceptedReferenceAudioSize,
  isAcceptedReferenceImageSize,
  isAcceptedReferenceVideo,
  isAcceptedReferenceVideoSize,
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_AUDIO_SECONDS,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_VIDEO_BYTES,
  MIN_REFERENCE_AUDIO_SECONDS,
} from "@/lib/file-type";

const ACCEPTED_IMAGE_TYPES = "image/jpeg,image/png,image/webp";

/**
 * What the file input offers. Audio joins pictures here because a voice IS a
 * reference — the same @tag mechanism, the same library, the same card —
 * differing only in which of kie's two arrays it lands in.
 *
 * The MIME list is deliberately generous on the WAV side: browsers type .wav
 * as `audio/wav`, `audio/x-wav` or `audio/wave` depending on the OS, and an
 * accept attribute that names only one of them silently greys out a valid
 * file in the picker. The extensions are listed too for the same reason
 * lib/file-type.ts falls back to them.
 */
const ACCEPTED_AUDIO_TYPES = "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,.mp3,.wav";
// 0093_video_reference_elements.sql's third kind: an uploaded .mp4 joins the
// other two as a reference for the same reason audio did — the same @tag
// mechanism, the same library, the same card. It differs from both in what
// happens after: it lands in neither of kie's two arrays (nothing reaches
// kie for a video's own bytes, ever — that stays true even now that the
// video CAN be described), only in the prompt as substituted text once it
// has a description — from a Describe press (lib/kie-video-describe.ts) or
// typed by hand, same two paths audio has.
const ACCEPTED_VIDEO_TYPES = "video/mp4,.mp4";
const ACCEPTED_REFERENCE_TYPES = `${ACCEPTED_IMAGE_TYPES},${ACCEPTED_AUDIO_TYPES},${ACCEPTED_VIDEO_TYPES}`;

/**
 * How many files one Upload may carry.
 *
 * Five is a product choice well under every vendor ceiling — kie takes 9-10
 * reference images and 3-10 audio clips depending on the model — and it is
 * not the constraint that matters here anyway. Each PICTURE costs a Claude
 * describe, and the batch runs them one after another, so five is five bills
 * and five waits. It is fewer clicks, not less money.
 */
const MAX_UPLOAD_BATCH = 5;

/**
 * The rules, in one line, for the bottom of a refusal.
 *
 * A toast that says only what was wrong answers half the question: an
 * operator told "that is 12.0MB" still does not know whether to resize it or
 * give up, and one told "already 5 files" does not learn the size ceiling
 * until they trip it separately. This is cheap to carry and it is the same
 * sentence printed inside the dropzone, so the two cannot drift apart.
 */
function referenceRules(imagesOnly = false): string {
  const pictures = `Pictures JPG, PNG or WebP up to ${formatFileSizeMB(MAX_REFERENCE_IMAGE_BYTES)}`;
  // Naming the audio/video rules on a picture-only picker tells the operator
  // a file type is allowed that the input will not even open.
  if (imagesOnly) return `${pictures}; ${MAX_UPLOAD_BATCH} at a time.`;
  const voice = `voice clips MP3 or WAV, ${MIN_REFERENCE_AUDIO_SECONDS}-${MAX_REFERENCE_AUDIO_SECONDS} seconds, up to ${formatFileSizeMB(MAX_REFERENCE_AUDIO_BYTES)}`;
  const video = `MP4 videos up to ${formatFileSizeMB(MAX_REFERENCE_VIDEO_BYTES)}`;
  return `${pictures}; ${voice}; ${video}; ${MAX_UPLOAD_BATCH} at a time.`;
}

/**
 * How long a voice clip runs, or null when the browser cannot say.
 *
 * kie refuses a reference audio outside 2-30 seconds, and it refuses it AFTER
 * the render is submitted — so measuring here is the difference between a
 * sentence in the dialog and a failed render the operator pays to discover.
 *
 * Returns null rather than throwing on an unreadable file: a browser that
 * cannot decode a container is not evidence the file is bad, and refusing
 * locally on that guess would block an upload kie would have accepted. An
 * unmeasurable clip is passed through and left to the vendor.
 */
async function audioDurationSeconds(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const probe = new Audio();
      const done = (value: number | null): void => resolve(value);
      probe.addEventListener("loadedmetadata", () => done(probe.duration), { once: true });
      probe.addEventListener("error", () => done(null), { once: true });
      probe.preload = "metadata";
      probe.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * How long a video reference runs, or null when the browser cannot say —
 * audioDurationSeconds' own twin, one <video> element in place of one
 * <audio>, same null-on-failure discipline and the same reason for it: a
 * container this browser decodes oddly is not evidence the file is bad, and
 * refusing locally on that guess would block an upload kie's describe step
 * (lib/kie-video-describe.ts) would have accepted anyway.
 *
 * UNLIKE THE AUDIO TWIN, THIS NUMBER IS NEVER A REJECTION — there is no
 * MIN/MAX_REFERENCE_VIDEO_SECONDS the way there is for a voice clip, so
 * nothing here drops the file or shows a toast. What it IS for is money, not
 * validity: kie bills a render that tags this element at
 * Price x (this many input seconds + the scene's own output seconds), not
 * Price x output alone (lib/kie/rates.ts's VIDEO_INPUT_PRICING), so the
 * saved batch below sends this value on to registerElement, which writes it
 * to assets.duration_s — and a null that reaches there is registerElement's
 * own cue to price this element's INPUT as unknown rather than free. See
 * that function's own comment on `measuredVideoDurationS` for the other
 * half.
 */
async function videoDurationSeconds(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const probe = document.createElement("video");
      const done = (value: number | null): void => resolve(value);
      probe.addEventListener("loadedmetadata", () => done(probe.duration), { once: true });
      probe.addEventListener("error", () => done(null), { once: true });
      probe.preload = "metadata";
      probe.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Measures a video reference and attaches the result to the FormData about
 * to reach registerElement — the only channel assets.duration_s can be
 * written from, since that action has no way to decode the file itself
 * (see its own comment on `measuredVideoDurationS`). A no-op for anything
 * that is not a video: an image or an audio file has no duration this
 * pricing formula cares about, and setting the field regardless would read
 * as a video reference's measurement on the wrong kind of upload.
 *
 * LEAVES THE FIELD UNSET, NOT SET TO EMPTY, when videoDurationSeconds
 * returns null — registerElement's own `Number(formData.get("durationS"))`
 * turns a missing field into NaN and a null measuredVideoDurationS exactly
 * the same way it would an explicit "null" string, so there is no
 * behavioural difference, but an absent field is the more honest shape for
 * "we asked and the browser could not say" than a string spelling that out
 * would be.
 */
async function attachVideoDuration(fd: FormData, file: File): Promise<number | null | undefined> {
  if (!isAcceptedReferenceVideo(file)) return undefined;
  const seconds = await videoDurationSeconds(file);
  if (seconds !== null && Number.isFinite(seconds) && seconds > 0) {
    fd.set("durationS", String(seconds));
    return seconds;
  }
  return null;
}

/**
 * Does this asset belong under this filter pill?
 *
 * THREE-WAY, and it used to be a two-way binary:
 *
 *   (el.assetKind === "audio") === (categoryFilter === "audio")
 *
 * which is correct for exactly two kinds and silently wrong for a third. A
 * video is not audio, and under the Image pill the filter is not audio
 * either, so `false === false` held and **every video listed itself as a
 * picture**. Nobody had reported it because there was no Video pill to
 * contradict it — adding one without rewriting this would have been worse,
 * not better: the same clip would then appear under Image AND Video.
 *
 * READS THE ASSET, NOT THE LABEL, which is the older rule this replaces
 * rather than repeals. `category` is a label that has meant different things
 * at different times: every row saved before 0081 carries character, product
 * or location, and a picture filed as "character" is still a picture. That is
 * why the image arm asks IMAGE_ASSET_KINDS — the same allowlist
 * actions/ugc.ts uses to decide what may become a conditioning frame — and
 * not whether the category happens to read "image".
 */
function matchesFilter(assetKind: AssetKind, filter: ElementCategory): boolean {
  if (filter === "audio") return assetKind === "audio";
  if (filter === "video") return assetKind === "video_ref";
  if (filter === "image") return IMAGE_ASSET_KINDS.has(assetKind);
  // A pre-0081 label (character, product, location) is never a pill the UI
  // offers, so this is unreachable from the filter row. Answering false
  // rather than true keeps an unknown filter showing nothing instead of
  // everything, which is the direction that reads as a bug rather than
  // hiding one.
  return false;
}

const CATEGORY_LABEL: Record<ElementCategory, string> = {
  // The three the UI offers: what the reference IS. Image and audio since
  // 0081; video joins them at 0093.
  image: "Image",
  audio: "Audio",
  video: "Video",
  // The four it no longer offers. Rows saved before 0081 still carry these
  // and still have to render a label somewhere — the detail panel shows the
  // stored value even when it is not one of the choices, so dropping them
  // here would print `undefined` on somebody's older reference.
  character: "Character",
  product: "Product",
  location: "Location",
  voice: "Voice",
};

/**
 * Kinds whose card must SAY when a description is missing.
 *
 * All three kinds are described automatically at upload now — pictures via
 * Claude, voices via lib/kie-audio-describe.ts since #94, clips via
 * lib/kie-video-describe.ts — so this is no longer "the kinds that arrive
 * undescribed", which is what it used to mean and what its old comment still
 * claimed after audio stopped being one of them.
 *
 * What actually separates these two from a picture is that THE CARD SHOWS
 * NOTHING ABOUT THEM. A picture's tile is the picture, so an operator can see
 * what they uploaded whether or not any text was written about it. A voice
 * and a clip both render the same flat icon, so a missing description is
 * invisible unless the card says so — hence the amber badge and the Describe
 * button on these two only. That reason is independent of when describing
 * happens, which is why the behaviour outlived the explanation.
 */
function needsHandWrittenDescription(el: Pick<ElementTag, "assetKind">): boolean {
  return el.assetKind === "audio" || el.assetKind === "video_ref";
}

/**
 * What this control hands the parent.
 *
 * THE "element" BRANCH HAS NO PRODUCER HERE ANY MORE. Picking a saved element
 * used to attach it to the clip as a conditioning frame; a reference now
 * reaches a clip by being typed as @name in the prompt, and this dialog's
 * Elements tab is a library manager. The branch stays because the parent still
 * accepts and renders it (a project can carry an element-backed reference from
 * elsewhere), and because deleting it would be a schema change dressed as a
 * cleanup.
 */
export type PickedReference =
  | {
      kind: "upload";
      file: File;
      name: string;
      previewUrl: string;
      /** Browser-measured duration for a direct Gemini source-video upload. */
      durationS?: number | null;
    }
  | { kind: "element"; elementId: string; name: string; previewUrl: string };

/**
 * Identifies one exact set of edits, so a refused save can be recognised if it
 * comes round again. The name is normalised the same way the save normalises
 * it — otherwise typing and deleting an '@' would look like a different
 * attempt and re-offer a save the server has already refused.
 */
function editKeyFor(
  elementId: string,
  name: string,
  category: ElementCategory,
  description: string,
): string {
  return [elementId, name.replace(/^@+/, "").trim(), category, description.trim()].join("\u0000");
}

/** "a and b" / "a, b, and c" — never a bare comma-joined list once there are three or more. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * The end-of-batch toast — fired once a save loop (saveElement/retryOne)
 * finishes, regardless of whether the dialog that started it is still open.
 *
 * THIS IS THE ONE CHANNEL A CLOSED DIALOG CANNOT SWALLOW. Everything else a
 * batch reports — the per-row bars, the "Uploading N of M" line, the
 * "N references saved" banner — lives inside the dialog's own JSX and goes
 * away the instant Radix unmounts DialogContent. sonner's toast() does not
 * care whether anything is mounted, so it is the only outcome an operator
 * who closed mid-batch is guaranteed to actually see.
 *
 * NAMES THE FAILURES, NOT JUST A COUNT. "4 of 5 saved" with no name means
 * scrolling the whole Elements grid hunting for which one did not land —
 * the grid is not sorted by recency and a new row's default name (newN)
 * gives no hint which upload it came from. Naming the file is the only
 * version of this message that tells the operator what to do next without
 * making them go look.
 *
 * SEPARATE FROM registerElement's OWN NOTICE (a picture/clip that saved but
 * could not be described — see the `notice` branches in saveElement and
 * retryOne). "Could not upload" and "uploaded but not described" are
 * different failures with different remedies (retry the upload vs. press
 * Describe on the card), and collapsing them into one toast would leave an
 * operator retrying an upload that already succeeded.
 */
function reportUploadOutcome(fileNames: readonly string[], errors: Record<number, string>): void {
  const total = fileNames.length;
  if (total === 0) return;
  const failedIndexes = Object.keys(errors).map(Number);
  const failedNames = failedIndexes.map((i) => fileNames[i]).filter((n): n is string => !!n);
  const saved = total - failedNames.length;

  if (failedNames.length === 0) {
    toast(saved === 1 ? "1 reference saved." : `${saved} references saved.`);
    return;
  }

  if (saved === 0) {
    toast.error(
      total === 1 ? `Could not save ${failedNames[0]}` : `Could not save any of ${total} files`,
      {
        description:
          failedNames.length === 1
            ? errors[failedIndexes[0]!]
            : `${joinNames(failedNames)} all failed to upload.`,
      },
    );
    return;
  }

  toast.error(`${saved} of ${total} saved`, {
    description:
      failedNames.length === 1
        ? `${failedNames[0]} could not be saved: ${errors[failedIndexes[0]!]}`
        : `${joinNames(failedNames)} could not be saved.`,
  });
}

export function UgcReferencePicker({
  projectId,
  elements,
  current,
  onPick,
  allowVideoPrimary = false,
  imagesOnly = false,
  elementsOnly = false,
  initialTab,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
  onUseElement,
  boxTags,
  boxLimit,
}: {
  projectId: string | null;
  /** The operator's own saved references — resolved server-side, signed thumbnail URLs included. */
  elements: readonly ElementTag[];
  current: PickedReference | null;
  onPick: (reference: PickedReference) => void;
  /** Allow the UGC Gemini form to attach one measured MP4 as its primary input. */
  allowVideoPrimary?: boolean;
  /**
   * Pictures only — no voice clips offered, accepted or filtered for.
   *
   * The Image Generator (/images/[id]) sets this. An image model has nowhere to
   * put a sound: kie's reference_audio_urls belongs to the VIDEO models, and
   * google/nano-banana-edit takes image_urls and nothing else. Offering an MP3
   * here would let an operator attach one, watch it be silently dropped
   * server-side, and reasonably conclude the reference did something.
   *
   * Defaults false so /ugc — which really does send both — is untouched.
   */
  imagesOnly?: boolean;
  /**
   * Elements tab only — no Uploads tab, no Uploads TabsTrigger, and no way
   * to reach one. ugc-column.tsx's Kling Start/End frame slots set this: a
   * frame is picked from the operator's saved elements, never a fresh
   * upload, so a tab that leads nowhere the caller can use has no reason to
   * be on screen.
   *
   * IMPLIES imagesOnly, regardless of what that prop was passed — a slot
   * with no Uploads tab still has to keep audio and video out of the
   * Elements grid it DOES show, and asking the caller to pass both is a way
   * for the two to disagree. See restrictToImages below, which is what
   * actually reads this.
   */
  elementsOnly?: boolean;
  /**
   * Which tab the dialog opens on. Defaults to "uploads" — the trigger below,
   * which is the only way most callers ever open this dialog, has always
   * landed there.
   *
   * ugc-column.tsx's References box passes "elements": its whole point is
   * reusing an operator's SAVED references, and landing an operator who just
   * pressed "Add references" on an empty Uploads tab would send them past the
   * elements they opened the dialog to pick from.
   */
  initialTab?: "uploads" | "elements";
  /**
   * CONTROLLED OPEN, for the box's second instance of this dialog — see
   * hideTrigger below. Optional: every other caller (the settings row's own
   * Upload button, and /images/[id]) leaves this undefined and the dialog
   * keeps managing its own open state exactly as before.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Omits the built-in Upload trigger button. Set by the References box,
   * which renders its own "Add" tile as the thing that opens this dialog —
   * a SECOND visible control that also said "Upload" would be a second
   * thing on screen claiming to be the one way in.
   *
   * The Dialog itself still needs somewhere to open FROM without a trigger of
   * its own, which is exactly what the `open`/`onOpenChange` pair above is
   * for — hideTrigger is meaningless without them.
   */
  hideTrigger?: boolean;
  /**
   * Elements tab only. Renders "Use element" in the detail panel; pressing
   * it hands the selected element to the parent and closes the dialog.
   *
   * Optional: callers that generate from @tags use this to add the selected
   * element to their prompt. Other callers keep the read/manage detail panel.
   */
  onUseElement?: (el: ElementTag) => void;
  /** The box's own current contents, for "Already in this scene" below. */
  boxTags?: readonly string[];
  /** The box's cap, for "References are full (N)" below. */
  boxLimit?: number;
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false);
  // CONTROLLED WHEN `openProp` IS GIVEN, uncontrolled otherwise — the same
  // "prop wins if present" shape as `current` above. Every existing caller
  // leaves `open` undefined and gets back exactly the self-managed dialog
  // this always was; only the box's second, trigger-less instance passes it.
  const open = openProp ?? internalOpen;
  function addProjectId(formData: FormData): void {
    if (projectId) formData.set("projectId", projectId);
  }
  function setOpen(next: boolean): void {
    setInternalOpen(next);
    onOpenChange?.(next);
  }
  /**
   * The files chosen and not yet uploaded, newest last, at most MAX_UPLOAD_BATCH.
   *
   * A LIST SINCE 2026-09-05. It was one file, and filling the library meant
   * one full trip through this dialog per reference — drop, wait for the
   * describe, close, repeat. Five operators had put 35 elements in that way.
   *
   * Kept as a pair of parallel arrays rather than one array of objects
   * because the object URL has its own lifecycle: it is revoked on removal
   * and deliberately NOT revoked on the file that gets attached to the clip,
   * which is the asymmetry saveElement documents below.
   */
  const [uploadNames, setUploadNames] = useState<Map<File, string>>(new Map());
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingPreviewUrls, setPendingPreviewUrls] = useState<string[]>([]);
  // Which saved element is being described again, and what the last attempt
  // said. Keyed by id because the grid can hold many and only one is in
  // flight at a time.
  const [redescribing, setRedescribing] = useState<string | null>(null);
  const [redescribed, setRedescribed] = useState<Record<string, string>>({});
  const [redescribeError, setRedescribeError] = useState<string | null>(null);
  // Which element is mid-delete, and which one is one press from it. Two
  // states because a destructive action on a grid of near-identical
  // thumbnails needs the second press to name what it is about to remove.
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<string[]>([]);
  // THE ID, NOT A BOOLEAN. An expired signed URL fails silently on a
  // <video> (see the detail panel below), and the fallback is per-element —
  // keying on the id rather than a plain flag means switching to a
  // different video automatically clears it, with no effect needed to
  // reset it by hand.
  const [failedVideoId, setFailedVideoId] = useState<string | null>(null);
  // Which card is open for editing, the fields while it is, and what the last
  // save said. Optimistic in the same one direction the delete is: the server
  // revalidates the page, but the dialog the operator is standing in does not
  // re-render from that, so a successful save is reflected here by hand.
  const [selected, setSelected] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState<ElementCategory>("character");
  const [editDescription, setEditDescription] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  /** Shows "Saved" for a moment after an autosave lands, then gets out of the way. */
  const [justSaved, setJustSaved] = useState(false);
  /**
   * The exact field values whose save was REFUSED, so the debounce does not
   * offer them again.
   *
   * Without this an autosave that fails retries forever. The effect below
   * re-runs when `savingEdit` drops back to false, finds the panel still
   * dirty, and schedules the same doomed save 500ms later — one server round
   * trip every half second, for as long as the operator leaves the dialog
   * open. Seen in production: renaming a reference onto a name that already
   * existed turned "You already have a reference named …" into an infinite
   * request loop behind it.
   *
   * Keyed by the values rather than a boolean, so the moment the operator
   * changes ANY of them the save is offered again — which is the whole
   * remedy, and the only one they have.
   */
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  const [edited, setEdited] = useState<
    Record<string, { name: string; category: ElementCategory; description: string | null }>
  >({});
  const [categoryFilter, setCategoryFilter] = useState<ElementCategory | "all">("all");
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * The current batch, readable from an async callback.
   *
   * `checkAudioLength` measures a clip AFTER it has been added — decoding is
   * not instant, and holding the row back until it finishes would make a
   * dropped file look like it went nowhere. By the time the answer arrives
   * the operator may have added or removed others, so the position to drop
   * cannot be the one captured when the check started.
   */
  const pendingRef = useRef<File[]>([]);
  // Written in an effect, not during render: React reserves render for
  // producing output, and a ref assigned there can be skipped or run twice.
  // The batch is only ever READ from this after an await, so a value that
  // lands at commit is early enough.
  useEffect(() => {
    pendingRef.current = pendingFiles;
  }, [pendingFiles]);
  /**
   * How far through the batch the save is, or null when nothing is saving.
   *
   * REAL PROGRESS, not a spinner. The batch is a sequential loop over known
   * files, so "3 of 5" is a fact rather than an animation — and with a
   * Claude describe on every picture, a five-file upload is long enough that
   * an operator needs to know it is moving and roughly how much is left.
   *
   * LIVES IN upload-progress-store.tsx'S STORE, NOT IN A `useState` HERE.
   * This used to be local state, and that was the bug: `saveElement` awaits
   * a `registerElement` call per file inside a plain async function, which
   * keeps running after this dialog closes (Radix unmounts DialogContent on
   * close, but nothing about a running async function is tied to that — see
   * this file's own header). A `setState` dispatched after that point is
   * silently dropped, so the operator who closed mid-batch got no progress,
   * no completion, nothing — the exact bug the app-wide bar exists to fix.
   * A store update reaches that bar directly, with no component in between
   * that could be unmounted out from under it, so `saveElement`/`retryOne`
   * keep reporting truthfully for as long as they keep running. Read here
   * with the same hook the bar uses, so the in-dialog "3 of 5" and the
   * bar at the top of the viewport are never two representations that can
   * drift apart — one store, two readers.
   */
  const uploadProgress = useUploadProgress();
  const setUploadProgress = useUploadProgressSetter();
  /**
   * Set for exactly as long as a loop below (`saveElement`/`retryOne`) is
   * still writing to `pendingFiles`/`pendingPreviewUrls`/`fileErrors` — a
   * plain ref, not state, because it has to be read synchronously from
   * `onOpenChange` (see `resetUploadState`) and a ref survives the read
   * happening between renders where a fresh `useState` closure would not.
   */
  const isSavingRef = useRef(false);
  /**
   * Per-file outcome, keyed by position in `pendingFiles`.
   *
   * ONE FAILURE NO LONGER STOPS THE BATCH. It used to return at the first
   * error, which meant a single 20 MB picture in the middle of five left the
   * last two unattempted and the operator with no idea which — and the fix
   * was to press Upload again and watch the same three re-run. Every file is
   * now attempted, each keeps its own verdict, and only the failures stay
   * behind with a Retry.
   */
  const [fileErrors, setFileErrors] = useState<Record<number, string>>({});
  /** How many landed on the last run, for the line that says what to do next. */
  const [savedCount, setSavedCount] = useState(0);
  // elementsOnly FORCES "elements" as the starting tab, regardless of what
  // initialTab said — there is no Uploads tab in this mode for a caller to
  // land on by omission, and a caller that also passed initialTab="uploads"
  // by mistake would otherwise open on a tab this render never mounts.
  const [tab, setTab] = useState<string>(elementsOnly ? "elements" : (initialTab ?? "uploads"));
  // Back to initialTab on every open, not only the first. The box's instance
  // is opened by its parent through `open`, so setOpen never runs on the way
  // in; without this, a switch to Uploads inside the box's dialog would stick
  // and the next "Add references" would open on the wrong tab.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      if (elementsOnly) setTab("elements");
      else if (initialTab) setTab(initialTab);
    }
  }
  /**
   * IMAGES-ONLY, EITHER WAY IN. `imagesOnly` on its own is the Image
   * Generator's flag; `elementsOnly` (Kling's frame slots) implies it too —
   * see that prop's own comment for why asking the caller to pass both
   * would be a way for them to disagree.
   */
  const restrictToImages = imagesOnly || elementsOnly;

  function resetUploadState(): void {
    // GUARDED WHILE A LOOP IS STILL WRITING. This runs from onOpenChange on
    // every close, including the mid-batch close this whole change exists
    // for — and saveElement/retryOne are still awaiting registerElement
    // calls at that instant, still meaning to update pendingFiles,
    // pendingPreviewUrls and fileErrors themselves. Clearing them out from
    // under a loop that has not finished writing to them is a straight race:
    // whichever write lands last wins, and there is no reason it would be
    // this one. Skipping the clear here does not stop the loop (nothing in
    // this file does, on purpose — see the header) or lose its result: the
    // loop's own tail already clears what it's responsible for on success,
    // and the batch-outcome toast (reportUploadOutcome) is the channel that
    // survives the close either way.
    if (isSavingRef.current) return;
    setPendingFiles([]);
    setUploadNames(new Map());
    setPendingPreviewUrls((old) => {
      for (const u of old) URL.revokeObjectURL(u);
      return [];
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  /**
   * Everything that has to happen when files arrive, from the browse dialog or
   * from a drop.
   *
   * APPENDS rather than replaces, so a second drag adds to the batch instead
   * of throwing the first one away — the operator filling a library is
   * gathering, not correcting. Over the cap, the extras are dropped and the
   * message says how many, because silently keeping five of eight is how
   * someone later wonders which three are missing.
   */
  function acceptFiles(files: File[]): void {
    if (files.length === 0) return;

    // SIZE IS DECIDED HERE, NOT AT THE SERVER. Both ceilings were already
    // enforced in registerElement, but only after the whole file had been
    // pushed through a Server Action — so a 40 MB picture spent its upload
    // before being told no, and in a batch of five it took the other four's
    // turn with it. The number is known the moment the file is chosen.
    const tooBig = files.filter((f) =>
      isAcceptedReferenceAudio(f)
        ? !isAcceptedReferenceAudioSize(f)
        : isAcceptedReferenceVideo(f)
          ? !isAcceptedReferenceVideoSize(f)
          : !isAcceptedReferenceImageSize(f),
    );
    // TITLE SAYS WHICH FILE, DESCRIPTION SAYS WHY AND WHAT TO DO. One line
    // carrying all three ("kinoko_mushroom_coffee_front.png is 12.0MB —
    // pictures have to be under 10.0MB") is read as a single run of text
    // where the filename crowds out the rule, and a toast is gone in four
    // seconds.
    for (const f of tooBig) {
      const audio = isAcceptedReferenceAudio(f);
      const video = !audio && isAcceptedReferenceVideo(f);
      const label = audio ? "voice clip" : video ? "video" : "picture";
      const limit = audio
        ? MAX_REFERENCE_AUDIO_BYTES
        : video
          ? MAX_REFERENCE_VIDEO_BYTES
          : MAX_REFERENCE_IMAGE_BYTES;
      toast.error(`${f.name} is too big`, {
        description: `It is ${formatFileSizeMB(f.size)}. A ${label} has to be under ${formatFileSizeMB(
          limit,
        )}, so it was not added. ${referenceRules(imagesOnly)}`,
      });
    }
    // THE SAME FILE TWICE IS NEVER THE INTENT. Two drags of one folder, or
    // a second browse that re-picks what is already listed, put the identical
    // picture in the batch twice — and the batch does not merge them: it
    // saves two elements, generates two descriptions at two Claude calls, and
    // leaves the operator two @tags naming the same face with nothing to tell
    // them apart. It cost real money before it cost confusion.
    //
    // Name, size and mtime together, because File carries no identity: the
    // same file chosen twice is two distinct objects, so `includes` on the
    // array cannot see it.
    const identity = (f: File): string => `${f.name}:${f.size}:${f.lastModified}`;
    const already = new Set(pendingFiles.map(identity));
    const sized: File[] = [];
    let duplicates = 0;
    for (const f of files) {
      if (tooBig.includes(f)) continue;
      const key = identity(f);
      if (already.has(key)) {
        duplicates += 1;
        continue;
      }
      already.add(key);
      sized.push(f);
    }
    if (duplicates > 0) {
      toast.error(
        duplicates === 1 ? "That one is already listed" : `${duplicates} were already listed`,
        {
          description:
            "The same file twice would save two references with the same picture and two @tags that cannot be told apart, so it was skipped.",
        },
      );
    }
    if (sized.length === 0) return;

    const room = MAX_UPLOAD_BATCH - pendingFiles.length;
    if (room <= 0) {
      toast.error(`Already ${MAX_UPLOAD_BATCH} files`, {
        description: `${MAX_UPLOAD_BATCH} is the most that can go up at once. Press Upload, then drag the rest in. ${referenceRules(imagesOnly)}`,
      });
      return;
    }
    const taken = sized.slice(0, room);
    if (taken.length < sized.length) {
      toast.error(`Only ${MAX_UPLOAD_BATCH} files at a time`, {
        description: `Kept the first ${taken.length} of ${sized.length}. Press Upload, then drag the other ${sized.length - taken.length} in. ${referenceRules(imagesOnly)}`,
      });
    }

    setPendingFiles((old) => [...old, ...taken]);
    setPendingPreviewUrls((old) => [...old, ...taken.map((f) => URL.createObjectURL(f))]);
    for (const f of taken) if (isAcceptedReferenceAudio(f)) void checkAudioLength(f);
  }

  /**
   * Re-attempts one failed file, leaving the rest of the batch alone.
   *
   * The row keeps its place while it runs, because moving it would take the
   * Retry button out from under the cursor that just pressed it.
   *
   * SAME LOOP-SURVIVES-THE-CLOSE SHAPE AS saveElement, for a batch of one:
   * isSavingRef holds resetUploadState off while this is in flight, progress
   * goes to the shared store rather than local state, and the outcome is
   * reported as a toast so a dialog closed the instant after Retry was
   * pressed still tells the operator what happened.
   */
  async function retryOne(index: number): Promise<void> {
    const f = pendingFiles[index];
    if (!f || uploadProgress !== null) return;

    isSavingRef.current = true;
    setUploadProgress({ done: index, total: pendingFiles.length });
    try {
      const fd = new FormData();
      addProjectId(fd);
      fd.set("image", f);
      const name = (uploadNames.get(f) ?? "").trim();
      const nameError = await checkElementUploadName(name);
      if (nameError) {
        setFileErrors((old) => ({ ...old, [index]: nameError }));
        toast.error(nameError);
        return;
      }
      if (
        !window.confirm(
          `Upload and describe @${name}? Estimated description cost: $${uploadDescribeEstimateUsd(f).toFixed(4)}. Voice and video retries may cost more.`,
        )
      ) return;
      fd.set("name", name);
      await attachVideoDuration(fd, f);
      await stageFiles(fd);
      const one = await registerElement(fd);

      if (one && "error" in one && one.error) {
        setFileErrors((old) => ({ ...old, [index]: one.error }));
        reportUploadOutcome([f.name], { 0: one.error });
        return;
      }
      // NOT toast.error — the upload landed. This is registerElement saying a
      // voice clip could not be described, the same "not toast.error"
      // reasoning action-form.tsx's own handler follows for an ActionNotice:
      // the work happened, and the element's card already carries a visible
      // "not described yet" state, so this toast is the immediate half of that
      // — the operator does not have to go find the card to learn something
      // needs a second look.
      if (one && "notice" in one && one.notice) {
        toast(one.notice, { duration: 8000 });
      }
      reportUploadOutcome([f.name], {});
      setSavedCount((n) => n + 1);
      removePending(index);
      setFileErrors((old) => {
        // Re-keyed: every error after the removed row has shifted down one.
        const next: Record<number, string> = {};
        for (const [k, v] of Object.entries(old)) {
          const i = Number(k);
          if (i < index) next[i] = v;
          else if (i > index) next[i - 1] = v;
        }
        return next;
      });
    } finally {
      setUploadProgress(null);
      isSavingRef.current = false;
    }
  }

  /** Drops one file from the batch and revokes only ITS preview URL. */
  function removePending(index: number): void {
    setPendingFiles((old) => old.filter((_, i) => i !== index));
    setPendingPreviewUrls((old) => {
      const url = old[index];
      if (url) URL.revokeObjectURL(url);
      return old.filter((_, i) => i !== index);
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>): void {
    acceptFiles(Array.from(e.target.files ?? []));
  }

  /**
   * Measures a voice clip and drops it if kie would refuse the length.
   *
   * THIS USED TO BE ADVISORY — a red line under the box while the file
   * stayed in the batch and Upload stayed live. The reasoning was that the
   * measurement could be wrong; what it produced was an upload that ran its
   * full course and failed at kie, with a warning nobody connects to the
   * failure. A clip outside 2-30s is refused by the vendor with certainty,
   * so keeping it in the batch only buys a slower no.
   *
   * A clip that CANNOT be measured is still passed through, which is where
   * the old reasoning does hold: `audioDurationSeconds` returns null for a
   * container this browser decodes oddly, and refusing on a failed read
   * would block a file kie would have taken.
   *
   * Runs after the file is added rather than before, so the preview and the
   * filename appear immediately and the verdict arrives when it is known —
   * decoding metadata is not instant on a large WAV.
   */
  async function checkAudioLength(file: File): Promise<void> {
    if (!isAcceptedReferenceAudio(file)) return;
    const seconds = await audioDurationSeconds(file);
    if (seconds === null || isAcceptedReferenceAudioDuration(seconds)) return;

    // GONE ALREADY IS NOT A PROBLEM. Measuring takes long enough that the
    // operator can have pulled the row themselves first, and a toast naming a
    // file they already removed reads as a second, separate failure.
    const index = pendingRef.current.indexOf(file);
    if (index === -1) return;
    removePending(index);
    toast.error(`${file.name} is too ${seconds < MIN_REFERENCE_AUDIO_SECONDS ? "short" : "long"}`, {
      description: `It is ${seconds.toFixed(1)} seconds. A voice clip has to be between ${MIN_REFERENCE_AUDIO_SECONDS} and ${MAX_REFERENCE_AUDIO_SECONDS} seconds, so it was removed. ${referenceRules(imagesOnly)}`,
    });
  }

  /**
   * True while the save is in flight.
   *
   * Read off the hidden <input>, not from useFormStatus: that hook only
   * answers inside a component rendered BENEATH the <form>, and this component
   * is the one rendering it. The input sits in the same PendingFieldset as
   * everything else, so the browser has already set .disabled on it — which
   * makes it the honest source, since it is the very flag that decides whether
   * the controls respond at all.
   */
  function saving(): boolean {
    return fileRef.current?.disabled === true;
  }

  function handleDrop(e: ReactDragEvent<HTMLButtonElement>): void {
    e.preventDefault();
    setDragging(false);
    // A disabled <button> gets no click, but a drop is not a click, and
    // whether one lands on a disabled control is not something to leave to the
    // browser when the answer is an upload replacing itself mid-flight.
    if (saving()) return;

    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length === 0) return;

    // A DROP CAN CARRY ANY OF THE THREE KINDS, and `accept` on the input
    // filters only the browse dialog, so this is the only place a dropped
    // file's type is checked at all.
    //
    // WRONG TYPES ARE DROPPED, NOT REFUSED WHOLESALE. Dragging a folder's
    // worth of files onto this box is the point of the batch; refusing all
    // eight because one was a .txt would make the operator find and remove it
    // by hand. The message says how many were left out.
    const usable = dropped.filter(
      (f) =>
        ACCEPTED_IMAGE_TYPES.split(",").includes(f.type) ||
        (!imagesOnly && isAcceptedReferenceAudio(f)) ||
        (!imagesOnly && isAcceptedReferenceVideo(f)),
    );
    if (usable.length === 0) {
      toast.error("Nothing there can be used as a reference", {
        description: imagesOnly
          ? `Nothing dropped was a picture. ${referenceRules(true)}`
          : `Nothing dropped was a picture, a voice clip, or a video. ${referenceRules(imagesOnly)}`,
      });
      return;
    }
    if (usable.length < dropped.length) {
      toast.error(`Skipped ${dropped.length - usable.length} of ${dropped.length} files`, {
        description: `The rest were added. ${referenceRules(imagesOnly)}`,
      });
    }

    acceptFiles(usable);
  }

  /**
   * Asks for a fresh description of an element that is already saved.
   *
   * Writes, unlike the upload path — there is no textarea here, so the new
   * text is stored and shown in place. The optimistic copy in `redescribed`
   * is what the grid renders afterwards: the server action revalidates, but
   * the operator pressed a button and should see the answer without waiting
   * for a round trip through the page.
   */
  async function redescribe(element: ElementTag): Promise<void> {
    if (redescribing) return;
    const kind =
      element.assetKind === "audio"
        ? "audio"
        : element.assetKind === "video_ref"
          ? "video"
          : "image";
    if (
      !window.confirm(
        `Describe @${element.name}? Estimated cost: $${elementDescribeEstimateUsd(kind).toFixed(4)}.`,
      )
    ) return;
    const elementId = element.id;
    setRedescribing(elementId);
    setRedescribeError(null);
    try {
      const formData = new FormData();
      addProjectId(formData);
      formData.set("elementId", elementId);
      const result = await redescribeElement(formData);
      if ("error" in result) {
        setRedescribeError(result.error);
        return;
      }
      setRedescribed((old) => ({ ...old, [elementId]: result.description }));
      // AND INTO THE BOX THE OPERATOR IS LOOKING AT. `redescribed` is what the
      // grid reads; the panel's textarea is a controlled field seeded when the
      // element was selected, so without this the new sentence lands somewhere
      // invisible. Worse than invisible: `detailIsDirty` compares the textarea
      // against the freshly-described text, so the stale words in the box
      // start counting as an unsaved edit — and Save would write them back
      // over the description that was just paid for.
      if (elementId === selected) setEditDescription(result.description);
    } catch (err) {
      setRedescribeError(
        err instanceof Error ? err.message : "Could not describe that reference again.",
      );
    } finally {
      setRedescribing(null);
    }
  }

  /**
   * Opens an element in the detail panel and seeds the fields from it.
   *
   * Seeding on selection rather than binding straight to the element is what
   * lets the panel hold unsaved edits — and what makes `detailIsDirty` below
   * a real question rather than always false.
   */
  /**
   * "Use element", from either the detail panel's button or a double-click
   * on the card. One function so the two can never disagree about when an
   * element may join the box.
   *
   * A blocked double-click says why in a toast: the button can show its
   * disabled label, but a card that ignores a double-click would be a
   * silent refusal.
   */
  function pickIntoBox(el: ElementTag): void {
    if (!onUseElement) return;
    const alreadyIn = (boxTags ?? []).some((t) => t.toLowerCase() === el.name.toLowerCase());
    if (alreadyIn) {
      toast(`@${el.name} is already in this scene.`);
      return;
    }
    if (boxLimit !== undefined && (boxTags?.length ?? 0) >= boxLimit) {
      toast(`References are full (${boxLimit}). Remove one to add another.`);
      return;
    }
    onUseElement(el);
    setOpen(false);
  }

  /**
   * Several at once: Shift+click toggles a tile, dragging a box over the grid
   * selects what it touches, and "Use N" adds them all. Off for the Kling
   * frame slots (elementsOnly) — a slot holds one frame.
   */
  const multiOk = onUseElement !== undefined && !elementsOnly;
  const [multi, setMulti] = useState<string[]>([]);
  const boxStart = useRef<{ x: number; y: number; base: string[]; active: boolean } | null>(null);
  // A box drag ends in a click on whatever tile it started on; swallow it.
  const justBoxed = useRef(false);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  function toggleMulti(id: string): void {
    setMulti((prev) => {
      // The first Shift+click keeps the tile already open in the panel.
      const seeded = prev.length === 0 && selected !== null && selected !== id ? [selected] : prev;
      return seeded.includes(id) ? seeded.filter((x) => x !== id) : [...seeded, id];
    });
  }

  /** Pointer position in the grid's scrolled content, the space offsetTop lives in. */
  function gridPoint(e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } {
    const grid = e.currentTarget;
    const r = grid.getBoundingClientRect();
    return { x: e.clientX - r.left + grid.scrollLeft, y: e.clientY - r.top + grid.scrollTop };
  }

  function boxDown(e: ReactPointerEvent<HTMLDivElement>): void {
    justBoxed.current = false;
    if (!multiOk || e.button !== 0) return;
    boxStart.current = { ...gridPoint(e), base: e.shiftKey ? multi : [], active: false };
  }

  function boxMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const start = boxStart.current;
    if (!start) return;
    const p = gridPoint(e);
    if (!start.active) {
      // A few pixels of wobble is still a click.
      if (Math.hypot(p.x - start.x, p.y - start.y) < 6) return;
      start.active = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const next = {
      x: Math.min(p.x, start.x),
      y: Math.min(p.y, start.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    };
    setBox(next);
    const hit = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-element-id]"))
      .filter(
        (t) =>
          t.offsetLeft < next.x + next.w &&
          t.offsetLeft + t.offsetWidth > next.x &&
          t.offsetTop < next.y + next.h &&
          t.offsetTop + t.offsetHeight > next.y,
      )
      .map((t) => t.dataset.elementId as string);
    setMulti([...start.base, ...hit.filter((id) => !start.base.includes(id))]);
  }

  function boxUp(): void {
    justBoxed.current = boxStart.current?.active ?? false;
    boxStart.current = null;
    setBox(null);
  }

  /** "Use N": the same refusals pickIntoBox makes, counted instead of toasted one by one. */
  function addMany(): void {
    if (!onUseElement) return;
    const taken = (boxTags ?? []).map((t) => t.toLowerCase());
    let room = boxLimit === undefined ? Infinity : boxLimit - taken.length;
    let skipped = 0;
    for (const el of filteredElements) {
      if (!multi.includes(el.id)) continue;
      const name = edited[el.id]?.name ?? el.name;
      if (taken.includes(name.toLowerCase()) || room <= 0) {
        skipped++;
        continue;
      }
      onUseElement({ ...el, name });
      room--;
    }
    if (skipped > 0) {
      toast(`${skipped} not added — already in this scene, or references are full.`);
    }
    setMulti([]);
    setOpen(false);
  }

  function selectElement(el: ElementTag): void {
    const local = edited[el.id];
    setSelected(el.id);
    setRedescribeError(null);
    setJustSaved(false);
    setEditName(local?.name ?? el.name);
    setEditCategory(local?.category ?? el.category);
    setEditDescription(redescribed[el.id] ?? local?.description ?? el.description ?? "");
  }

  /**
   * What this element's description reads as RIGHT NOW, folding in the same
   * two optimistic overlays selectElement seeds the panel from — a redescribe
   * that just landed, or an edit that just saved — so the grid's "not
   * described yet" state and the detail panel's empty-state agree with each
   * other, and both clear the instant either action succeeds without waiting
   * on `elements` to be refetched from the server.
   */
  function currentDescription(el: ElementTag): string | null {
    return redescribed[el.id] ?? edited[el.id]?.description ?? el.description;
  }

  /**
   * Saves a card's edits.
   *
   * The rename is the part with teeth: updateElement follows it into every
   * prompt this user has already written, because tag substitution is by name
   * and a prompt left saying @new1 would render without the reference and
   * without complaining. Nothing here needs to know that — it is noted so the
   * next person to "simplify" this into a plain UPDATE knows what they would
   * be dropping.
   */
  async function saveEdit(elementId: string): Promise<void> {
    if (savingEdit) return;
    const attemptKey = editKeyFor(elementId, editName, editCategory, editDescription);
    setSavingEdit(true);
    setRedescribeError(null);
    try {
      const formData = new FormData();
      addProjectId(formData);
      formData.set("elementId", elementId);
      formData.set("name", editName.replace(/^@+/, ""));
      formData.set("category", editCategory);
      formData.set("description", editDescription);
      const result = await updateElement(formData);
      if (result?.error) {
        setRedescribeError(result.error);
        // Refused, not failed-in-transit: asking again with the same values
        // gets the same answer. Only a change to the fields can help.
        setRefusedKey(attemptKey);
        return;
      }
      setRefusedKey(null);
      setJustSaved(true);
      setEdited((old) => ({
        ...old,
        [elementId]: {
          name: editName.replace(/^@+/, "").trim(),
          category: editCategory,
          description: editDescription.trim() || null,
        },
      }));
    } catch (err) {
      setRedescribeError(err instanceof Error ? err.message : "Could not save that reference.");
      // A thrown save gets the same treatment as a refused one. It may well be
      // transient, but retrying it every 500ms unattended is not how to find
      // out — and an operator who changes anything gets a fresh attempt.
      setRefusedKey(attemptKey);
    } finally {
      setSavingEdit(false);
    }
  }

  /**
   * Removes a saved reference.
   *
   * Optimistic in one direction only: the card disappears from this grid on
   * success, because the server action revalidates the page but the dialog
   * the operator is standing in does not re-render from that. On failure the
   * card stays and the message says why.
   */
  async function removeElement(elementId: string): Promise<void> {
    if (deleting) return;
    setDeleting(elementId);
    setRedescribeError(null);
    try {
      const formData = new FormData();
      addProjectId(formData);
      formData.set("elementId", elementId);
      const result = await deleteElement(formData);
      if (result?.error) {
        setRedescribeError(result.error);
        return;
      }
      setDeleted((old) => [...old, elementId]);
      setConfirmDelete(null);
    } catch (err) {
      setRedescribeError(err instanceof Error ? err.message : "Could not remove that reference.");
    } finally {
      setDeleting(null);
    }
  }

  /**
   * Saves the whole batch, one registerElement call per file, in order.
   *
   * SEQUENTIAL, NOT PARALLEL. Each picture costs a Claude describe, and
   * registerElement derives its own default name from a count of what already
   * exists — five at once would race for the same newN. Order also survives:
   * the operator sees them appear in the order they dropped them.
   *
   * EVERY FILE IS ATTEMPTED — this does NOT stop at the first failure, despite
   * what an earlier version of this comment said. A single 20 MB picture in
   * the middle of five used to leave the last two unattempted and the
   * operator with no idea which; now every file gets its own verdict and only
   * the failures stay behind with a Retry (see the fileErrors state above).
   *
   * RUNS TO COMPLETION EVEN IF THE DIALOG CLOSES MID-BATCH. Nothing here is
   * tied to this component staying mounted — the file's own header explains
   * why that is the deliberate trade rather than a bug being reintroduced —
   * so isSavingRef holds resetUploadState off for exactly as long as this
   * loop is still writing to pendingFiles/pendingPreviewUrls/fileErrors, and
   * the batch outcome goes out as reportUploadOutcome's toast, which is the
   * one channel that reaches the operator whether or not anything is
   * mounted to receive it.
   *
   * The form's own FormData is ignored: it carries whichever file the hidden
   * input happens to hold, which is not the batch. One is built per file here.
   */
  async function saveElement(): ReturnType<typeof registerElement> {
    // Read before the awaits: state is cleared on the success path below, and
    // the attach needs the same File the first call sent.
    const files = pendingFiles;
    // THE FIRST PICTURE, NOT THE FIRST FILE.
    //
    // Whatever this picks is attached to the clip below as its conditioning
    // frame, and only a picture can be one. Reading files[0] was right while
    // the dialog took pictures alone; once it took MP3s and then MP4s, an
    // operator whose batch led with a voice or a video had that file attached
    // as the frame, and generateClip refused the render it had just been asked
    // for:
    //
    //   video/mp4 is not a JPG, PNG or WebP.
    //
    // Observed in production 2026-09-10, on a video that had already uploaded,
    // described and saved perfectly — the refusal was the attach, not the file.
    // The audio path had the identical hole and nobody had hit it, because a
    // voice is normally uploaded next to a picture rather than alone.
    //
    // Nothing is lost by skipping them: every file in this batch is saved to
    // the library either way, and a voice or a video reaches the render by
    // @name, which is how both are meant to be used.
    const attachIndex = files.findIndex(
      (f) =>
        ACCEPTED_IMAGE_TYPES.split(",").includes(f.type) ||
        (allowVideoPrimary && !imagesOnly && !elementsOnly && isAcceptedReferenceVideo(f)),
    );
    const file = attachIndex === -1 ? null : (files[attachIndex] ?? null);
    const previewUrl = attachIndex === -1 ? null : (pendingPreviewUrls[attachIndex] ?? null);
    if (files.length === 0) return undefined;
    const estimate = files.reduce((total, item) => total + uploadDescribeEstimateUsd(item), 0);
    if (
      !window.confirm(
        `Upload and describe ${files.length} reference${files.length === 1 ? "" : "s"}? Estimated description cost: $${estimate.toFixed(4)}. Voice and video retries may cost more.`,
      )
    ) return undefined;

    isSavingRef.current = true;
    setUploadProgress({ done: 0, total: files.length });
    setFileErrors({});
    setSavedCount(0);

    try {
      const errors: Record<number, string> = {};
      let attachedVideoDurationS: number | null | undefined;
      for (const [i, f] of files.entries()) {
        const fd = new FormData();
        addProjectId(fd);
        fd.set("image", f);
        const name = (uploadNames.get(f) ?? "").trim();
        const nameError = await checkElementUploadName(name);
        if (nameError) {
          errors[i] = nameError;
          setUploadProgress({ done: i + 1, total: files.length });
          continue;
        }
        fd.set("name", name);
        const measuredVideoDurationS = await attachVideoDuration(fd, f);
        if (i === attachIndex) attachedVideoDurationS = measuredVideoDurationS;
        await stageFiles(fd);
        const one = await registerElement(fd);
        if (one && "error" in one && one.error) errors[i] = one.error;
        // Same "not toast.error" reasoning as retryOne above: the file this
        // notice is about already landed in the library, so it counts toward
        // `saved` below and does not go in `errors` — a describe failure is
        // never a reason to keep it in the retry queue.
        else if (one && "notice" in one && one.notice) toast(one.notice, { duration: 8000 });
        setUploadProgress({ done: i + 1, total: files.length });
      }

      // Cleared here, not only in the `finally` below: everything from this
      // point on (reportUploadOutcome, resetUploadState's tail call included)
      // runs synchronously in the same call stack as the loop that just
      // finished, so there is no race left to guard against. Clearing it
      // only in `finally` would still be technically correct timing-wise,
      // but would leave resetUploadState's own guard reading true for the
      // "nothing to attach" branch below, which calls resetUploadState
      // directly — and that call must actually run, not no-op against a
      // race that is already over.
      isSavingRef.current = false;
      setUploadProgress(null);

      reportUploadOutcome(
        files.map((f) => f.name),
        errors,
      );

      const failedAt = Object.keys(errors).map(Number);
      const saved = files.length - failedAt.length;
      setSavedCount(saved);

      // ONLY THE FAILURES STAY. The ones that landed are in the library and
      // leaving their rows here would invite a second upload of the same file;
      // the ones that did not are kept with their reason, so Retry is one press
      // and not a re-drag.
      if (failedAt.length > 0) {
        const keep = new Set(failedAt);
        setPendingFiles(files.filter((_, i) => keep.has(i)));
        setPendingPreviewUrls((old) => {
          for (const [i, u] of old.entries()) if (!keep.has(i)) URL.revokeObjectURL(u);
          return old.filter((_, i) => keep.has(i));
        });
        // Re-keyed to the new positions, or the messages would point at rows
        // that have moved.
        setFileErrors(Object.fromEntries(failedAt.map((old, next) => [next, errors[old]!])));
        if (fileRef.current) fileRef.current.value = "";
        return undefined;
      }

      const result: Awaited<ReturnType<typeof registerElement>> = undefined;

      // Attached as an UPLOAD, not as an element, even though a row now exists.
      // registerElement returns an ActionResult and no id, and it does not need
      // to: the parent uploads the File itself at generateClip time, which is
      // exactly what the old "Use this image for this clip" produced. The saved
      // row is for the NEXT prompt, reachable by @name.
      if (file && previewUrl) {
        // ONLY THE FIRST IS ATTACHED to this clip; the rest are library-only.
        // A clip has one primary reference, and the others are reachable by
        // @name in the prompt from here on.
        onPick({
          kind: "upload",
          file,
          name: file.name,
          previewUrl,
          ...(isAcceptedReferenceVideo(file) ? { durationS: attachedVideoDurationS ?? null } : {}),
        });
        // Deliberately NOT resetUploadState() for the FIRST url: it has just
        // become the parent's `current.previewUrl` and is still painting the
        // trigger's thumbnail. Revoking it blanks that thumbnail the instant
        // the dialog closes — a broken image with no error, after a save that
        // worked. Every OTHER url in the batch has no such holder and is
        // revoked here rather than leaked.
        setPendingFiles([]);
        setPendingPreviewUrls((old) => {
          // Every url EXCEPT the one just handed to the parent. That used to
          // be index 0 by assumption; it is now whichever one was attached,
          // and -1 (nothing attachable in the batch) means every url here is
          // ours to revoke.
          for (const [i, u] of old.entries()) if (i !== attachIndex) URL.revokeObjectURL(u);
          return [];
        });
        if (fileRef.current) fileRef.current.value = "";
        // THE DIALOG STAYS OPEN. It used to close on save, which was right when
        // an upload was one file and the save WAS the pick. A batch is a
        // different act: the operator is filling a library, and closing the
        // moment the last one lands takes them away from the tab they were
        // working in, with no chance to see the five rows they just uploaded
        // land or to add another five. The Elements tab is one click away and
        // the close button is where it always was.
        return result;
      }

      resetUploadState();
      return result;
    } finally {
      setUploadProgress(null);
      isSavingRef.current = false;
    }
  }

  /**
   * restrictToImages actually filters the GRID, not just the filter pills
   * above it. Before elementsOnly existed, imagesOnly on its own narrowed
   * which PILLS this dialog showed (all/image, never all/image/audio/video)
   * but left the "all" pill itself showing every kind — an audio or video
   * element saved elsewhere in the library was still visible and pickable
   * under All, on a dialog whose own doc comment says "pictures only". A
   * Kling frame slot cannot carry that gap forward: audio and video must
   * not be pickable there at all, under any filter, which is what actually
   * exercises this line for the first time.
   */
  const visibleElements = elements.filter(
    (el) =>
      !deleted.includes(el.id) &&
      (!restrictToImages || IMAGE_ASSET_KINDS.has(el.assetKind)) &&
      // KLING-ONLY: kie's Kling 3.0 rejects webp at submit ("Only jpeg/jpg/
      // png image formats are supported", prod scene d532c7a0's webp end
      // frame) while Seedance renders webp fine — so ONLY elementsOnly
      // (Kling's frame slots) hides a non-png/jpg picture here, and only
      // when imageExt is actually known; absent stays pickable, the same
      // "unknown is not unsafe, the server still refuses it for real" rule
      // ugc-column.tsx's own Kling frame check follows.
      (!elementsOnly ||
        el.imageExt === undefined ||
        KLING_FRAME_EXTS.has(el.imageExt.toLowerCase())),
  );

  // THE FILTER IS COMPUTED BEFORE THE SELECTION BECAUSE THE SELECTION READS IT,
  // and getting that order wrong cost a real reference in production on
  // 2026-09-04.
  //
  // The grid renders this filtered list; the panel used to resolve `selected`
  // against the UNFILTERED one. So switching the filter left the panel showing
  // an element that was no longer in the grid — press Voice, see one voice
  // tile, and edit the character you had selected a moment earlier. The
  // operator renamed what was plainly in front of them and a picture they
  // could not see took the name.
  //
  // Resolving against the filtered list makes that state unreachable: an
  // element the grid is not showing cannot be the one the panel is editing.
  /**
   * THE FILTER READS THE ASSET, NOT THE LABEL.
   *
   * These two filters exist to answer one question — is this a picture or a
   * voice — and `assetKind` answers it from the file itself, while `category`
   * is a label that has meant different things at different times. Filtering
   * on the label left every row saved before 0081 reachable only under All:
   * a picture filed as "character" is still a picture, and an operator
   * looking for it under Image was told there was nothing there.
   *
   * It also closes the window around the migration. 0081 renames voice to
   * audio, but any clip uploaded between the migration running and this code
   * deploying is written by the old path as 'voice' — and would sit outside
   * the Audio filter forever, on a label nobody would think to look for.
   */
  const filteredElements =
    categoryFilter === "all"
      ? visibleElements
      : visibleElements.filter((el) => matchesFilter(el.assetKind, categoryFilter));

  const selectedRaw = filteredElements.find((el) => el.id === selected) ?? null;
  /**
   * The selected element as the panel should show it: the saved row, with any
   * edit already made in this dialog laid over it. Null when nothing is
   * selected, or when what WAS selected has just been removed.
   */
  const selectedElement: ElementTag | null =
    selectedRaw === null
      ? null
      : {
          ...selectedRaw,
          name: edited[selectedRaw.id]?.name ?? selectedRaw.name,
          category: edited[selectedRaw.id]?.category ?? selectedRaw.category,
          description:
            redescribed[selectedRaw.id] ??
            edited[selectedRaw.id]?.description ??
            selectedRaw.description,
        };
  /** Whether the panel holds anything not yet written down. */
  const detailIsDirty =
    selectedElement !== null &&
    (editName.replace(/^@+/, "") !== selectedElement.name ||
      editCategory !== selectedElement.category ||
      editDescription !== (selectedElement.description ?? ""));

  /**
   * Autosave, 500ms after the last keystroke.
   *
   * WHY A NAME IS CHECKED BEFORE ANY OF THIS RUNS. Every save that changes the
   * tag also rewrites that tag inside every prompt this user has already
   * written (updateElement). Typing "lena" over "new3" pauses at "l", "le",
   * "len" if the operator is slow, and each pause is a real rename with a real
   * rewrite behind it. The chain lands correctly — each save renames from
   * whatever the last one wrote — but a half-typed name can collide with an
   * element that already exists, and the operator would see a failure for a
   * word they never meant to save. So a name that is empty, or not the shape a
   * prompt can reference, simply does not autosave: the fields sit as
   * "Unsaved" until they are.
   *
   * Description and category have no such hazard and save freely.
   */
  const elementId = selectedElement?.id ?? null;
  const currentKey =
    elementId === null ? null : editKeyFor(elementId, editName, editCategory, editDescription);
  /**
   * The name as the database stores it: whatever was typed, with a leading
   * '@' taken off.
   *
   * THE FIELD INVITES THE '@' AND THEN THE SAVE REFUSED IT. Every place this
   * name is shown wears one — the grid says "@new1", the label says Tag, the
   * hint says "rewrites @new1 in prompts" — so typing "@lena2" is the obvious
   * thing to do, and it was, in production, within an hour of shipping. The
   * name pattern has no '@' in it, so the autosave guard below simply held
   * everything back and the panel sat at "Unsaved" with nothing to explain it.
   * Silence for a keystroke the UI asked for.
   */
  const typedName = editName.replace(/^@+/, "");
  const nameIsSavable = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(typedName);
  useEffect(() => {
    if (elementId === null || !detailIsDirty || savingEdit || !nameIsSavable) return;
    // The one thing standing between a refused save and an infinite retry.
    if (currentKey !== null && currentKey === refusedKey) return;
    // A RENAME WAITS LONGER THAN AN EDIT, because it is not the same act.
    //
    // Changing the description writes one row. Changing the NAME rewrites that
    // tag inside every prompt this operator has ever written, so the
    // half-typed states on the way to "lena" — "l", "le", "len" — are each a
    // real rename of every prompt, and each is followed by another. The guard
    // above only rejects shapes a prompt cannot reference; "l" and "le" are
    // perfectly valid shapes, so they saved.
    //
    // 1000ms is past the pause inside a word and short of feeling stuck, and
    // it is not the whole answer: the field also flushes on blur, which is
    // what keeps the wait from being felt. Click away or press Tab and it
    // saves at once.
    const delay = typedName === selectedElement?.name ? 500 : 1000;
    const timer = setTimeout(() => void saveEdit(elementId), delay);
    return () => clearTimeout(timer);
    // saveEdit is stable enough for this: it closes over the edit fields,
    // which are exactly what re-runs this effect when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    elementId,
    detailIsDirty,
    savingEdit,
    nameIsSavable,
    currentKey,
    refusedKey,
    editName,
    editCategory,
    editDescription,
  ]);

  return (
    // NO CARD OF ITS OWN. This renders as a CELL of the settings row above the
    // Generate button, so the border, background and padding belong to that
    // row and not to this.
    //
    // It has shed a container twice now. It began as a 100px dashed box with
    // three emoji floating in the middle, directly above the prompt — the
    // least-used control on the screen holding the most presence. Laid
    // sideways it cost a third of that. Folded into the settings row it costs
    // none: those four values were already a row, and "which picture" belongs
    // beside "which model, how long, what shape" rather than in a panel of
    // its own with a band of empty page around it.
    //
    // The thumbnail survives every move. A picked reference shows as a small
    // image beside its name at all times, which is what makes "is the right
    // frame attached?" answerable at a glance rather than by opening
    // something.
    <div className="flex min-w-0 items-center">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            resetUploadState();
            setMulti([]);
          }
        }}
      >
        {/* THE ICON IS INSIDE THE TRIGGER NOW, and that is the actual fix.
            It used to be a bordered circle sitting OUTSIDE the button, in a
            flex row beside it — so the largest, most obviously pressable
            thing in the control did nothing when pressed, and the only live
            target was the word next to it. That is the same failure this
            product has been finding all day: something looks like it works
            and does not answer.

            The circle is gone with it. A 28px ring around a 14px glyph was
            weight this control has not earned — it opens a dialog, and the
            row it sits in now says what it is.

            One button, so the whole thing is the target and the whole thing
            gets the hover and focus ring. */}
        {/* OMITTED FOR THE BOX'S INSTANCE (hideTrigger). Its own "Add" tile
            is the trigger there — see hideTrigger's own comment on why a
            second visible "Upload" button would be a second thing on screen
            claiming to be the one way in, and why `open`/`onOpenChange`
            above are what lets this Dialog open with no trigger of its own. */}
        {hideTrigger ? null : (
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              // h-9 and rounded-lg to match the pills it now sits in a row with:
              // this control is one of five, and the odd height was most of what
              // made the old row look assembled rather than designed.
              //
              // The same press the other two live controls have. `motion-safe:`
              // on the transform only — a scale is what prefers-reduced-motion
              // exists to suppress; a border changing colour is not motion.
              className="h-9 gap-1.5 rounded-lg motion-safe:transition-transform motion-safe:active:scale-[0.98]"
            >
              {current ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={current.previewUrl}
                  alt=""
                  className="size-4 rounded-sm border object-cover"
                />
              ) : (
                // ONE ICON, because one kind of file is accepted. There were
                // three — image, film, music — beside the words "Image, Video or
                // Audio", and an InfoHint under them saying "Image only today".
                // The hint was removed on request; the promise it was there to
                // walk back cannot stay without it, so the promise goes instead.
                //
                // Not a permanent statement about the vendor: kie's schema for
                // seedance-2-5 does carry reference_audio_urls. It is a statement
                // about this picker, which uploads images and nothing else.
                <ImagePlusIcon aria-hidden="true" className="size-4" />
              )}
              {/* One word, both states. "Add references" / "Change reference"
                  described attaching a conditioning frame, which is not what this
                  control is for any more — a reference reaches a clip by being
                  typed as @name in the prompt. What is left here is putting
                  pictures INTO the library, which is upload. */}
              {onUseElement ? "References" : "Upload"}
            </Button>
          </DialogTrigger>
        )}

        {/* Wider than the usual dialog: the Elements tab is a grid
              beside a detail panel now, and at sm:max-w-lg the panel was
              a column of squeezed inputs. */}
        {/* 700px, not 3xl (768px). Narrow enough that an upload row is not
              mostly empty space with an X marooned at the far right, wide
              enough for the Elements tab, which is a thumbnail grid beside a
              detail panel and is the tab that ever needed the room. */}
        {/* A FIXED 600px, not a box that sizes to its contents. This
              dialog's height was whatever was in it: short with an empty
              dropzone, tall with five rows, taller again on the Elements tab
              — so every drop, every removal and every tab press moved the
              Upload button out from under the cursor. A panel an operator
              runs a batch through has to hold still.

              grid-rows so the header keeps its natural height and the tabs
              take the rest; minmax(0,1fr) rather than 1fr because a grid row
              defaults to min-content and would otherwise refuse to shrink
              below the list inside it, which is what makes an inner
              overflow-y-auto do nothing. */}
        <DialogContent className="grid-rows-[auto_minmax(0,1fr)] sm:h-[600px] sm:max-w-[700px]">
          <DialogHeader>
            <DialogTitle>Pick a reference</DialogTitle>
            <DialogDescription>
              {/* elementsOnly (Kling's frame slots) never uploads anything —
                  the description says so instead of the Upload copy every
                  other caller gets, which would promise a tab this render
                  never mounts. */}
              {elementsOnly
                ? "Pick a picture you have already saved."
                : `Upload up to ${MAX_UPLOAD_BATCH} ${
                    imagesOnly ? "pictures" : "pictures, voice clips, or videos"
                  }, or reuse ones you have already saved.`}
            </DialogDescription>
          </DialogHeader>

          {/* CONTROLLED, so the success line's "Open Elements" can move
                it. Uncontrolled, that button had nothing to act on. */}
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-col">
            {/* NO TABS AT ALL IN elementsOnly — there is exactly one tab to
                choose between the other one, which is the same "one thing,
                unmistakably a button" reasoning hideTrigger's own callers
                already follow. Radix's Tabs still needs a `value` to route
                TabsContent by; `tab` stays "elements" for the whole time
                this mode is active (forced above), so omitting the list
                changes nothing about which content renders. */}
            {elementsOnly ? null : (
              <TabsList>
                <TabsTrigger value="uploads">Uploads</TabsTrigger>
                <TabsTrigger value="elements">
                  Elements{elements.length > 0 ? ` (${elements.length})` : ""}
                </TabsTrigger>
              </TabsList>
            )}

            {/* OMITTED ENTIRELY IN elementsOnly, not merely unreachable —
                the hidden file input inside it still has a `name="image"`
                that would otherwise sit in the DOM claiming a role this
                mode never offers. */}
            {elementsOnly ? null : (
              <TabsContent value="uploads" className="flex min-h-0 flex-1 flex-col">
                <ActionForm
                  action={saveElement}
                  fallbackErrorMessage="Could not save that reference."
                  className="flex min-h-0 flex-1 flex-col gap-3"
                >
                  <PendingFieldset className="flex min-h-0 flex-1 flex-col gap-3">
                    {/* THE BUTTON IS OUTSIDE THIS. Scrolling the whole tab
                        put Upload at the bottom of the scroll, so a full
                        batch of five — the case the batch exists for — hid
                        the control that sends it, which is the same
                        disappearing button the fixed height was set to stop.
                        The list scrolls; the button stays where it was. */}
                    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                      {projectId ? (
                        <input type="hidden" name="projectId" value={projectId} />
                      ) : null}
                      <input
                        ref={fileRef}
                        type="file"
                        name="image"
                        multiple
                        accept={imagesOnly ? ACCEPTED_IMAGE_TYPES : ACCEPTED_REFERENCE_TYPES}
                        onChange={handleFileChange}
                        className="sr-only"
                      />

                      {/* A DROP TARGET, not a button beside a thumbnail.
                        The old row asked for a click and never mentioned that
                        dragging worked, because it didn't. The whole area is
                        the control now — clicking anywhere in it opens the
                        browse dialog, and a real <button> is what carries that
                        so the keyboard reaches it for free. type="button" is
                        not optional: this sits inside the save form. */}
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        onDragOver={(e) => {
                          // Both handlers must preventDefault or the browser
                          // navigates to the dropped file instead.
                          e.preventDefault();
                          if (!saving()) setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={handleDrop}
                        aria-label={
                          pendingFiles.length > 0
                            ? `${pendingFiles.length} chosen. Drop more here, or click to browse.`
                            : imagesOnly
                              ? "Drop pictures here, or click to browse"
                              : "Drop pictures, voice clips, or videos here, or click to browse"
                        }
                        className={cn(
                          // IT SHRINKS ONCE IT HAS DONE ITS JOB. Empty, this is
                          // the only thing to do here and it should look like
                          // it. With files chosen it is a secondary action —
                          // "add another" — and holding half the dialog for a
                          // glyph pushes the actual content, the list, out of
                          // sight.
                          "flex w-full items-center justify-center rounded-lg border-2 border-dashed text-center transition-colors",
                          // EMPTY, IT TAKES THE WHOLE PANEL and stacks. The
                          // rules moved INSIDE it — they were three lines
                          // underneath, which is where a caption gets read once
                          // and then skipped, and which left a stripe of dead
                          // white between the box and the Upload button. A drop
                          // target that fills the space is also a bigger drop
                          // target.
                          //
                          // With files chosen it collapses to one row: it is a
                          // secondary action then ("add another"), and holding
                          // half the dialog for a glyph pushes the list — the
                          // actual content — out of sight.
                          pendingFiles.length > 0
                            ? "flex-row gap-3 px-4 py-2.5"
                            : "min-h-0 flex-1 flex-col gap-2 px-6 py-6",
                          // THE BORDER IS THE FOCUS RING. An outline was still
                          // a second line: offset-2 drew it clear of the box,
                          // offset-0 drew it flush against the dashed one, and
                          // both read as two borders because a solid outline
                          // and a dashed border are visibly different lines
                          // whatever the gap between them.
                          //
                          // This matters more here than on an ordinary button:
                          // returning from the OS file dialog leaves this
                          // focus-visible, so the state is on screen after
                          // every single upload, not only for keyboard users.
                          // Lighting the border the way a drag does is one
                          // line, and the same one the control already has.
                          "focus-visible:border-primary focus-visible:bg-primary/5 focus-visible:outline-none",
                          // The PendingFieldset around this sets .disabled while
                          // the save runs. Without these the box still looked
                          // and behaved like a live target: hover lit it up, the
                          // cursor stayed a pointer, and a drop had to be
                          // refused in JS rather than never arriving.
                          "disabled:pointer-events-none disabled:opacity-60",
                          dragging
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-foreground/30 hover:bg-muted/40",
                        )}
                      >
                        {/* THE BOX KEEPS ITS GLYPH whatever is chosen. It used
                          to become the preview of the one selected file, which
                          cannot hold five — and turning the drop target into a
                          gallery would also stop it looking like a drop
                          target, which is the one thing it must go on saying.
                          The chosen files are a list beneath it. */}
                        <span
                          className={cn(
                            "relative grid place-items-center",
                            pendingFiles.length > 0 ? "size-6" : "size-14",
                          )}
                          aria-hidden="true"
                        >
                          <FileIcon
                            className={cn(
                              pendingFiles.length > 0
                                ? "size-5 text-muted-foreground/50"
                                : // TINTED, not grey. Empty, this glyph IS the
                                  // control — the one thing in the panel to
                                  // act on — and a muted outline reads as
                                  // decoration next to a filled Upload button.
                                  "size-12 fill-primary/15 text-primary/60",
                            )}
                            strokeWidth={1.25}
                          />
                          {pendingFiles.length === 0 ? (
                            <span className="absolute bottom-0.5 right-1 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
                              <UploadIcon className="size-3.5" strokeWidth={2.5} />
                            </span>
                          ) : null}
                        </span>
                        {/* BOTH STATES SAY SOMETHING. The empty box carried its
                          sentence only in the aria-label, so a sighted
                          operator got a glyph and had to infer that it takes a
                          drop as well as a click. The count in the other state
                          is what tells them how much room is left before the
                          cap refuses the next one. */}
                        {pendingFiles.length > 0 ? (
                          <span className="text-sm text-muted-foreground">
                            Add more — {pendingFiles.length} of {MAX_UPLOAD_BATCH}
                          </span>
                        ) : (
                          <>
                            <span className="text-sm">
                              {/* The clickable half is coloured and the dragging
                                half is not, because only one of them is a
                                thing to press. A whole sentence in the accent
                                colour says the sentence is a link. */}
                              <span className="font-medium text-primary">Click to upload</span>
                              <span className="text-muted-foreground"> or drag and drop</span>
                            </span>
                            {/* THE RULES, INSIDE THE BOX. They were three lines
                              below it, which is a caption — read once, then
                              skipped, and gone from the eye by the time a file
                              is picked. Here they sit in the target itself, at
                              the moment of choosing.

                              Both kinds, both ceilings: 10 MB for a picture
                              against kie's 15 MB for a clip, and one shared
                              "Maximum size" would have to be wrong about one
                              of them. */}
                            <span className="text-xs leading-relaxed text-muted-foreground">
                              {/* THE SAME STRING THE TOASTS CARRY. This was a
                                second, hand-written copy of the same rules,
                                and it had already drifted: "10 MB" here
                                against "10.0MB" in a refusal, which reads as
                                two different numbers to anyone comparing them
                                — which is exactly what an operator does after
                                being refused. */}
                              {referenceRules(imagesOnly)}
                              <br />
                              The first is used for this clip; the rest are saved for later.
                            </span>
                          </>
                        )}
                      </button>

                      {/* THE BATCH. One row per chosen file, in the order they
                        were dropped, each removable on its own — a wrong file
                        in a batch of five should cost one click, not a
                        re-drag of the other four.

                        A voice or a video gets a glyph rather than an <img>:
                        an object URL for an MP3 or an MP4 in an image
                        element is the browser's broken-image icon, which
                        reads as "your upload failed" at the moment nothing
                        has failed. */}
                      {pendingFiles.length > 0 ? (
                        // min-w-0 on the list AND the row: a flex item's default
                        // min-width is `auto`, meaning its content, so a long
                        // filename widens the row rather than being clipped —
                        // `truncate` on the span cannot win against an ancestor
                        // that refuses to shrink.
                        <ul className="flex w-full min-w-0 flex-col gap-1">
                          {pendingFiles.map((f, i) => (
                            <li
                              key={`${f.name}-${f.size}-${i}`}
                              className={cn(
                                // SIZED SO THAT FIVE FIT. The thumbnail is the
                                // part of this row that is actually read —
                                // near-identical filenames are told apart by
                                // their pictures — but a full batch is five
                                // rows, and at size-12 in a py-2.5 row the
                                // fifth one fell below the fold of a 600px
                                // dialog. A picture nobody scrolls to is worth
                                // less than a smaller one they can see.
                                "flex min-w-0 flex-wrap items-center gap-3 rounded-md border px-3 py-1.5",
                                fileErrors[i] !== undefined &&
                                  "border-destructive/50 bg-destructive/5",
                              )}
                            >
                              {isAcceptedReferenceAudio(f) ? (
                                <span
                                  className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted/50"
                                  aria-hidden="true"
                                >
                                  <MusicIcon className="size-5 text-muted-foreground" />
                                </span>
                              ) : isAcceptedReferenceVideo(f) ? (
                                <span
                                  className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted/50"
                                  aria-hidden="true"
                                >
                                  <VideoIcon className="size-5 text-muted-foreground" />
                                </span>
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={pendingPreviewUrls[i]}
                                  alt=""
                                  className="size-10 shrink-0 rounded-md border object-cover"
                                />
                              )}
                              {/* A FIXED 300px, not flex-1. The filename is for
                                recognising a file you just chose, not reading;
                                a fixed width keeps every row the same shape
                                whatever was dropped, and the full name is on
                                the title for the one time it is needed. */}
                              <div className="w-[300px] shrink-0 space-y-1">
                                <span className="block truncate text-sm" title={f.name}>
                                  {f.name}
                                </span>
                                <ElementTagNameField
                                  label={`Tag name for ${f.name}`}
                                  value={uploadNames.get(f) ?? ""}
                                  disabled={uploadProgress !== null}
                                  onChange={(value) =>
                                    setUploadNames((old) => new Map(old).set(f, value))
                                  }
                                />
                              </div>
                              {/* PER FILE, because the batch is sequential and
                                each row's state is a fact: everything before
                                the cursor is saved, the one at it is in
                                flight, everything after is waiting.

                                The in-flight bar is INDETERMINATE on purpose.
                                A percentage inside one file would be invented
                                — the server gives no progress for a single
                                registerElement, and a bar that fills on a
                                timer is a lie that looks like information.
                                What IS known is which file, and that is
                                what this shows. */}
                              <span className="min-w-0 flex-1">
                                {uploadProgress !== null ? (
                                  <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
                                    {i < uploadProgress.done ? (
                                      <span className="block h-full w-full rounded-full bg-green-500" />
                                    ) : i === uploadProgress.done ? (
                                      <span className="block h-full w-1/3 animate-pulse rounded-full bg-green-500" />
                                    ) : null}
                                  </span>
                                ) : null}
                              </span>
                              {fileErrors[i] !== undefined ? (
                                <button
                                  type="button"
                                  onClick={() => void retryOne(i)}
                                  disabled={uploadProgress !== null}
                                  className="shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                                >
                                  Retry
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => removePending(i)}
                                aria-label={`Remove ${f.name}`}
                                className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-destructive hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                              >
                                <XIcon className="size-3.5" aria-hidden="true" />
                              </button>
                              {fileErrors[i] !== undefined ? (
                                // The whole reason, on its own line. Truncating
                                // it into the row would hide the half that says
                                // what to do — "that image is 12.4 MB" is only
                                // useful if the limit comes with it.
                                <p className="w-full text-[11px] leading-snug text-destructive">
                                  {fileErrors[i]}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {/* WHAT NOW. A save that only says "done" leaves the
                        operator in a dialog with nothing to press, and the
                        answer to "what next" is not obvious: these are saved
                        under generated names, and the way to use one is to
                        type its @tag into the prompt. So the line says where
                        they went and offers the one click that gets there. */}
                      {savedCount > 0 && pendingFiles.length === 0 ? (
                        <div className="flex items-center justify-between gap-3 rounded-md border border-green-600/30 bg-green-500/10 px-3 py-2">
                          <p className="text-sm">
                            {savedCount === 1
                              ? "1 reference saved"
                              : `${savedCount} references saved`}
                            <span className="text-muted-foreground">
                              {" "}
                              — name them, then use @tags in the prompt.
                            </span>
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setSavedCount(0);
                              setTab("elements");
                            }}
                            className="shrink-0 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            Open Elements
                          </button>
                        </div>
                      ) : null}
                    </div>

                    {/* A PROGRESS BAR REPLACES THE BUTTON while the batch
                        runs, rather than a spinner sitting on it.
                        `uploadProgress` counts real completed files, so this
                        is measured rather than animated — and with a Claude
                        describe per picture, five files is long enough that
                        "it is working" is not enough to say. */}
                    {uploadProgress !== null ? (
                      // The rows carry the bars; this says how far through the
                      // batch it is, which is the one number that IS known.
                      <p
                        className="py-2 text-center text-sm font-medium tabular-nums"
                        role="status"
                      >
                        Uploading {Math.min(uploadProgress.done + 1, uploadProgress.total)} of{" "}
                        {uploadProgress.total} —{" "}
                        {Math.round((uploadProgress.done / uploadProgress.total) * 100)}%
                      </p>
                    ) : (
                      <SubmitButton
                        pendingLabel="Uploading"
                        disabled={pendingFiles.length === 0}
                        className="w-full"
                      >
                        {/* The whole tab is one field and one button now. The
                          name, the category and the description used to be
                          asked for here and are filled in by registerElement
                          instead — a name of newN, "character", and a
                          description Claude writes from the picture. All three
                          are corrected on the Elements tab, where the operator
                          can see what they are correcting; asking for them up
                          front asked for a name before there was anything to
                          name it after. */}
                        {pendingFiles.length > 1 ? `Upload ${pendingFiles.length}` : "Upload"}
                      </SubmitButton>
                    )}
                  </PendingFieldset>
                </ActionForm>
              </TabsContent>
            )}

            {/* MASTER AND DETAIL, because a thumbnail is not enough to
                  decide by and clicking one used to close the whole dialog.
                  The grid picks WHICH element is being looked at; everything
                  that can be read or changed about it lives in the panel
                  beside it, and attaching it to the clip is now a deliberate
                  button rather than the side effect of a glance. */}
            <TabsContent value="elements" className="flex min-h-0 flex-1 flex-col gap-3">
              {elements.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {/* elementsOnly has no Uploads tab to point at — see the
                      DialogDescription above for the matching adjustment. */}
                  {elementsOnly
                    ? "No saved references yet."
                    : "No saved references yet — upload one on the Uploads tab."}
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1">
                    {/* Character and Voice only. Product and Location were
                          offered as filters and as choices for two months and
                          never meant anything: nothing in the prompt
                          substitution, the reference payload or the render
                          branches on category — it is a label and a filter.
                          Two labels nobody used were two more things to read
                          on a row that is scanned, not studied.

                          EXISTING ROWS KEEP THEIR VALUE. elements.category
                          still CHECKs all four (0065/0073), so a reference
                          saved as "product" is still there, still tagged, and
                          still sent; it simply lands under "All" now rather
                          than a filter of its own. Narrowing the CHECK would
                          have meant a migration to delete data nobody asked
                          to lose. */}
                    {/* ALL / IMAGE / AUDIO — the kind, which is the only
                          question these filters were ever used to answer.
                          They read Character and Voice until 0081; nothing in
                          the prompt, the payload or the render branched on
                          either, and Product and Location had already gone
                          for the same reason.

                          Rows saved before 0081 keep character, product or
                          location and appear under All only. Rewriting them
                          would be a guess — see the migration. */}
                    {/* No Audio tab when the caller takes pictures only —
                          a filter for a kind that cannot appear is a control
                          that always returns nothing. */}
                    {(restrictToImages
                      ? (["all", "image"] as const)
                      : (["all", "image", "audio", "video"] as const)
                    ).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCategoryFilter(c)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs capitalize",
                          categoryFilter === c
                            ? "border-foreground bg-foreground text-background"
                            : "text-muted-foreground hover:border-foreground/40",
                        )}
                      >
                        {c === "all" ? "All" : CATEGORY_LABEL[c]}
                      </button>
                    ))}
                  </div>

                  {multiOk && multi.length > 0 ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{multi.length} selected</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setMulti([])}>
                        Clear
                      </Button>
                      <Button type="button" size="sm" className="ml-auto" onClick={addMany}>
                        Use {multi.length}
                      </Button>
                    </div>
                  ) : null}

                  {redescribeError !== null ? (
                    <p className="text-[11px] leading-snug text-destructive">{redescribeError}</p>
                  ) : null}

                  {filteredElements.length === 0 ? (
                    <p className="p-6 text-center text-sm text-muted-foreground">
                      Nothing saved in this category yet.
                    </p>
                  ) : (
                    <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                      {/* Same height as the panel beside it, not 320px.
                            The old cap cut the third row through the middle
                            of a card, so the names under them were sliced in
                            half and read as a rendering bug. */}
                      <div
                        className="relative grid auto-rows-min grid-cols-2 gap-2 overflow-y-auto pr-1 select-none"
                        onPointerDown={boxDown}
                        onPointerMove={boxMove}
                        onPointerUp={boxUp}
                        onPointerCancel={boxUp}
                        onClickCapture={(e) => {
                          if (!justBoxed.current) return;
                          justBoxed.current = false;
                          e.stopPropagation();
                        }}
                      >
                        {box ? (
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute z-10 rounded-sm border border-primary bg-primary/10"
                            style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                          />
                        ) : null}
                        {filteredElements.map((el) => {
                          const local = edited[el.id];
                          const name = local?.name ?? el.name;
                          const picked = multi.includes(el.id);
                          const chosen = selected === el.id || picked;
                          // NO NEW COLUMN — this reads the absence of a
                          // description exactly the way an image element's
                          // always could, and is true of every kind. It
                          // reads as news specifically for audio and video
                          // (needsHandWrittenDescription) because nothing
                          // else on this card hints at it: the icon is the
                          // same regardless, where a picture at least shows
                          // the operator what was uploaded.
                          const undescribed =
                            needsHandWrittenDescription(el) && !currentDescription(el);
                          return (
                            <button
                              key={el.id}
                              type="button"
                              // SHOW, not Use. The click stopped attaching
                              // anything the moment the panel appeared, and
                              // a label that still promised otherwise would
                              // be the lie a screen reader hears.
                              // "no description" here, never the word
                              // "describe" itself — the detail panel's own
                              // button is named "Describe"/"Describe again",
                              // and a queryByRole("button", { name:
                              // /describe/i }) elsewhere would otherwise
                              // match this card too and turn a real ambiguity
                              // bug into an "it works" false positive.
                              aria-label={
                                undescribed ? `Show @${name} — no description` : `Show @${name}`
                              }
                              aria-pressed={chosen}
                              data-element-id={el.id}
                              onClick={(e) => {
                                if (multiOk && e.shiftKey) {
                                  toggleMulti(el.id);
                                  return;
                                }
                                setMulti([]);
                                setConfirmDelete(null);
                                selectElement(el);
                              }}
                              // Double-click is the shortcut for the panel's
                              // "Use element": add and close in one gesture.
                              // Only offered when this caller can consume tags.
                              onDoubleClick={onUseElement ? () => pickIntoBox(el) : undefined}
                              className={cn(
                                "flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                                picked && "ring-2 ring-primary",
                                chosen
                                  ? "border-foreground bg-muted/60"
                                  : undescribed
                                    ? "border-amber-500/50 hover:border-amber-500"
                                    : "hover:border-foreground/40",
                              )}
                            >
                              {el.assetKind === "audio" || el.assetKind === "video_ref" ? (
                                <span className="relative grid aspect-square w-full place-items-center rounded-sm border bg-muted/50">
                                  {el.assetKind === "audio" ? (
                                    <MusicIcon
                                      aria-hidden="true"
                                      className="size-5 text-muted-foreground"
                                    />
                                  ) : (
                                    <VideoIcon
                                      aria-hidden="true"
                                      className="size-5 text-muted-foreground"
                                    />
                                  )}
                                  {undescribed ? (
                                    <TriangleAlertIcon
                                      aria-hidden="true"
                                      className="absolute right-1 top-1 size-3.5 text-amber-500"
                                    />
                                  ) : null}
                                </span>
                              ) : (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  src={el.previewUrl}
                                  alt=""
                                  // A native image drag would cancel the box drag.
                                  draggable={false}
                                  className="aspect-square w-full rounded-sm border object-cover"
                                />
                              )}
                              <span className="w-full truncate text-xs font-medium">@{name}</span>
                              {undescribed ? (
                                <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                  Not described
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>

                      {selectedElement === null ? (
                        <p className="grid place-items-center rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                          Pick one to see what it is and what it says.
                        </p>
                      ) : (
                        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-md border p-3 text-left">
                          {/* CAPPED, and the cap is on the wrapper rather
                                than the picture, so the Remove button in the
                                corner stays in the picture's corner instead
                                of floating off to the panel's.

                                A square at the panel's full width was ~330px
                                — most of a 600px dialog spent on a picture
                                the operator has already recognised, with the
                                name, category and description it was opened
                                to edit pushed under the fold. Big enough to
                                confirm which reference this is, and no
                                bigger. */}
                          <div
                            className={cn(
                              "relative mx-auto",
                              // THE CAP IS FOR PICTURES ONLY. A native
                              // <audio> starts dropping controls below
                              // about 200px — the timeline goes first,
                              // which is the half that makes it possible to
                              // check a clip is the right one — so the
                              // width that suits a thumbnail would quietly
                              // break the player.
                              //
                              // A VIDEO IS A PLAYER TOO, and was capped at
                              // w-44 (176px) for as long as it was only a
                              // still. Its controls are the same native
                              // controls and they collapse at the same
                              // width, so it joins audio here rather than
                              // staying with the pictures it no longer
                              // behaves like.
                              selectedElement.assetKind === "audio" ||
                                selectedElement.assetKind === "video_ref"
                                ? "w-full"
                                : "w-44",
                            )}
                          >
                            {selectedElement.assetKind === "audio" ? (
                              /* A voice has nothing to look at, so the square
                                   holds the two things that ARE useful: what
                                   kind of reference this is, and the chance to
                                   hear it. Listening is the only way to check a
                                   voice is the right one — a filename is not,
                                   and neither is a paragraph about it.

                                   preload="none": the panel opens on every
                                   selection, and fetching each clip on sight
                                   would pull megabytes nobody asked to hear. */
                              <div className="grid w-full place-items-center gap-3 rounded-md border bg-muted/40 p-4">
                                <MusicIcon
                                  aria-hidden="true"
                                  className="size-10 text-muted-foreground"
                                />
                                <audio
                                  controls
                                  preload="none"
                                  src={selectedElement.previewUrl}
                                  aria-label={`Play @${selectedElement.name}`}
                                  className="w-full max-w-full"
                                />
                              </div>
                            ) : selectedElement.assetKind === "video_ref" ? (
                              failedVideoId === selectedElement.id ? (
                                // Same onError-to-placeholder fallback
                                // bin-thumbnail.tsx uses for a rendered clip:
                                // an expired signed URL on a <video> paints
                                // nothing at all rather than the broken-image
                                // glyph an <img> would show, which reads as
                                // "still loading" forever if left unguarded.
                                <div
                                  role="img"
                                  aria-label={`${selectedElement.name}: no preview`}
                                  className="grid aspect-square w-full place-items-center gap-2 rounded-md border bg-muted/40 text-muted-foreground"
                                >
                                  <VideoIcon aria-hidden="true" className="size-10" />
                                </div>
                              ) : (
                                /* PLAYABLE, which it was not until now.
                                   A voice clip in this same panel has had
                                   `controls` since it shipped, on the
                                   reasoning that listening is the only way
                                   to check a voice is the right one. That
                                   is at least as true of a video, and it
                                   sat here as a frozen first frame with an
                                   aria-hidden on it — announced to nobody,
                                   operable by no one.

                                   preload="metadata" STAYS, and is why no
                                   poster attribute is needed: it paints the
                                   video's own first frame, so the tile is
                                   still its own thumbnail before anything
                                   is pressed (the mechanism bin-thumbnail
                                   .tsx relies on).

                                   `muted` IS GONE. It was only ever there
                                   for the autoplay policy, and this element
                                   has never autoplayed — nothing plays
                                   until the operator presses play. Keeping
                                   it would have meant pressing play on a
                                   clip of someone talking and hearing
                                   silence, which is the failure this whole
                                   change is about. playsInline stays: it
                                   keeps iOS playing in place instead of
                                   throwing the video fullscreen.

                                   The object-cover crop stays too. A
                                   reference is 9:16 and the square shows
                                   the middle of it — enough to know which
                                   clip this is, which is what the panel is
                                   for. */
                                <video
                                  key={selectedElement.id}
                                  src={selectedElement.previewUrl}
                                  preload="metadata"
                                  playsInline
                                  controls
                                  aria-label={`Play @${selectedElement.name}`}
                                  onError={() => setFailedVideoId(selectedElement.id)}
                                  className="aspect-square w-full rounded-md border object-cover"
                                />
                              )
                            ) : (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={selectedElement.previewUrl}
                                alt=""
                                className="aspect-square w-full rounded-md border object-cover"
                              />
                            )}
                            {/* REMOVE LIVES IN THE CORNER OF THE PICTURE now,
                                  not as a third button under the form. It is
                                  the only destructive thing here and it was
                                  sitting in the same row as Save, which is the
                                  arrangement that gets a misfire.

                                  Still two presses: a grid of near-identical
                                  thumbnails needs the second one to name what
                                  it is about to remove, which is what the
                                  label does. */}
                            <button
                              type="button"
                              aria-label={
                                confirmDelete === selectedElement.id
                                  ? `Confirm removing @${selectedElement.name}`
                                  : `Remove @${selectedElement.name}`
                              }
                              disabled={deleting !== null || savingEdit}
                              onClick={() => {
                                if (confirmDelete === selectedElement.id) {
                                  void removeElement(selectedElement.id);
                                } else {
                                  setConfirmDelete(selectedElement.id);
                                }
                              }}
                              className={cn(
                                "absolute right-2 top-2 grid size-7 place-items-center rounded-full border shadow-sm transition-colors",
                                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                                confirmDelete === selectedElement.id
                                  ? "border-destructive bg-destructive text-white"
                                  : "border-border bg-background/90 text-muted-foreground hover:bg-destructive hover:text-white",
                              )}
                            >
                              {deleting === selectedElement.id ? (
                                <Spinner className="size-3.5" />
                              ) : (
                                <XIcon aria-hidden="true" className="size-4" />
                              )}
                            </button>
                            {confirmDelete === selectedElement.id ? (
                              <p className="absolute inset-x-2 bottom-2 rounded bg-background/95 px-2 py-1 text-center text-[11px] text-destructive">
                                Press again to remove @{selectedElement.name}
                              </p>
                            ) : null}
                          </div>

                          {/* 3:1, NOT EVEN HALVES. The two used to split
                                the row because they were both fields; only
                                one is now. The tag is typed and can be long
                                — it is what gets written into a prompt — and
                                the category is one settled word. */}
                          <div className="grid grid-cols-[3fr_1fr] gap-2">
                            <div className="flex flex-col gap-1">
                              <label
                                htmlFor="element-detail-name"
                                className="text-[11px] text-muted-foreground"
                              >
                                Tag
                              </label>
                              <Input
                                id="element-detail-name"
                                value={editName}
                                onChange={(e) => {
                                  setJustSaved(false);
                                  setEditName(e.target.value);
                                }}
                                // LEAVING THE FIELD MEANS FINISHED. The
                                // rename debounce is deliberately slower
                                // than the others; this is what keeps that
                                // from feeling like a delay. Guarded the
                                // same way the effect is, so a blur cannot
                                // save a shape the autosave would refuse,
                                // and cannot re-fire a save already running.
                                onBlur={() => {
                                  if (
                                    elementId === null ||
                                    !detailIsDirty ||
                                    savingEdit ||
                                    !nameIsSavable
                                  )
                                    return;
                                  if (currentKey !== null && currentKey === refusedKey) return;
                                  void saveEdit(elementId);
                                }}
                                disabled={savingEdit}
                                className="h-8 text-sm"
                              />
                            </div>
                            {/* READ-ONLY, and no longer a control at all.
                                  It was a two-option select, and neither
                                  option was ever a choice an operator could
                                  correctly make: the category is decided by
                                  the file's own kind at upload (0081), and
                                  the only edit the select allowed was the
                                  wrong one — filing a picture as Audio, or a
                                  clip as Image, which sends it to the wrong
                                  one of kie's two arrays.

                                  A voice was already locked for exactly that
                                  reason. The same reasoning covers a picture;
                                  it was simply never applied in that
                                  direction.

                                  Sized to its word rather than to the column,
                                  because a full-width box is the shape of
                                  something you fill in, and this is a label. */}
                            <div className="flex flex-col items-center gap-1">
                              <span
                                id="element-detail-category-label"
                                className="text-[11px] text-muted-foreground"
                              >
                                Category
                              </span>
                              <span
                                aria-labelledby="element-detail-category-label"
                                className={cn(
                                  "inline-flex h-8 items-center justify-center rounded-full border px-3 text-sm font-medium",
                                  // Coloured by the value it holds rather
                                  // than green throughout: green on Audio
                                  // would be a colour that means nothing,
                                  // which is worse than no colour at all.
                                  editCategory === "image"
                                    ? "border-green-600/40 bg-green-500/10 text-green-700 dark:text-green-400"
                                    : editCategory === "audio"
                                      ? "border-violet-600/40 bg-violet-500/10 text-violet-700 dark:text-violet-400"
                                      : editCategory === "video"
                                        ? "border-sky-600/40 bg-sky-500/10 text-sky-700 dark:text-sky-400"
                                        : "border-border bg-transparent",
                                )}
                              >
                                {/* The STORED value, which for a row saved
                                      before 0081 is still character, product
                                      or location. Showing it is what keeps
                                      opening this panel from looking like it
                                      rewrote something. */}
                                {CATEGORY_LABEL[editCategory]}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            <label
                              htmlFor="element-detail-description"
                              className="text-[11px] text-muted-foreground"
                            >
                              Description
                            </label>
                            {/* DESCRIBE NOW COVERS BOTH NON-PICTURE KINDS.
                                  This used to be image-only: describe handed
                                  the bytes to Claude as a PICTURE, and pointed
                                  at an MP3 it either errored or, worse,
                                  returned a confident paragraph about a
                                  photograph that does not exist — paid for,
                                  and then pasted into a prompt as the voice's
                                  description. redescribeElement (actions/
                                  ugc.ts) branches on assets.kind: an audio
                                  element goes to kie's Gemini pass over audio
                                  (lib/kie-audio-describe.ts); a video element
                                  goes to kie's Gemini pass over VIDEO instead
                                  (lib/kie-video-describe.ts) — same model,
                                  same key, reading the whole clip rather than
                                  one frame, with its own guard against the
                                  200-but-invented band that describer's own
                                  probing found above ~18.8MB raw. The field
                                  below stays editable regardless of kind —
                                  typing is still how one wrong detail in an
                                  otherwise-right paragraph gets corrected
                                  without re-rolling the whole thing. */}
                            <Button
                              type="button"
                              size="sm"
                              // EMPHASISED, NOT GHOST, while there is
                              // nothing here yet, for audio OR video. A
                              // ghost button reads as optional — fine when
                              // correcting a paragraph that is already
                              // doing its job, wrong for the one press
                              // that stands between this element and
                              // steering no render at all (bindUITags
                              // deletes an undescribed audio tag outright;
                              // an undescribed video tag substitutes to
                              // nothing the same way, through
                              // resolveElementTags rather than bindUITags,
                              // but the render ends up just as blank).
                              variant={
                                (selectedElement.assetKind === "audio" ||
                                  selectedElement.assetKind === "video_ref") &&
                                !editDescription
                                  ? "outline"
                                  : "ghost"
                              }
                              className={cn(
                                "h-6 gap-1 px-1 text-[10px]",
                                (selectedElement.assetKind === "audio" ||
                                  selectedElement.assetKind === "video_ref") &&
                                  !editDescription
                                  ? "border-amber-500/60 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                                  : undefined,
                              )}
                              disabled={redescribing !== null || savingEdit}
                              onClick={() => void redescribe(selectedElement)}
                            >
                              {redescribing === selectedElement.id ? (
                                <Spinner className="size-3" />
                              ) : (
                                <SparklesIcon aria-hidden="true" className="size-3" />
                              )}
                              {editDescription ? "Describe again" : "Describe"}
                            </Button>
                          </div>
                          {/* THE ABSENCE ITSELF, SHOWN HONESTLY — no new
                                column, just the same null this element could
                                already have carried. A blank textarea with a
                                placeholder reads as "nobody has said anything
                                yet, which is fine"; this reads as what an
                                audio OR video element with no description
                                actually is — a tag that substitutes to
                                nothing (bindUITags deletes an undescribed
                                audio tag outright rather than degrading it;
                                an undescribed video tag has nothing for
                                resolveElementTags to substitute for the same
                                reason). Image elements get no such banner: a
                                picture that failed to describe still shows
                                itself in the square above, where neither a
                                voice nor an undescribed video has anything to
                                look at instead. */}
                          {needsHandWrittenDescription(selectedElement) && !editDescription ? (
                            <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                              {selectedElement.assetKind === "audio"
                                ? "Not described yet — a prompt naming this tag leaves a hole where the voice should be. Press Describe above."
                                : "Not described yet — a prompt naming this tag leaves a hole where the video should be. Press Describe above."}
                            </p>
                          ) : null}
                          {/* TYPED, not only re-rolled. "Describe again"
                                rolls the dice; this is the only way to correct
                                one wrong detail in a paragraph that is
                                otherwise right — and this text is exactly what
                                is pasted into the prompt in place of the tag. */}
                          <Textarea
                            id="element-detail-description"
                            rows={4}
                            value={editDescription}
                            onChange={(e) => {
                              setJustSaved(false);
                              setEditDescription(e.target.value);
                            }}
                            disabled={savingEdit}
                            placeholder={
                              selectedElement.assetKind === "audio"
                                ? "What does this voice sound like? This text is sent to the model " +
                                  "alongside the clip when the tag is used."
                                : selectedElement.assetKind === "video_ref"
                                  ? "What happens in this video? This text replaces the tag in a " +
                                    "prompt."
                                  : "What is in this picture? This text replaces the tag in a prompt."
                            }
                            className="text-sm"
                          />

                          {typedName !== selectedElement.name ? (
                            <p className="text-[10px] leading-snug text-muted-foreground">
                              Saving also rewrites @{selectedElement.name} in prompts you have
                              already written.
                            </p>
                          ) : null}

                          {/* NO SAVE BUTTON. The fields write themselves
                                300ms after typing stops, so this line is the
                                only thing left to say what happened — and it
                                has to, because a save nobody pressed is a save
                                nobody knows about. */}
                          <p className="mt-1 flex h-5 items-center gap-1.5 text-[11px] text-muted-foreground">
                            {savingEdit ? (
                              <>
                                <Spinner className="size-3" />
                                Saving
                              </>
                            ) : detailIsDirty && !nameIsSavable ? (
                              // The one case where "Unsaved" alone is a
                              // dead end: nothing the operator does to the
                              // description will make it save, and the
                              // reason is three fields away.
                              <span className="text-destructive">
                                A tag needs letters, numbers, - or _ — and no spaces.
                              </span>
                            ) : detailIsDirty ? (
                              "Unsaved"
                            ) : justSaved ? (
                              <>
                                <CheckIcon aria-hidden="true" className="size-3" />
                                Saved
                              </>
                            ) : null}
                          </p>

                          {/* Only prompt callers get the action to add this
                                saved element to their @tag list. */}
                          {onUseElement
                            ? ((): JSX.Element => {
                                const alreadyIn = (boxTags ?? []).some(
                                  (t) => t.toLowerCase() === selectedElement.name.toLowerCase(),
                                );
                                const full =
                                  !alreadyIn &&
                                  boxLimit !== undefined &&
                                  (boxTags?.length ?? 0) >= boxLimit;
                                return (
                                  // Sticky: the panel scrolls (video, tag,
                                  // description), and a button below the
                                  // fold was one nobody found.
                                  <div className="sticky bottom-0 bg-background pt-2">
                                    <Button
                                      type="button"
                                      className="w-full"
                                      disabled={alreadyIn || full}
                                      onClick={() => pickIntoBox(selectedElement)}
                                    >
                                      {alreadyIn
                                        ? "Already in this scene"
                                        : full
                                          ? `References are full (${boxLimit})`
                                          : "Use element"}
                                    </Button>
                                  </div>
                                );
                              })()
                            : null}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Only once something IS attached. The empty state used to read
          "JPG, PNG or WebP", which restated what the picker itself says and
          described a file that did not exist yet. */}
      {current ? (
        <p className="ml-2 min-w-0 truncate text-xs text-muted-foreground">
          {/* "@name" for a saved Element, the plain filename for a fresh
              upload — the same distinction the prompt editor draws, so a
              reused reference doesn't read as if it were just picked off
              disk. */}
          {current.kind === "element" ? `@${current.name}` : current.name}
        </p>
      ) : null}
    </div>
  );
}
