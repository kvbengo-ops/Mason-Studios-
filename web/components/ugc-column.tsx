"use client";

// The /ugc control column — every control for one clip, in one column, with
// no navigation between them.
//
// The shape is lifted from a competitor's workspace observed on 2026-08-31.
// What was worth copying is not the small number of controls — there are
// five — but that reaching all of them costs zero navigation. The wizard's
// problem was never how many fields it has; it is that they are spread over
// six screens.

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { VIDEO_ITERATE_EVENT, type VideoIterateDetail } from "@/lib/video-iterate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AtSign,
  Check,
  ChevronRight,
  ClockIcon,
  GaugeIcon,
  ImageIcon,
  MusicIcon,
  PlusIcon,
  RectangleHorizontalIcon,
  Sparkles,
  RectangleVerticalIcon,
  SquareIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { PendingFieldset } from "@/components/pending-fieldset";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { generateClip, regenerateClip } from "@/actions/ugc";
import { supportsPromptOnlyVideo } from "@/lib/prompt-only-video";
import { stageFiles } from "@/lib/stage-files";
import { SceneRerenderDialog } from "@/components/scene-rerender-dialog";
import { UgcReferencePicker, type PickedReference } from "@/components/ugc-reference-picker";
import { UgcPromptEditor } from "@/components/ugc-prompt-editor";
import { findElementByTag, KLING_FRAME_EXTS, TAG_PATTERN, type ElementTag } from "@/lib/elements";
import { tagLeadIsWordish, tagsInOrder } from "@/lib/element-tags";
import { unknownPromptTags, unknownTagsWarning } from "@/lib/unknown-tags";
import { buildUgcPromptPreview } from "@/lib/ugc-prompt-preview";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import { isAcceptedReferenceAudio, isAcceptedReferenceVideo } from "@/lib/file-type";
import { maxReferencesFor } from "@/lib/ugc-references";

// How many reference chips show before the rest fold behind "+N more": about
// two rows at the column's width, so a full box of ten never pushes the prompt
// down the page.
const BOX_COLLAPSED_CHIPS = 6;

function modelMenuId(modelId: string): string {
  return modelId === "kling-4.0-reference" ? "kling-4.0" : modelId;
}

import type { RenderBudgetFigures } from "@/lib/render-budget";
import type { ActionNotice, ActionResult } from "@/lib/action-result";
import { ugcTierLabel } from "@/lib/ugc-tier-label";
import { kieModel, SEEDANCE_2_5_BYTEPLUS } from "@/lib/kie/models";
import {
  DEFAULT_VIDEO_QUALITY,
  VIDEO_QUALITIES,
  VIDEO_QUALITY_LABELS,
  type VideoQuality,
} from "@/lib/video-quality";
import { cn } from "@/lib/utils";
import {
  beginGeneratePending,
  clearGeneratePending,
  resolveGeneratePending,
} from "@/lib/ugc-generate-pending-store";

/** A per-second rate in dollars; the rate tables store kie credits (200 per $1). */
function rateLabel(creditsPerSecond: number): string {
  return `$${(creditsPerSecond / 200).toFixed(3)}/s`;
}

export interface UgcOption {
  readonly modelId: string;
  readonly label: string;
  readonly resolution: string;
  readonly durationsS: readonly number[];
  /** Credits per second, so the button can show kie's own unit beside the dollars. */
  readonly creditsPerSecond: number;
  /** True when the rate comes from kie's published page rather than a receipt. */
  readonly unpaid: boolean;
  /**
   * Credits per second for a render CARRYING A VIDEO REFERENCE, or null when
   * this model and resolution have never been billed with one.
   *
   * A SEPARATE NUMBER, not a multiple of creditsPerSecond above. Attaching a
   * video moves seedance-2.5 480p from 28 cr/s to 17 — downward — applied to
   * the video's seconds as well as the clip's. Null is a refusal: the column
   * quotes nothing and disables Generate rather than falling back on the
   * sound rate, which would overquote by 65%.
   */
  readonly videoCreditsPerSecond: number | null;
  /** Exact non-linear Gemini job prices, keyed by output duration. */
  readonly exactCreditsByDuration?: Readonly<Record<number, number>>;
  /** Gemini's fixed price when one source video is attached. */
  readonly fixedVideoCredits?: number | null;
  /**
   * Longest prompt this model accepts, or undefined when it has no known
   * limit. Kling's is 2,500; kie refuses a longer one with a 422 AFTER the
   * spend is approved.
   */
  readonly maxPromptChars?: number;
  /**
   * True only for Kling — lib/models.ts's VideoModelDescriptor.nativeAudio,
   * carried onto the option the same way maxPromptChars already is, so this
   * column can ask "is this Kling" from a model-table flag rather than
   * comparing modelId against a literal string. It is what switches the
   * column into Start/End frame mode (below) instead of the References box.
   */
  readonly nativeAudio: boolean;
  /**
   * Credits per second WITH sound, or null when this model/resolution has
   * never been billed that way. Only meaningful when `nativeAudio` is true —
   * every other model's render either always or never carries sound
   * (generate_audio, not a per-request choice), so nothing else reads this.
   *
   * A SEPARATE NUMBER FROM `creditsPerSecond` above, deliberately: this
   * option's own `creditsPerSecond` is whichever of the sound/silent tables
   * ugcOptions(withSound) was built against — the route's GLOBAL
   * AUDIO_ENABLED setting — and Kling's own Sound On/Off control (below)
   * has to be able to quote EITHER rate regardless of that global default,
   * the same way the model still has both prices measured (lib/kie/rates.ts).
   */
  readonly soundCreditsPerSecond: number | null;
  /** Credits per second WITHOUT sound — Sound On/Off's other quote. See soundCreditsPerSecond's own comment. */
  readonly silentCreditsPerSecond: number | null;
}

export function UgcColumn({
  projectId,
  options,
  selectedScene,
  budget,
  vendor,
  elements,
  audioEnabled,
  readOnly = false,
  layout = "column",
  ensureProject,
}: {
  /**
   * Set on /create, where there is no project step. Generate's confirm finds
   * or makes the account's hidden personal project (actions/ugc.ts) and queues
   * the clip into it, then STAYS on the page — the new clip appears on the
   * wall. `projectId` is "" in that case.
   */
  ensureProject?: () => Promise<{ projectId: string } | { error: string }>;
  /**
   * "column" is the tall left-hand composer; "bar" is the Higgsfield-style
   * prompt bar along the bottom of /create and /ugc — prompt and controls on
   * the left, a tall Generate on the right. Same form, same fields, same
   * submit; only the arrangement differs.
   */
  layout?: "column" | "bar";
  /**
   * True for an admin viewing someone else's project.
   *
   * Everything this column can spend — generateClip, regenerateClip,
   * rerenderScene, retryScene — goes through requireProject and refuses a
   * non-owner in the server, so this is not the boundary. It is what stops
   * the page offering a Generate button that quotes a price and then fails,
   * which is worse than not offering it: the operator has to press it to
   * find out.
   *
   * The prompt, the pickers and the reference stay VISIBLE and inert. They
   * are the whole reason to look at someone else's clip — reading what was
   * asked for is the point of a read-only view.
   */
  readOnly?: boolean;
  projectId: string;
  /**
   * The pairs this route may sell, resolved server-side by
   * lib/kie/offerable.ts. Empty is a real state — it means nothing kie serves
   * can currently be priced against the table the spend cap uses.
   */
  options: readonly UgcOption[];
  /**
   * The scene the strip has selected, or null for a new one.
   *
   * Its prompt is loaded into the field, and its presence is what turns
   * Generate into Regenerate — the rule being that the button follows the
   * result box: Generate while that is empty, Regenerate once it holds
   * something. Both spend, so the word has to be right BEFORE the press.
   */
  selectedScene: {
    id: string;
    idx: number;
    prompt: string;
    /**
     * The version the prompt above came from, or null when the scene has no
     * versions yet. Part of the re-sync key below — see syncedTo.
     */
    versionId?: string | null;
    /**
     * What this scene will ACTUALLY render with, resolved server-side from
     * its stored render_settings_override.
     *
     * Load-bearing, not cosmetic: Regenerate submits only sceneId, prompt and
     * versionMode, so these settings — not the pickers — decide what renders
     * and what it costs. A column that showed the default instead would quote
     * one model and render another.
     */
    modelId?: string | null;
    resolution?: string | null;
    durationS?: number | null;
    /** Live source-video references saved on this scene. */
    videoInputSecondsS?: readonly (number | null)[];
    /**
     * scenes.is_talking_head / scenes.script_line for this scene — not
     * versioned (only video_prompt is), so this is always the scene's
     * CURRENT value even while an older version's prompt is shown above it.
     * generateClip sets is_talking_head to whether the chosen model is
     * Kling (see actions/ugc.ts) — it is what asks Kling for sound, not a
     * Dialogue control this route has. There is still no script_line field
     * here, so if/when the preview below is remounted, it will always
     * degrade to "no dialogue line" regardless of which model rendered the
     * clip.
     */
    isTalkingHead?: boolean;
    scriptLine?: string | null;
    /** Gemini preset voice, or null when Gemini picks its own. */
    voice?: string | null;
    /** Stored aspect_ratio override, or null for the 9:16 default. */
    aspectRatio?: string | null;
    /** Stored re-encode quality, or null for DEFAULT_VIDEO_QUALITY. */
    quality?: VideoQuality | null;
    /**
     * This scene's saved References box — the non-null `tag` values off its
     * `scene_references` rows, ordered by kind then ordinal (ugc/[id]/page.tsx
     * resolves this with one cheap select scoped to the scene).
     *
     * SEEDS THE BOX, does not define it forever: the operator can add or
     * remove from here on, and what actually renders on the next Generate
     * press is whatever the box holds at submit time, not this list. A NEW
     * scene (no selectedScene at all) gets no seed — see the box's own state
     * below, which starts empty rather than reading this field on a null
     * selectedScene.
     */
    referenceTags?: readonly string[];
  } | null;
  /** The three-cap snapshot the Regenerate confirm needs to refuse a render before it is submitted. */
  budget: RenderBudgetFigures;
  /** Which vendor bills this, resolved server-side — KIE_MODELS is not NEXT_PUBLIC_. */
  vendor: string;
  /**
   * isAudioEnabled(), read once on the server and passed down rather than
   * re-imported into this client component. Stands in for the worker's
   * Model.HasAudio for every model this route can offer — Kling reaches this
   * route too now, not just Seedance; see lib/ugc-prompt-preview.ts's own
   * doc comment for why the reduction to this one boolean still holds for
   * both.
   */
  /** Still required of every caller, and deliberately not read here: the
   * only thing in this column that consumed it was the "What actually gets
   * sent" preview, now unmounted above. Kept on the type so restoring that
   * block is one edit rather than a prop threaded back through the page and
   * four tests. */
  audioEnabled: boolean;
  /** The operator's own saved references (0065_elements.sql) — for the picker's Elements tab and the prompt editor's @tag resolution. Empty is normal: nobody has saved one yet. */
  elements: readonly ElementTag[];
}): JSX.Element {
  const bar = layout === "bar";
  // Where Generate queues the clip. Starts as the page's project; on /create
  // it is filled in at confirm time, once the named project exists.
  const [targetProjectId, setTargetProjectId] = useState(projectId);
  const router = useRouter();
  // The scene's own settings win over the route's default. options[0] is only
  // right for a NEW clip; for an existing one it is whatever happens to be
  // first in the list, which is how a Hailuo scene came to be quoted at
  // Seedance's rate.
  function indexOfSceneSettings(): number {
    if (!selectedScene?.modelId) return 0;
    const found = options.findIndex(
      (o) =>
        o.modelId === selectedScene.modelId &&
        (selectedScene.resolution == null || o.resolution === selectedScene.resolution),
    );
    // A scene rendered at a pair this route no longer offers (an unpaid tier
    // that was pulled, say) falls back to the default rather than showing
    // nothing — the mismatch is then visible in the picker instead of hidden.
    return found === -1 ? 0 : found;
  }

  // ---- SETTINGS ARE PINNED ----
  //
  // Asked for directly: Seedance 2.5, 4s, 9:16, one resolution, and no
  // control over any of them. The reason to pin rather than delete is that
  // this route is being tuned for ONE model's prompt behaviour right now —
  // a prompt written against Seedance's own structure is not a prompt for
  // Kling — and a settings row that can quietly move off Seedance makes
  // every observation about a render un-attributable.
  //
  // 480P is the tier the editors work in, and reaching it took an explicit
  // decision: rates.ts prices it at 28 cr/s with `provenance: "published"`
  // (kie's own page, no receipt behind it), which offerable() refuses to
  // sell. That refusal is now waived for this one pair, deliberately and
  // by name — see ACCEPTED_PUBLISHED_RATES in lib/kie/offerable.ts for what
  // is being accepted and what retires it.
  // BACK ON 2.5, by request, the same day it moved off.
  //
  // It moved to seedance-2-fast for price — 11.7 cr/s against 28, $0.234 a
  // clip against $0.56 — and moved back after one look at the output. That
  // is the right way round: the rate is a number and the clip is the
  // product, so a 58% saving is only a saving if the result is usable.
  //
  // seedance-2-fast KEEPS its measured rate and stays in the table. Nothing
  // about that measurement was wasted: it is a receipt now, so the model can
  // be pinned again, or offered beside this one, without spending anything
  // further. What it is not is the default.
  const PINNED_MODEL_ID = "seedance-2.5-byteplus";
  const PINNED_RESOLUTION = "480p";
  const PINNED_DURATION_S = 4;

  // Falls back to whatever is offerable rather than throwing: a pin that
  // cannot be honoured (the rate table changed, the model was withdrawn)
  // should degrade to a working column, and the banner below says which.
  const pinnedIdx = options.findIndex(
    (o) => o.modelId === PINNED_MODEL_ID && o.resolution === PINNED_RESOLUTION,
  );
  // THE PIN IS NOW A DEFAULT, NOT A LAW. It still decides where the column
  // opens — the model whose price and behaviour this route is tuned around —
  // but the operator can move off it for one clip without an admin or a
  // deploy.
  //
  // Seeded once and then owned by the select: re-deriving it from the pin on
  // every render would snap the choice back the moment anything else in this
  // component changed, which is the shape of "the control does nothing" this
  // project has shipped more than once.
  const defaultIdx = pinnedIdx === -1 ? indexOfSceneSettings() : pinnedIdx;
  // An existing scene opens on ITS model, not the pin: the model decides
  // which form renders (Kling's frames or Seedance's box), so opening a Kling
  // scene on the pin showed it as a Seedance scene. -1 when there is no
  // scene, no model, or a model this route no longer offers.
  function sceneOptionIdx(scene: typeof selectedScene): number {
    if (!scene?.modelId) return -1;
    return options.findIndex(
      (o) =>
        o.modelId === scene.modelId &&
        (scene.resolution == null || o.resolution === scene.resolution),
    );
  }
  const [modelIdx, setModelIdx] = useState<number>(() => {
    const idx = sceneOptionIdx(selectedScene);
    return idx === -1 ? defaultIdx : idx;
  });
  // Clamped rather than trusted: `options` comes from the server and can
  // shrink between renders (a rate withdrawn, a model measured out), and an
  // index past the end would blank the whole settings row.
  const optionIdx = modelIdx < options.length ? modelIdx : defaultIdx;
  const option = options[optionIdx];
  // The References box holds 12 on Seedance 2.5 and 10 elsewhere (lib/ugc-references.ts).
  const maxReferences = maxReferencesFor(option?.modelId ?? "");
  const modelOptions = options.filter(
    (o, i) => options.findIndex((candidate) => candidate.modelId === o.modelId) === i,
  );
  const modelMenuOptions = modelOptions.filter(
    (o, i) =>
      modelOptions.findIndex(
        (candidate) => modelMenuId(candidate.modelId) === modelMenuId(o.modelId),
      ) === i,
  );
  const kling4Modes = modelOptions.filter((mode) => modelMenuId(mode.modelId) === "kling-4.0");
  const selectedKling4Id =
    kling4Modes.find((mode) => mode.modelId === option?.modelId)?.modelId ??
    kling4Modes[0]?.modelId;
  const modelLabel =
    option && modelMenuId(option.modelId) === "kling-4.0" ? "Kling 4.0" : option?.label;

  // THE FORM RESET LIES ABOUT THE MODEL. React 19 resets a `<form action>`
  // after every action that returns, error or not, via the native
  // form.reset(). A controlled <input>/<textarea> survives it, because React
  // keeps their default in step with their value, but a controlled <select>
  // does not: its options carry no defaultSelected, so the reset shows
  // options[0] (Seedance) while state, the hidden inputs and the whole form
  // below stay on Kling. The label then names a model other than the one
  // Generate will bill. The `reset` event fires BEFORE the reset is
  // applied, so the correction is queued to run just after it.
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const optionIdxRef = useRef(optionIdx);
  // No deps: this must re-run (and re-read optionIdx) after every render, not
  // just the first — a ref cannot be written during render itself
  // (react-hooks/refs), and the `reset` listener below closes over this same
  // ref rather than optionIdx directly so it always corrects to the CURRENT
  // pick, not whatever pick was selected the one time the listener itself
  // was attached.
  useLayoutEffect(() => {
    optionIdxRef.current = optionIdx;
  });
  useEffect(() => {
    const form = modelSelectRef.current?.form;
    if (!form) return;
    function onReset(): void {
      queueMicrotask(() => {
        if (modelSelectRef.current) modelSelectRef.current.value = String(optionIdxRef.current);
      });
    }
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);
  const pinHonoured = pinnedIdx !== -1;

  // A DEFAULT, not a pin. It was `const durationS = PINNED_DURATION_S`, and
  // the row beside it claimed "Model and Length CAN be changed" while Length
  // could not be changed at all.
  //
  // That mattered as soon as there was something to compare against. The
  // editors' own reference clip for this ad is 5.06 seconds, and the prompt
  // written for ours budgets 0.0s–2.5s and 2.5s–5.0s — five seconds of
  // direction squeezed into a four-second render, which is why the slow
  // beats in it (a 0.15 km/h reach, a blink at 4.5s) never arrive.
  //
  // Seedance takes 4 through 15. Four stays the default because it is the
  // cheapest useful clip and most takes are iterations, but the operator can
  // now buy the second they actually wrote for.
  const [durationS, setDurationS] = useState<number>(selectedScene?.durationS ?? PINNED_DURATION_S);
  const [lengthOpen, setLengthOpen] = useState(false);
  const lengthRef = useRef<HTMLDivElement>(null);
  // The length popover closes on Esc or a press outside it, not only on its own button.
  useEffect(() => {
    if (!lengthOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!lengthRef.current?.contains(e.target as Node)) setLengthOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setLengthOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [lengthOpen]);
  const [prompt, setPrompt] = useState(selectedScene?.prompt ?? "");

  /**
   * Explicit References box selections. Prompt @tags join these below, so
   * saved personal elements can be tagged without opening the picker.
   *
   * Re-synced on `syncKey` below, exactly like `prompt` — switching scenes
   * (or scene versions) has to replace the box, not merge into it, or a
   * reference from the PREVIOUS scene would silently ride along into a
   * Generate press on this one.
   */
  const [selectedTags, setSelectedTags] = useState<string[]>([
    ...(selectedScene?.referenceTags ?? []),
  ]);
  const promptTags = tagsInOrder(prompt);
  // A tag that names no saved element goes through as plain text. The confirm
  // dialogs say so before the clip is paid for.
  const unknownTagsNotice = unknownTagsWarning(unknownPromptTags(prompt, elements));
  const promptElementNames = promptTags.flatMap((tag) => {
    const element = findElementByTag(elements, tag);
    return element ? [element.name] : [];
  });
  const boxTags = [...selectedTags];
  for (const name of promptElementNames) {
    if (!boxTags.some((tag) => tag.toLowerCase() === name.toLowerCase())) boxTags.push(name);
  }
  /** Controls the box's own dedicated dialog instance — see its mount below. */
  const [boxPickerOpen, setBoxPickerOpen] = useState(false);
  // The bar's "+" opens this same dialog on Uploads, its "@" on Elements.
  const [boxPickerTab, setBoxPickerTab] = useState<"uploads" | "elements">("elements");
  const [boxExpanded, setBoxExpanded] = useState(false);

  /**
   * The Start/End pair a saved scene should reopen with.
   *
   * Pictures only, in the order they were written (ordinal). Start is the
   * first; End is the second, but ONLY when the scene was rendered on Kling.
   * On a Seedance scene the second picture is a plain reference, not a
   * frame the clip was asked to land on, and promoting it would quietly
   * change what a switch to Kling renders.
   */
  function seedFrames(scene: typeof selectedScene): {
    start: ElementTag | null;
    end: ElementTag | null;
  } {
    const images = (scene?.referenceTags ?? [])
      .map((tag) => findElementByTag(elements, tag))
      .filter((el): el is ElementTag => el !== undefined && IMAGE_ASSET_KINDS.has(el.assetKind));
    const wasKling = options.some((o) => o.modelId === scene?.modelId && o.nativeAudio);
    return { start: images[0] ?? null, end: wasKling ? (images[1] ?? null) : null };
  }

  /**
   * KLING MODE'S OWN STATE — a Start/End frame pair, not the box above.
   *
   * Seeded by seedFrames() below from the IMAGE tags among referenceTags.
   * It used to take referenceTags[0]/[1] blind, and referenceTags is ordered
   * by kind, so "audio" sorts before "image": a Seedance scene switched to
   * Kling put its voice clip in the Start slot (2026-09-12, @new_audio1 as
   * a blank start frame).
   *
   * Resolved against `elements` (the whole library), same as the box's own
   * tiles resolve a tag it cannot yet find in boxElements: a name this
   * array has not caught up to yet should not make the slot look empty.
   *
   * A NEW scene (selectedScene null) seeds both to null, same "nothing to
   * inherit yet" rule the box follows.
   */
  const [startElement, setStartElement] = useState<ElementTag | null>(
    () => seedFrames(selectedScene).start,
  );
  const [endElement, setEndElement] = useState<ElementTag | null>(
    () => seedFrames(selectedScene).end,
  );
  /** Which slot the shared picker dialog below is currently filling, or none. */
  const [framePickerSlot, setFramePickerSlot] = useState<"start" | "end" | null>(null);
  /**
   * Kling's own Sound On/Off — default ON, matching what every Kling render
   * did before this control existed (isTalkingHead used to be hardcoded
   * true off nativeAudio alone). Seeded from the scene's own is_talking_head
   * on sync, same as boxTags above, so re-opening a Kling scene shows what
   * it actually rendered with rather than snapping back to the default.
   */
  const [klingSoundOn, setKlingSoundOn] = useState(selectedScene?.isTalkingHead ?? true);
  const [geminiVoice, setGeminiVoice] = useState(selectedScene?.voice ?? "");
  const [aspectRatio, setAspectRatio] = useState(selectedScene?.aspectRatio ?? "9:16");
  const [quality, setQuality] = useState<VideoQuality>(
    selectedScene?.quality ?? DEFAULT_VIDEO_QUALITY,
  );

  // NO REFINE. There was a button here that sent the whole prompt to Sonnet
  // and replaced the field with what came back.
  //
  // It is gone because the reference mechanism moved underneath it. A tag now
  // resolves to a description written ONCE, when the element was saved, and
  // generateClip pastes it in — so the thing Refine existed to do at press
  // time already happens, for free, at render time. What was left was a
  // second, slower, more expensive rewrite of the operator's own scene
  // direction, and it failed on the first real prompt: the output has to
  // restate the entire input, which ran past its token ceiling and came back
  // unparseable after the vision call had already been paid for.

  // Re-synced when the SERVER sends a different scene OR a different version.
  // Same shape, and the same reason, as character-setup-form.tsx's own
  // syncedTo: without it, selecting another scene leaves the previous scene's
  // prompt in the field while everything around it has moved on — and
  // Regenerate would then bill for text belonging to a clip nobody is looking
  // at.
  //
  // The VERSION half of that key is not optional. Every attempt at one scene
  // snapshots its own prompt, so switching v2 -> v1 changes the text the
  // server sends while the scene id stays exactly the same. Keying on the id
  // alone would leave v2's words in the box under a screen that says v1
  // everywhere else — the same bug the scene half prevents, one level down,
  // and harder to notice because only the words change.
  const syncKey = selectedScene ? `${selectedScene.id}:${selectedScene.versionId ?? ""}` : null;
  const [syncedTo, setSyncedTo] = useState(syncKey);
  if (syncKey !== syncedTo) {
    setSyncedTo(syncKey);
    setPrompt(selectedScene?.prompt ?? "");
    setSelectedTags([...(selectedScene?.referenceTags ?? [])]);
    // Kling's own pair, re-seeded the same way boxTags is — see seedFrames.
    const frames = seedFrames(selectedScene);
    setStartElement(frames.start);
    setEndElement(frames.end);
    setKlingSoundOn(selectedScene?.isTalkingHead ?? true);
    setGeminiVoice(selectedScene?.voice ?? "");
    setAspectRatio(selectedScene?.aspectRatio ?? "9:16");
    setQuality(selectedScene?.quality ?? DEFAULT_VIDEO_QUALITY);
    // THE PICKER FOLLOWS THE SCENE. The model decides which form renders
    // (Kling's frames or Seedance's box), so a picker left on the previous
    // scene's model opened a Seedance scene in Kling mode: its first picture
    // was forced into Start frame, its @tags were flagged as plain words, and
    // Regenerate would have re-rendered it on Kling. A NEW scene (no
    // modelId) keeps whatever the operator last picked, and so does a scene
    // whose model this route no longer offers.
    const sceneIdx = sceneOptionIdx(selectedScene);
    if (sceneIdx !== -1) setModelIdx(sceneIdx);
  }

  // UNSENT NEW-SCENE PROMPT SURVIVES LEAVING THE TAB. Switching Image ⇄ Video
  // on /create unmounts this column, and the half-written prompt went with it.
  // Only the NEW scene's box is kept: a saved scene reloads its own prompt.
  // Restored after mount (a lazy initializer would break hydration), and the
  // loaded flag is STATE so the first save runs a render later — see
  // image-generator-form.tsx's `restored` for the race a ref allowed.
  const isNewScene = selectedScene === null || selectedScene === undefined;
  const draftKey = `ugc:draft:${ensureProject ? "create" : projectId}`;
  const [draftLoaded, setDraftLoaded] = useState(false);
  function updatePromptDraft(nextPrompt: string): void {
    setPrompt(nextPrompt);
    if (!draftLoaded || !isNewScene) return;
    // Write on input too, so immediate navigation cannot beat the save effect.
    try {
      window.localStorage.setItem(draftKey, nextPrompt);
    } catch {
      // The form still works when browser storage is blocked.
    }
  }

  /* eslint-disable react-hooks/set-state-in-effect -- restore after mount, see above */
  useEffect(() => {
    try {
      const saved = isNewScene ? window.localStorage.getItem(draftKey) : null;
      if (saved) setPrompt(saved);
    } catch {
      // Site data blocked: a forgotten draft, nothing worse.
    }
    setDraftLoaded(true);
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!draftLoaded || !isNewScene) return;
    try {
      window.localStorage.setItem(draftKey, prompt);
    } catch {
      // Out of quota or blocked — only the draft is lost.
    }
  }, [draftLoaded, isNewScene, draftKey, prompt]);

  // Which reference this generation uses — a fresh upload, or a saved
  // Element (0065_elements.sql) picked from ugc-reference-picker.tsx's
  // Elements tab. `fileRef` is the hidden file input this form actually
  // submits (generateClip reads `formData.get("image")`): a file input's
  // `.files` cannot be set from a React prop, so handlePick below writes
  // into it imperatively via DataTransfer whenever the picker hands back an
  // upload — the one legal way to hand a File to a native file input that
  // did not receive it from the browser's own picker UI.
  const [reference, setReference] = useState<PickedReference | null>(null);

  /** Explicit references and directly tagged personal elements share one visible box. */
  const boxElements: ElementTag[] = boxTags
    .map((tag) => findElementByTag(elements, tag))
    .filter((el): el is ElementTag => el !== undefined);

  // "Reuse prompt" in /create's clip viewer (lib/video-iterate.ts)
  // refills the bar: prompt, References box, model tier and length. Kling has
  // no box (its frames are not scene_references tags), so for a Kling take
  // only the words and the settings carry over.
  useEffect(() => {
    function onIterate(event: Event): void {
      const detail = (event as CustomEvent<VideoIterateDetail>).detail;
      setPrompt(detail.prompt);
      setSelectedTags([...detail.referenceTags]);
      const idx = options.findIndex(
        (o) =>
          o.modelId === detail.modelId &&
          (detail.resolution === null || o.resolution === detail.resolution),
      );
      if (idx !== -1) setModelIdx(idx);
      if (detail.durationS) setDurationS(detail.durationS);
    }
    window.addEventListener(VIDEO_ITERATE_EVENT, onIterate);
    return () => window.removeEventListener(VIDEO_ITERATE_EVENT, onIterate);
  }, [options]);

  function addTagsToBox(names: readonly string[]): void {
    setSelectedTags((prev) => {
      const next = [...prev];
      for (const name of names) {
        if (next.some((t) => t.toLowerCase() === name.toLowerCase())) continue;
        if (
          new Set([...next, ...promptElementNames].map((tag) => tag.toLowerCase())).size >=
          maxReferences
        )
          break;
        next.push(name);
      }
      return next;
    });
  }

  function removeTagFromBox(name: string): void {
    setSelectedTags((prev) => prev.filter((t) => t.toLowerCase() !== name.toLowerCase()));
    setPrompt((prev) =>
      prev.replace(new RegExp(TAG_PATTERN), (whole, tag: string, at: number) =>
        tag.toLowerCase() === name.toLowerCase() && !tagLeadIsWordish(prev, at) ? tag : whole,
      ),
    );
  }

  const primaryOutsideBox =
    reference !== null &&
    (reference.kind === "upload" ||
      !boxElements.some((element) => element.id === reference.elementId));
  const tooManyReferences = boxTags.length + Number(primaryOutsideBox) > maxReferences;
  // Kling 4.0 Reference too: the worker sends it images only (kling4RefInput).
  const geminiAudioReference =
    (option?.modelId === "gemini-omni-video" || option?.modelId === "kling-4.0-reference") &&
    ((reference?.kind === "upload" && isAcceptedReferenceAudio(reference.file)) ||
      [...prompt.matchAll(new RegExp(TAG_PATTERN))].some((match) => {
        const name = match[1];
        return name !== undefined && findElementByTag(elements, name)?.assetKind === "audio";
      }));

  /**
   * The first saved reference named by an @tag in the prompt.
   *
   * lib/elements.ts describes an Element as something an operator can "summon
   * by typing @name", and the prompt editor resolves those tags, previews them
   * on hover and marks the ones that miss. All of which described a reference
   * that then reached nothing: only the picker set `elementId`, so a prompt
   * reading "@jen at a counter" left Generate greyed out under the words
   * "attach a reference image".
   *
   * FIRST tag, not all of them. A clip has exactly one conditioning frame, and
   * "@jen holding @bottle" names two things without saying which one the
   * camera starts on — so the earliest wins and the reference row shows which
   * it chose, rather than the choice being made silently or the press being
   * refused over a sentence that reads fine.
   *
   * An explicit pick still beats a tag: someone who opened the picker and
   * chose has answered the question the tag only implies.
   */
  //
  // Not memoized. The React Compiler refuses to preserve a useMemo here
  // ("existing memoization could not be preserved") and the memo was never
  // earning its keep anyway: this walks one short prompt for one match.
  const taggedReferences = ((): PickedReference[] => {
    const out: PickedReference[] = [];
    const seen = new Set<string>();
    for (const match of prompt.matchAll(new RegExp(TAG_PATTERN))) {
      const name = match[1];
      if (!name) continue;
      const element = findElementByTag(boxElements, name);
      if (!element || seen.has(element.id)) continue;
      // A PICTURE, OR NOTHING. This slot is the clip's conditioning frame —
      // the single image the render starts from — and until 0093 every
      // element that could be tagged was one, so no filter was needed here.
      // It is now: a tagged voice or video resolves like any other element,
      // and the FIRST tag wins this slot, so "@new_video1 in a kitchen" made
      // an MP4 the starting frame. generateClip then copied it under
      // ref_frame with a .jpg extension and sent the video's bytes in
      // reference_image_urls, which is the exact failure a picked MP3 caused
      // on 2026-09-04 (see actions/ugc.ts's primaryKind), returning
      // code=500 msg="File type not supported" after the spend was approved.
      //
      // Skipping them here does NOT drop them from the render: generateClip
      // resolves every tag server-side and writes its own scene_references
      // row per tag, and a video rides out in reference_video_urls from
      // there. What this decides is only which one is the FRAME.
      if (!IMAGE_ASSET_KINDS.has(element.assetKind)) continue;
      seen.add(element.id);
      out.push({
        kind: "element",
        elementId: element.id,
        name: element.name,
        previewUrl: element.previewUrl,
      });
    }
    return out;
  })();

  // The picture the FORM carries. Every other tagged reference reaches the
  // render too, but server-side: generateClip resolves the prompt's tags
  // itself and writes a scene_references row for each, so this only decides
  // which one the picker and the hidden elementId field point at.
  //
  // An explicit picker choice wins over the tags, and the first resolvable
  // tag stands in when there is none.
  const effectiveReference = reference ?? taggedReferences[0] ?? null;

  /**
   * The prompt names references, and not one of them can be the frame.
   *
   * Only ever read to EXPLAIN a disabled button, never to enable one — a
   * video genuinely cannot be a conditioning frame, and this distinguishes
   * "you attached nothing" from "what you attached cannot go in this slot".
   */
  const hasNonImageTagOnly =
    reference === null &&
    taggedReferences.length === 0 &&
    [...prompt.matchAll(new RegExp(TAG_PATTERN))].some((match) => {
      const name = match[1];
      if (!name) return false;
      const element = findElementByTag(boxElements, name);
      return element !== undefined && !IMAGE_ASSET_KINDS.has(element.assetKind);
    });

  const fileRef = useRef<HTMLInputElement>(null);

  function handlePick(picked: PickedReference): void {
    setReference(picked);
    if (fileRef.current) {
      if (picked.kind === "upload") {
        const transfer = new DataTransfer();
        transfer.items.add(picked.file);
        fileRef.current.files = transfer.files;
      } else {
        // An Element carries no File — generateClip resolves it server-side
        // from `elementId` instead (actions/ugc.ts). Clearing the file
        // input is what stops a PREVIOUSLY chosen upload from silently
        // riding along as `image` alongside the elementId hidden field.
        fileRef.current.value = "";
      }
    }
  }

  if (!option) {
    return (
      <p className="max-w-md text-sm text-muted-foreground">
        No model and resolution can be priced right now, so nothing here could quote a render
        honestly. Check KIE_MODELS and the kie rates in lib/kie/rates.ts.
      </p>
    );
  }

  const tierOptions = options.filter((o) => o.modelId === option.modelId);
  const resolutions = kieModel(option.modelId)?.resolutions ?? tierOptions.map((o) => o.resolution);
  // Whose published price the confirm dialog's "not a receipt" note names.
  const rateSource = option.modelId === SEEDANCE_2_5_BYTEPLUS.id ? "BytePlus" : "kie";

  // THE TRIGGER FOR EVERYTHING BELOW THAT DIFFERS FOR KLING. option.nativeAudio,
  // not a string compare against "kling-3.0-pro" — see that field's own
  // comment on UgcOption for why a model-table flag is the right question to
  // ask, the same way maxPromptChars already is.
  const isKling = option.nativeAudio;
  // Only for models that take a ratio; the rest render 9:16 and send none.
  const aspectRatios = kieModel(option.modelId)?.aspectRatios ?? [];
  const activeAspectRatio = aspectRatios.find((r) => r === aspectRatio);
  const promptOnlyAllowed = supportsPromptOnlyVideo(option.modelId);
  // A tagged video needs no picture beside it — Seedance's multimodal
  // reference mode (see generateClip's matching rule in actions/ugc.ts). A
  // model that cannot take a video is still stopped by the video-rate check.
  const tagsAVideo = promptTags.some(
    (tag) => findElementByTag(boxElements, tag)?.assetKind === "video_ref",
  );
  const missingRequiredReference = isKling
    ? !startElement && (!promptOnlyAllowed || !!endElement)
    : !effectiveReference && (!promptOnlyAllowed || (promptTags.length > 0 && !tagsAVideo));

  // See isBadKlingFrameExt's own comment. Computed unconditionally (cheap:
  // two nullable checks) rather than gated on isKling, the same reasoning
  // the rest of this file gives for a handful of unconditional reads —
  // there is no cost to paying for this when it is not Kling, and gating it
  // would be one more place that has to remember which mode it is in.
  const startFrameBadExt = isBadKlingFrameExt(startElement);
  const endFrameBadExt = isBadKlingFrameExt(endElement);
  const klingBadFrames: { name: string; ext: string }[] = [
    ...(startFrameBadExt && startElement
      ? [{ name: startElement.name, ext: startElement.imageExt ?? "" }]
      : []),
    ...(endFrameBadExt && endElement
      ? [{ name: endElement.name, ext: endElement.imageExt ?? "" }]
      : []),
  ];

  // A model change can strand a duration the new one does not allow — Hailuo
  // offers 6 and 10 only, Seedance every second from 4. Snap rather than
  // submitting a value the server will refuse.
  const durations = option.durationsS;
  const activeDuration = durations.includes(durationS)
    ? durationS
    : durations.reduce((best, d) =>
        Math.abs(d - durationS) < Math.abs(best - durationS) ? d : best,
      );

  /**
   * The video references this prompt tags, and what they add to the bill.
   *
   * WHAT THE CONFIRM DIALOG WAS GETTING WRONG. `creditsPerSecond *
   * activeDuration` prices the clip alone, which is right for the
   * overwhelming majority of renders and wrong for every one carrying a
   * video: kie bills those for the reference's seconds too, and at 17 cr/s
   * rather than 28 (lib/kie/rates.ts's `video` table). On a 4s clip with a
   * 4.064s video that is 136 credits against the 112 this quoted — and on
   * an 8s clip it is 204 against 224, so the error changes SIGN at about
   * 6.2 seconds. Neither direction is a number worth asking somebody to
   * approve.
   *
   * The seconds are floored, because that is what both receipts show: a
   * 4.064s reference bills as 4.
   */
  const taggedVideoDurationsS = ((): (number | null)[] => {
    const out: (number | null)[] = [];
    const seen = new Set<string>();
    for (const match of prompt.matchAll(new RegExp(TAG_PATTERN))) {
      const name = match[1];
      if (!name) continue;
      const element = findElementByTag(boxElements, name);
      if (!element || seen.has(element.id)) continue;
      seen.add(element.id);
      if (element.assetKind !== "video_ref") continue;
      out.push(element.durationS ?? null);
    }
    // A direct Gemini upload is not an @tag, but it is still a billed source
    // video. Include its measured duration in the same quote and availability
    // checks used for saved video references.
    if (
      effectiveReference?.kind === "upload" &&
      isAcceptedReferenceVideo(effectiveReference.file)
    ) {
      out.push(effectiveReference.durationS ?? null);
    }
    return out;
  })();

  /**
   * The model cannot take a video at this tier — nobody has ever been billed
   * for this pair with one attached.
   *
   * TRUE OF EVERY MODEL BUT ONE TODAY: only seedance-2.5 480p has a video
   * receipt. Kling, Seedance 2.0 and 2.0 Fast all land here, so this is the
   * common case rather than the exotic one, and it has nothing to do with
   * the operator's file.
   */
  const modelTakesNoVideo =
    taggedVideoDurationsS.length > 0 &&
    option.videoCreditsPerSecond === null &&
    (option.fixedVideoCredits ?? null) === null;

  /**
   * The file's own length was never measured, so nothing can price it.
   *
   * assets.duration_s is null when the browser could not decode the upload.
   * Unlike the case above, this one IS about the file, and re-uploading it
   * is the thing that might work.
   */
  const videoLengthUnmeasured = !modelTakesNoVideo && taggedVideoDurationsS.some((d) => d === null);

  /**
   * Either way the render cannot be priced, so Generate stays off.
   *
   * TWO CAUSES, TWO MESSAGES, and they were one until 2026-09-11. This was a
   * single `videoPriceUnknown` whose message said only "that video's length
   * was never measured — re-upload it". On Kling that sentence is false in
   * every word: the file is fine, the length is known, and re-uploading it
   * cannot help, because the model has no video rate at all. The operator
   * would do exactly as told, fail again, and find nothing on screen saying
   * the model was the problem. #121 named this in its own limits section
   * rather than let it ship unremarked; it arrived in #120, with me.
   *
   * REFUSES RATHER THAN GUESSES, either way — the same direction estimateCost
   * takes server-side, where an unpriceable render becomes +Infinity and the
   * cap declines. Quoting the clip alone would have the operator approve a
   * spend the server then refuses, which is a press that could not have
   * worked and no way to have known.
   */
  const videoPriceUnknown = modelTakesNoVideo || videoLengthUnmeasured;

  /**
   * How long the prompt will be WHEN IT REACHES kie, and whether this model
   * will take it.
   *
   * THE SUBMITTED LENGTH, NOT THE TYPED ONE, and that distinction is the
   * whole bug. On 2026-09-11 a Kling render was refused with code=422 "The
   * length of 'prompt' must not exceed 2500 characters" — after the operator
   * approved 80 credits. The box held 2,310 characters, comfortably under;
   * substituting @greta_ref, @mug_ref and @Audio_5 for their saved
   * descriptions added 2,430 more and the vendor saw 4,740. A check against
   * the box would have passed and the render would still have died.
   *
   * buildUgcPromptPreview, not a second substitution written here: it calls
   * the same substituteElementTags actions/ugc.ts's resolveElementTags calls,
   * which is the only way this number cannot drift from the one the server
   * actually sends.
   *
   * scriptLine null and isTalkingHead false are honest for every /ugc scene:
   * this route writes no script_line on any model, and the preview's dialogue
   * append needs both. Passing them keeps the call explicit rather than
   * relying on a default that could change.
   *
   * KLING IS THE ONE CASE WHERE THE TYPED LENGTH *IS* THE SUBMITTED ONE.
   * There is no box in Kling mode and no substitution — actions/ugc.ts's
   * generateClip leaves a Kling prompt exactly as typed, letting the
   * worker's model-aware bindUITags (42d29e3) strip a bare '@' rather than
   * resolving it into a description here. buildUgcPromptPreview would still
   * substitute against the WHOLE library if asked, which would reintroduce
   * the exact "the box looks shorter than what kie sees" gap this comment's
   * own history describes — so Kling skips it outright and measures what
   * was typed.
   */
  const submittedPromptLength = isKling
    ? prompt.length
    : buildUgcPromptPreview({
        prompt,
        elements,
        scriptLine: null,
        isTalkingHead: false,
        audioEnabled,
        durationS: activeDuration,
      }).submitted.length;

  /**
   * By how much the prompt overruns what this model will accept, or 0.
   *
   * REFUSES BEFORE THE PRESS. kie's own refusal is a 422 that arrives after
   * the confirm dialog has been approved, leaves the scene marked failed,
   * and names a limit nothing in this product knew about. Every input to
   * that answer — the prompt, the tags, the model — is already on this
   * screen, so there is no reason the operator should learn it from the
   * vendor.
   */
  const promptOverBy =
    option.maxPromptChars !== undefined && submittedPromptLength > option.maxPromptChars
      ? submittedPromptLength - option.maxPromptChars
      : 0;

  /**
   * Kling's OWN quote, off the Sound On/Off control rather than the global
   * AUDIO_ENABLED default `option.creditsPerSecond` was built against.
   *
   * `effectiveSoundOn` folds in AUDIO_ENABLED (audioEnabled) even though the
   * control is hidden/disabled whenever it is false — the same "the UI hides
   * it, the calculation still refuses to trust that" belt-and-braces rule
   * this file already applies elsewhere (e.g. the pinned-model banner).
   *
   * NULL, NOT A FALLBACK RATE, when this tier has never been billed the way
   * the toggle asks for — same "unknown is not free" rule priceForSecond
   * itself follows (lib/models.ts). Both of Kling's offered tiers have a
   * receipt for both sound states today, so this is a defensive branch
   * rather than a reachable one, but a future tier with only one measured
   * is not made to look priced by accident.
   */
  const effectiveSoundOn = isKling && audioEnabled && klingSoundOn;
  const klingRate = effectiveSoundOn ? option.soundCreditsPerSecond : option.silentCreditsPerSecond;
  const klingCredits = klingRate === null ? null : klingRate * activeDuration;

  /**
   * The clip alone, ignoring any tagged video.
   *
   * Still needed after the video pricing above, because Regenerate prices a
   * DIFFERENT render: regenerateClip re-runs the selected scene off its own
   * scene_references rows, not off whatever this prompt currently tags.
   *
   * KLING NEVER TAKES A VIDEO REFERENCE (there is no box to tag one from),
   * so its own quote is exactly klingCredits above — no separate "clip
   * alone versus clip-plus-video" question exists for it the way it does
   * for the tag-driven models below.
   */
  const exactCredits = option.exactCreditsByDuration?.[activeDuration] ?? null;
  const clipOnlyCredits = isKling
    ? (klingCredits ?? 0)
    : (exactCredits ?? option.creditsPerSecond * activeDuration);
  // A regenerate uses the scene's saved references, not the tags currently
  // in the editor. Gemini's video price is fixed, so preserve that fact when
  // the selected scene already has a source video.
  const regenerateCredits =
    selectedScene && (selectedScene.videoInputSecondsS?.length ?? 0) > 0
      ? (option.fixedVideoCredits ?? clipOnlyCredits)
      : clipOnlyCredits;
  const regenerateUsd = regenerateCredits / 200;
  const geminiSourceVideoUnavailable =
    option.modelId === "gemini-omni-video" &&
    (selectedScene?.videoInputSecondsS?.length ?? 0) > 0 &&
    option.fixedVideoCredits == null;

  const credits = isKling
    ? klingCredits
    : videoPriceUnknown
      ? null
      : taggedVideoDurationsS.length > 0
        ? (option.fixedVideoCredits ??
          option.videoCreditsPerSecond! *
            (activeDuration +
              taggedVideoDurationsS.reduce<number>((sum, d) => sum + Math.floor(d ?? 0), 0)))
        : (exactCredits ?? option.creditsPerSecond * activeDuration);
  const usd = credits === null ? null : credits / 200;
  // The three values that decide the number above, named on the confirm so
  // the price can be checked against something rather than taken on trust.
  // ugcTierLabel, not option.resolution raw — display only; the hidden
  // `resolution` input below and every write still carry the real value.
  const settingsLabel = `${option.label} · ${ugcTierLabel(option.modelId, option.resolution)} · ${activeDuration}s`;

  async function submit(formData: FormData): Promise<ActionResult | ActionNotice | void> {
    // Only the new-scene path reaches here. Regenerate goes through the
    // confirm dialog instead — see the button below.
    //
    // BEFORE THE AWAIT, not after — this is the one line the strip's
    // placeholder tile (ugc-pending-scene-tile.tsx) depends on. generateClip
    // takes 4-5s on a real project, and the press has to say so from the
    // instant it lands, not from whenever the request happens to resolve.
    // See lib/ugc-generate-pending-store.ts for why this is a plain external
    // store rather than transition/optimistic state.
    // From the form, not the prop: on /create the project is made at confirm
    // time and only the hidden field carries its id.
    const pid = String(formData.get("projectId") ?? projectId);
    beginGeneratePending(pid);
    let result: Awaited<ReturnType<typeof generateClip>>;
    try {
      await stageFiles(formData);
      result = await generateClip(formData);
    } catch (err) {
      // Nothing is coming back — clear the placeholder immediately rather
      // than leaving it to the 30s safety timeout. The error itself still
      // propagates to ActionForm's own catch/toast; this only clears the
      // strip's stand-in.
      clearGeneratePending(pid);
      throw err;
    }
    // "sceneId" in result, not `!result?.error` — GenerateClipResult's error
    // branch types `error` as `string`, not a literal, so a truthiness check
    // on it does not narrow the union and `result.sceneId` would not
    // typecheck below. The property check does.
    if (result && "sceneId" in result) {
      // THE SELECTION MOVES TO THE NEW SCENE. The prompt reappearing after
      // this is not "the prompt survives" — it never had anywhere to go: the
      // newly selected scene's prompt is the same text the operator just
      // typed. What actually changes is the URL, from "+ New scene" to the
      // scene that was just queued, so the operator watches the clip they
      // just paid for render instead of staring at a composer that looks
      // untouched. The reference is cleared: an upload's object URL is
      // revoked (nothing else holds it once this clears), and an Element
      // pick does not carry forward either — the next clip should be a
      // conscious choice, not last render's leftover.
      if (reference?.kind === "upload") {
        URL.revokeObjectURL(reference.previewUrl);
      }
      setReference(null);
      if (fileRef.current) fileRef.current.value = "";
      // Records WHICH scene the placeholder is standing in for. The tile
      // itself decides when to step aside (once this id shows up among the
      // real scenes the strip was server-rendered with) — this does not
      // hide it, only tells it what to watch for.
      resolveGeneratePending(pid, result.sceneId);
      if (ensureProject) {
        // /create: the clip lands on the wall behind this bar, not on a page,
        // so the bar empties for the next one.
        setPrompt("");
        clearGeneratePending(pid);
        router.refresh();
      } else {
        // Sent: the draft is now a scene, so it must not refill the next one.
        try {
          window.localStorage.removeItem(draftKey);
        } catch {
          // Blocked storage — nothing to clear.
        }
        router.push(`/ugc/${pid}?scene=${result.sceneId}`);
      }
      return result.notice ? { notice: result.notice } : undefined;
    }
    // {error}, or the never-actually-returned `undefined` ActionResult
    // carries — either way there is no scene coming, so the placeholder has
    // nothing left to wait for.
    clearGeneratePending(pid);
    return result;
  }

  return (
    <ActionForm
      action={submit}
      fallbackErrorMessage="The clip could not be queued."
      // min-h-0 + overflow-y-auto so the column scrolls INSIDE the row rather
      // than being clipped by the page's overflow-hidden. On a short screen the
      // prompt box, the four settings and the Generate button do not all fit,
      // and the button is the one that would fall off the bottom — a control
      // that spends money, unreachable, with no scrollbar to say so.
      className={
        bar
          ? "relative w-full rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur"
          : "flex min-h-0 w-full max-w-md flex-1 flex-col gap-3 overflow-y-auto"
      }
    >
      <PendingFieldset className={bar ? "!flex items-stretch gap-3" : undefined}>
        {selectedScene ? <input type="hidden" name="sceneId" value={selectedScene.id} /> : null}
        <input type="hidden" name="projectId" value={targetProjectId} />
        <input type="hidden" name="modelId" value={option.modelId} />
        <input type="hidden" name="resolution" value={option.resolution} />
        <input type="hidden" name="durationS" value={activeDuration} />
        {option.modelId === "gemini-omni-video" && geminiVoice ? (
          <input type="hidden" name="geminiVoice" value={geminiVoice} />
        ) : null}
        {activeAspectRatio ? (
          <input type="hidden" name="aspectRatio" value={activeAspectRatio} />
        ) : null}
        <input type="hidden" name="quality" value={quality} />
        {isKling ? (
          <>
            {/* KLING'S OWN PAIR, not elementId/referencesBox. actions/ugc.ts's
                generateClip/regenerateClip read these only when the chosen
                model is Kling — see that file's own comment on why the two
                shapes cannot both be present on one submission. endElementId
                is omitted entirely when unset, the same "absent, not empty"
                rule referencesBox's own marker follows below for a reason —
                a submitted-but-empty end frame would read as "clear the
                existing one" on a Regenerate, which is not what leaving a
                slot untouched means. */}
            {startElement ? (
              <input type="hidden" name="startElementId" value={startElement.id} />
            ) : null}
            {endElement ? <input type="hidden" name="endElementId" value={endElement.id} /> : null}
            {/* "1"/"0", not a checkbox's own on/absent shape — Regenerate has
                to be able to tell "sound off" apart from "sound field never
                submitted", the same reason referencesBox below is a marker
                rather than inferred from referenceTag's presence. */}
            <input type="hidden" name="sound" value={effectiveSoundOn ? "1" : "0"} />
          </>
        ) : (
          <>
            {effectiveReference?.kind === "element" ? (
              <input type="hidden" name="elementId" value={effectiveReference.elementId} />
            ) : null}
            {effectiveReference?.kind === "upload" &&
            isAcceptedReferenceVideo(effectiveReference.file) ? (
              <input
                type="hidden"
                name="primaryVideoDurationS"
                value={
                  typeof effectiveReference.durationS === "number"
                    ? String(effectiveReference.durationS)
                    : ""
                }
              />
            ) : null}

            {/* THE BOX, SUBMITTED. `referencesBox` is the marker generateClip
                (actions/ugc.ts) reads to know this request came through a column
                that rendered a box at all — its ABSENCE, not just an empty
                `referenceTag` list, is what lets retryClip's marker-less
                regenerate through unchanged. Always present on this form
                (unlike `elementId` above, which is conditional): a new scene
                with an empty box still submits the marker with zero
                `referenceTag` fields, and that is a real, enforceable box —
                "empty" — not "no box was ever shown". */}
            <input type="hidden" name="referencesBox" value="1" />
            {boxTags.map((tag) => (
              <input key={tag} type="hidden" name="referenceTag" value={tag} />
            ))}
          </>
        )}

        {/* NO operatorPrompt. It carried what the operator typed BEFORE
            Refine rewrote it, and Refine is gone — the box is now the only
            prompt there has ever been for a clip. 0072's pair still means
            something: video_prompt is what is written here, and
            ai_generated_prompt is that same text with every "@name" replaced
            by its element's description, which generateClip does itself. */}
        {/* The file this form actually submits when `reference` is an
            upload — populated imperatively by handlePick above, never by a
            React `value` (file inputs don't take one). Kept mounted
            unconditionally (not swapped in/out with the elementId field)
            so `fileRef` stays attached to the same DOM node across
            re-renders. */}
        <input
          ref={fileRef}
          type="file"
          name="image"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />

        {/* In "bar" layout everything up to Generate is the left column;
            "contents" leaves the column layout exactly as it was. */}
        <div className={bar ? "flex min-w-0 flex-1 flex-col gap-2" : "contents"}>
          {/* ---- frames (Kling) / references (everything else) ----

            KLING GETS ITS OWN SECTION, not the box below. Kling is
            start-frame-plus-optional-end-frame, a fixed two positions kie's
            own image_urls documents, not an open-ended allowlist a prompt
            @tags into — so it gets two tiles instead of a grid, and neither
            one is reachable through the box's own "Add" dialog. */}
          {isKling ? (
            <section className="flex flex-col gap-1.5">
              <Label
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
                  bar && "sr-only",
                )}
              >
                Frames
              </Label>
              <div className={bar ? "flex flex-wrap gap-2" : "grid grid-cols-2 gap-1.5"}>
                <KlingFrameSlot
                  label="Start frame"
                  required={!promptOnlyAllowed || !!endElement}
                  element={startElement}
                  disabled={readOnly}
                  onOpen={() => setFramePickerSlot("start")}
                  onRemove={() => setStartElement(null)}
                  badExt={startFrameBadExt}
                  compact={bar}
                />
                <KlingFrameSlot
                  label="End frame"
                  required={false}
                  element={endElement}
                  disabled={readOnly}
                  onOpen={() => setFramePickerSlot("end")}
                  onRemove={() => setEndElement(null)}
                  badExt={endFrameBadExt}
                  compact={bar}
                />
              </div>
              {/* NAMED, same "silent refusal is a bug class" rule as the @tag
                line below — kie's Kling 3.0 refuses a webp frame at submit
                (KLING_FRAME_EXTS' own comment), so this has to say which
                slot is the problem before Generate/Regenerate ever go out
                and get refused for real. */}
              {klingBadFrames.length > 0 ? (
                <p className="text-xs text-destructive">
                  {klingBadFrames.map((f) => `@${f.name} is a ${f.ext.toUpperCase()}`).join("; ")} —
                  Kling only takes PNG or JPG frames. Pick another image.
                </p>
              ) : null}
              {/* THE SAME DIALOG, NOT A COPY — same reasoning as the box's own
                second instance below: Elements-only (elementsOnly) and
                pictures-only (imagesOnly), no Uploads tab and no non-image
                element pickable, because a Kling frame is a picture and
                nothing else. No boxTags/boxLimit: a frame slot has no
                "already in this scene" or "full" state of its own — it
                holds exactly one element, and picking a new one simply
                replaces whichever slot is open. onPick is unused on this
                path (Elements-only has no Uploads tab to hand a fresh file
                back from) but the prop is required, so a no-op stands in. */}
              <UgcReferencePicker
                projectId={projectId}
                elements={elements}
                current={null}
                onPick={() => {}}
                elementsOnly
                imagesOnly
                hideTrigger
                initialTab="elements"
                open={framePickerSlot !== null}
                onOpenChange={(next) => {
                  if (!next) setFramePickerSlot(null);
                }}
                onUseElement={(el) => {
                  if (framePickerSlot === "start") setStartElement(el);
                  else if (framePickerSlot === "end") setEndElement(el);
                  setFramePickerSlot(null);
                }}
              />
            </section>
          ) : (
            <>
              {/* ---- references ----

            ABOVE the prompt, on purpose: this is the box that decides what a
            @tag can actually resolve to in the editor below it, so it reads
            first, the way a set of ingredients reads before the recipe that
            uses them.

            EMPTY STATE is a single dashed target, not a form — the same
            "one thing, unmistakably a button" lesson the Reference trigger
            below relearned once already (see its own header). FILLED STATE
            is a grid of small tiles so a scene with several references reads
            at a glance, the way the Elements tab's own grid does. */}
              {/* Hidden in the bar while empty: the "Add references" pill in the
                controls row is the way in there, and an empty box would spend
                the bar's one spare line saying nothing. */}
              <section
                className={cn("flex flex-col gap-1.5", bar && boxTags.length === 0 && "hidden")}
              >
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    References{" "}
                    <span className="font-normal tabular-nums normal-case tracking-normal">
                      {boxTags.length}/{maxReferences}
                    </span>
                  </Label>
                  {/* Not in the bar: Generate sits on top of this corner there,
                      and the bar's own "+" / "@" open the same picker. */}
                  {boxTags.length > 0 && !bar ? (
                    <button
                      type="button"
                      onClick={() => setBoxPickerOpen(true)}
                      disabled={readOnly || boxTags.length >= maxReferences}
                      title={
                        boxTags.length >= maxReferences
                          ? `A scene holds at most ${maxReferences} references. Remove one to add another.`
                          : undefined
                      }
                      className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <PlusIcon aria-hidden="true" className="size-3" />
                      Add
                    </button>
                  ) : null}
                </div>
                {boxTags.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setBoxPickerOpen(true)}
                    disabled={readOnly}
                    className={cn(
                      "flex flex-col items-center gap-2 rounded-lg border border-dashed p-4 text-center",
                      "transition-colors hover:border-foreground/40 hover:bg-accent/20",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="grid size-7 place-items-center rounded-full border bg-muted/50">
                        <ImageIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      </span>
                      <span className="grid size-7 place-items-center rounded-full border bg-muted/50">
                        <VideoIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      </span>
                      <span className="grid size-7 place-items-center rounded-full border bg-muted/50">
                        <MusicIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      </span>
                    </span>
                    <span className="text-sm font-medium">Add references</span>
                    <span className="text-xs text-muted-foreground">
                      Image, video or audio from your Elements
                    </span>
                  </button>
                ) : (
                  // CHIPS, NOT TILES, AND AT MOST TWO ROWS OF THEM. The first cut
                  // was a five-column grid of square thumbnails: ten references
                  // stood two rows of 150px tiles between the operator and the
                  // prompt, clipped half the names, and spent a line per tile on
                  // "not in prompt". A 32px chip carries the same three facts
                  // (what it is, its tag, remove) and lets the prompt keep the
                  // room. Past BOX_COLLAPSED_CHIPS the rest fold behind "+N more".
                  <div className="flex flex-wrap gap-1.5">
                    {(boxExpanded ? boxTags : boxTags.slice(0, BOX_COLLAPSED_CHIPS)).map((tag) => {
                      // Resolved against the FULL library here, not boxElements —
                      // a tag whose element has since been deleted or renamed
                      // must still show a chip the operator can remove, not
                      // vanish silently from the box.
                      const element = findElementByTag(elements, tag);
                      const inPrompt = promptTags.includes(tag.toLowerCase());
                      return (
                        <span
                          key={tag}
                          title={
                            inPrompt
                              ? `@${tag}`
                              : `@${tag} is not in the prompt, so it won't be sent`
                          }
                          className={cn(
                            "inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border bg-card pl-1 pr-0.5 text-xs",
                            !inPrompt && "border-dashed opacity-60",
                          )}
                        >
                          {element === undefined ? (
                            <span className="size-6 shrink-0 rounded-sm border bg-muted/50" />
                          ) : element.assetKind === "audio" ? (
                            <span className="grid size-6 shrink-0 place-items-center rounded-sm border bg-muted/50">
                              <MusicIcon
                                aria-hidden="true"
                                className="size-3 text-muted-foreground"
                              />
                            </span>
                          ) : element.assetKind === "video_ref" ? (
                            <span className="grid size-6 shrink-0 place-items-center rounded-sm border bg-muted/50">
                              <VideoIcon
                                aria-hidden="true"
                                className="size-3 text-muted-foreground"
                              />
                            </span>
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={element.previewUrl}
                              alt=""
                              className="size-6 shrink-0 rounded-sm border object-cover"
                            />
                          )}
                          <span className="max-w-[9rem] truncate font-medium">@{tag}</span>
                          {inPrompt ? null : <span className="sr-only">not in prompt</span>}
                          <button
                            type="button"
                            onClick={() => removeTagFromBox(tag)}
                            disabled={readOnly}
                            aria-label={`Remove @${tag}`}
                            className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed"
                          >
                            <XIcon aria-hidden="true" className="size-3" />
                          </button>
                        </span>
                      );
                    })}
                    {boxTags.length > BOX_COLLAPSED_CHIPS ? (
                      <button
                        type="button"
                        onClick={() => setBoxExpanded((v) => !v)}
                        aria-expanded={boxExpanded}
                        className="inline-flex h-8 items-center rounded-md px-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {boxExpanded
                          ? "Show less"
                          : `+${boxTags.length - BOX_COLLAPSED_CHIPS} more`}
                      </button>
                    ) : null}
                  </div>
                )}
                {/* The box's own second instance of the dialog — hidden trigger,
              opened on the Elements tab, controlled by boxPickerOpen. See
              hideTrigger/initialTab/open's own comments on UgcReferencePicker
              for why this is the same component and not a copy. */}
                <UgcReferencePicker
                  projectId={projectId}
                  elements={elements}
                  current={null}
                  onPick={handlePick}
                  hideTrigger
                  initialTab={boxPickerTab}
                  open={boxPickerOpen}
                  onOpenChange={setBoxPickerOpen}
                  onUseElement={(el) => addTagsToBox([el.name])}
                  imagesOnly={option.modelId === "kling-4.0-reference"}
                  boxTags={boxTags}
                  boxLimit={maxReferences}
                />
              </section>
            </>
          )}

          {/* ---- prompt ----

            flex-1: this is the only thing in the column that benefits from
            more room, and everything below it is a fixed-height row. The
            settings and the button stay pinned where the hand expects them
            while the field an editor actually writes in takes whatever is
            left, instead of stopping at 160px above a band of empty page. */}
          {/* No padding on the section itself — the header is a filled bar and
            has to reach the panel's edges, so the inset moves down to the
            editor's own wrapper. */}
          {/* NOT min-h-0: the section is allowed to grow with flex-1, but must
            never shrink below the editor's own min-h-40 floor. min-h-0 here
            let it shrink past that floor while the textarea inside refused
            to, so the box overflowed its own (too-short) border and painted
            over the settings row and Generate button below it. Dropping it
            restores the default "don't shrink below content" floor, which
            chains down through the wrapper and UgcPromptEditor's own
            min-h-0 divs to the textarea's real minimum — so on a short
            window the OUTER column's overflow-y-auto scrolls to reach
            Settings/Generate instead of this section clipping or bleeding. */}
          <section
            className={
              bar
                ? "flex min-w-0 flex-1 flex-col"
                : "flex flex-1 flex-col rounded-lg border bg-card"
            }
          >
            <div
              className={cn(
                "flex items-center justify-between gap-2 rounded-t-[7px] border-b bg-muted/60 px-3 py-1.5",
                bar && "sr-only",
              )}
            >
              <Label
                htmlFor="ugc-prompt"
                className="text-[11px] font-semibold uppercase tracking-wider text-foreground"
              >
                Prompt
              </Label>
            </div>
            {/* Carries the inset the section gave up, and re-declares flex-1
              (no min-h-0 — see the section's own comment above) so the
              editor still takes the whole panel without shrinking past its
              floor. */}
            <div className={bar ? "flex flex-col" : "flex flex-1 flex-col p-3"}>
              <UgcPromptEditor
                id="ugc-prompt"
                // Height and colour only, same rule as the image bar — see
                // UgcPromptEditorProps.textareaClassName.
                controlsDisabled={readOnly}
                textareaClassName={
                  bar
                    ? "h-20 max-h-20 min-h-20 flex-none rounded-xl border-transparent bg-transparent shadow-none focus-visible:border-transparent focus-visible:ring-0"
                    : undefined
                }
                boxClassName={bar ? "pr-32" : undefined}
                name="prompt"
                value={prompt}
                charCount={submittedPromptLength}
                maxChars={option.maxPromptChars}
                onChange={updatePromptDraft}
                // The scene the history belongs to. "new" rather than
                // undefined for the unsaved one, so switching from a saved
                // scene back to the draft still clears — undefined would read
                // as "unchanged" and carry the other scene's steps across.
                historyKey={selectedScene?.id ?? "new"}
                // Start/end frame models have no element tags; Kling Reference takes images.
                elements={
                  isKling
                    ? []
                    : option.modelId === "kling-4.0-reference"
                      ? elements.filter((element) => IMAGE_ASSET_KINDS.has(element.assetKind))
                      : elements
                }
                placeholder={
                  bar
                    ? "Describe the scene you imagine — subject, motion, camera. Type @ for a saved reference."
                    : // A TEMPLATE, not an example prompt.
                      //
                      // This was three finished paragraphs of prose — a woman, a
                      // marble counter, a push-in at 0.2 km/h — in the same
                      // monospace face as real text. It read as a prompt somebody
                      // had already written, and an operator opened a new project,
                      // saw it, and asked why Generate was refusing them. Nothing
                      // was broken: the box was empty and the button said so.
                      //
                      // Length was not the problem; PROSE was. A finished sentence
                      // looks like an answer at a glance whatever its length,
                      // whereas a labelled fragment ending in an ellipsis cannot be
                      // mistaken for one. Same structure taught — Seedance wants
                      // subject and motion first, and this still says so — without
                      // pretending to be filled in.
                      "Scene & Mood: …\n" +
                      "Movement: 0.0s–2.5s …\n" +
                      "Camera: one move, not two …\n" +
                      "Sound Bed: …"
                }
              />
            </div>
          </section>

          {/* KLING'S OWN LINE, replacing the box's outside-the-box warning
            entirely — there is no box to be outside of. This USED to be
            informational only ("Kling doesn't read @tags — they're sent as
            plain words"), because 42d29e3 (worker) made an '@' in a Kling
            prompt survive as a plain word rather than a refused role
            reference. That is no longer good enough: editors do not read
            "@name" as a plain word the way the model does, and a tag naming
            a video element also broke Kling's own pricing (it has no
            video-input rate). So this is now a REFUSAL, in the same
            destructive-red, same-shape line as the reference-limit warning below —
            named, not silent, per the standing "a disabled control must say
            why" rule. */}
          {isKling && promptTags.length > 0 ? (
            <p className="text-xs text-destructive">
              Kling can&rsquo;t use @tags — remove{" "}
              {promptTags
                .slice(0, 3)
                .map((name) => `@${name}`)
                .join(", ")}
              {promptTags.length > 3 ? ` +${promptTags.length - 3} more` : ""} to generate.
            </p>
          ) : null}

          {!isKling && tooManyReferences ? (
            <p className="text-xs text-destructive">
              A scene holds at most {maxReferences} references. Remove a tag or reference to
              generate.
            </p>
          ) : null}

          {/* ---- prompt preview: NOT MOUNTED ----

            The "What actually gets sent" disclosure used to sit here, showing
            what lib/ugc-prompt-preview.ts computes from the box above. Taken
            out of the composer on request — one more collapsible under a box
            an operator retypes for every clip.

            The component (components/ugc-prompt-preview.tsx) and the
            computation (lib/ugc-prompt-preview.ts) are both left in place,
            deliberately. The lib is not only this feature's: its drift guard
            pins DIALOGUE_APPEND_TEMPLATE against the worker's own
            promptForScene (ugc-prompt-preview-drift.test.ts), and deleting it
            would quietly retire a check on the real submit path. Putting the
            disclosure back is this block, restored. */}

          {/* Each setting is directly editable; the length slider only stops on
            durations supported by the selected model. */}
          {/* flex-wrap is the fallback, not the plan. Everything below is sized
            to fit one line in a max-w-md column; if a longer model name or a
            narrower viewport breaks that, wrapping is a better failure than a
            squeezed, unreadable row. */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-2 text-sm",
              // The image bar's pill skin: filled, borderless, same height.
              bar && "gap-2 [&>*]:!border-transparent [&>*]:!bg-muted/60 [&>*]:hover:!bg-muted",
            )}
          >
            {/* Priced live: the button below reads `option`, so changing this
              changes the credits on it before anything is spent.

              EVERY ENTRY HERE HAS A RECEIPT. `options` is built from
              offerable(), which refuses any pair nobody has been billed for,
              so this cannot offer a price that would turn out to be a guess. A
              model in the rate table but not in this list is one still waiting
              to be measured. */}
            {bar && !isKling ? (
              <div className="flex h-9 items-center">
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => {
                    setBoxPickerTab("uploads");
                    setBoxPickerOpen(true);
                  }}
                  aria-label="Upload a reference"
                  title="Upload a reference"
                  className="grid h-full w-9 place-items-center rounded-l-lg text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <PlusIcon aria-hidden="true" className="size-4" />
                </button>
                <span aria-hidden="true" className="h-4 w-px bg-border" />
                <button
                  type="button"
                  disabled={readOnly || boxTags.length >= maxReferences}
                  onClick={() => {
                    setBoxPickerTab("elements");
                    setBoxPickerOpen(true);
                  }}
                  aria-label="Add references"
                  title="Add an element as a reference"
                  className="grid h-full w-9 place-items-center rounded-r-lg text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <AtSign aria-hidden="true" className="size-4" />
                </button>
              </div>
            ) : null}
            {bar ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={readOnly}
                  aria-label={`Model: ${modelLabel}`}
                  className="flex h-9 max-w-[16rem] cursor-pointer items-center gap-2 rounded-lg border px-3 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <Sparkles aria-hidden="true" className="size-4 text-primary" />
                  <span className="truncate">{modelLabel}</span>
                  {modelMenuId(option.modelId) === "kling-4.0" ? (
                    <span className="text-xs text-muted-foreground">
                      {option.modelId === "kling-4.0-reference" ? "References" : "Frames"}
                    </span>
                  ) : null}
                  <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-80 rounded-2xl p-2"
                >
                  <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Sparkles aria-hidden="true" className="size-3.5" />
                    Models
                  </DropdownMenuLabel>
                  {modelMenuOptions.map((o) => (
                    <DropdownMenuItem
                      key={`${o.modelId}/${o.resolution}`}
                      onSelect={() => {
                        if (modelMenuId(o.modelId) !== modelMenuId(option.modelId))
                          setModelIdx(options.indexOf(o));
                      }}
                      className="gap-3 rounded-xl px-2 py-2"
                    >
                      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-sm font-semibold text-foreground">
                        {o.label.charAt(0)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-semibold">
                          {modelMenuId(o.modelId) === "kling-4.0" ? "Kling 4.0" : o.label}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {rateLabel(o.creditsPerSecond)} · {ugcTierLabel(o.modelId, o.resolution)}
                        </span>
                      </span>
                      {modelMenuId(o.modelId) === modelMenuId(option.modelId) ? (
                        <Check aria-hidden="true" className="size-4 text-primary" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <label
              htmlFor="ugc-model"
              className={cn(
                // min-w-0, not a floor. Model was min-w-[9rem], and that floor is
                // what wrapped the row: when the line is a few pixels short
                // something has to give, and the least costly thing to lose is the
                // tail of a model name the operator just picked off a list. It
                // truncates now and the row stays one line.
                "flex h-9 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border bg-card px-2.5",
                // A compact pill on the bar, like the image bar's model pill.
                // On the bar the menu below replaces it; the select stays
                // mounted (hidden) because the form-reset fix reads its ref.
                bar ? "hidden" : "flex-1",
                // The micro-interaction, and it is the same one on all three
                // live controls so they read as a set. Colour on hover, a small
                // give on press. `motion-safe:` on the transform only: a scale
                // is exactly what prefers-reduced-motion exists to suppress,
                // while a border changing colour is not motion at all.
                "transition-[color,background-color,border-color] duration-150",
                "hover:border-foreground/40 hover:bg-accent/40",
                "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                "motion-safe:transition-transform motion-safe:active:scale-[0.98]",
              )}
            >
              <span className="sr-only">Model</span>
              <select
                ref={modelSelectRef}
                id="ugc-model"
                value={optionIdx}
                onChange={(e) => setModelIdx(Number(e.target.value))}
                className={cn(
                  "w-full min-w-0 cursor-pointer truncate bg-transparent font-medium text-foreground outline-none",
                  // Sized to the chosen model's name rather than the row.
                  bar && "w-auto [field-sizing:content]",
                )}
              >
                {options.map((o, i) =>
                  modelMenuId(o.modelId) === "kling-4.0" &&
                  o.modelId !== selectedKling4Id ? null : (
                    <option
                      key={`${o.modelId}/${o.resolution}`}
                      value={i}
                      className="bg-popover text-popover-foreground"
                    >
                      {modelMenuId(o.modelId) === "kling-4.0" ? "Kling 4.0" : o.label} ·{" "}
                      {ugcTierLabel(o.modelId, o.resolution)}
                    </option>
                  ),
                )}
              </select>
            </label>

            {modelMenuId(option.modelId) === "kling-4.0" ? (
              <div
                role="group"
                aria-label="Kling 4.0 mode"
                className="flex h-9 items-center gap-0.5 rounded-lg bg-muted/60 p-1"
              >
                {kling4Modes.map((mode) => (
                  <button
                    key={mode.modelId}
                    type="button"
                    disabled={readOnly}
                    aria-pressed={mode.modelId === option.modelId}
                    onClick={() => {
                      const tier =
                        options.find(
                          (candidate) =>
                            candidate.modelId === mode.modelId &&
                            candidate.resolution === option.resolution,
                        ) ?? mode;
                      setModelIdx(options.indexOf(tier));
                    }}
                    className={cn(
                      "h-full rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                      mode.modelId === option.modelId
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {mode.modelId === "kling-4.0-reference" ? "References" : "Start/end frames"}
                  </button>
                ))}
              </div>
            ) : null}

            {/* A TRIGGER, so it is a button and nothing else. It used to be a
              labelled cell holding a bordered circle beside a word, where the
              circle was outside the button and did nothing when pressed.

              NOT RENDERED IN KLING MODE. Its whole job is putting a picture
              into the References box above, and Kling has no box — the two
              Frame slots are the only way in for that model, and a second
              "Add references" control beside them would say there is a
              second box to add to when there is not. */}
            {!isKling && !bar ? (
              <UgcReferencePicker
                projectId={projectId}
                elements={elements}
                // null on purpose: the control stays "Add references" whatever is
                // attached. The reference itself still reaches the action through
                // the hidden elementId/file fields above — this only decides what
                // it SAYS, and it should always say there is room for another.
                current={null}
                onPick={handlePick}
                allowVideoPrimary={option.modelId === "gemini-omni-video"}
                // AN UPLOAD NEVER JOINS THE BOX. It is saved to the library and
                // (first picture) becomes the conditioning frame via onPick, as
                // always; "Use element" and prompt @tags put saved elements in the box. Darwin's
                // call, 2026-09-12: three fresh uploads landing in the box
                // unasked read as the box filling itself.
                onUseElement={(el) => addTagsToBox([el.name])}
                imagesOnly={option.modelId === "kling-4.0-reference"}
                boxTags={boxTags}
                boxLimit={maxReferences}
              />
            ) : null}

            {/* KLING'S SOUND ON/OFF, default On. Hidden rather than disabled
              when AUDIO_ENABLED is off globally: a control that cannot ever
              be turned on is not a choice, and this route's other gates
              (Model, Length) simply omit themselves rather than showing a
              permanently-greyed twin — same rule, applied here. */}
            {isKling && audioEnabled ? (
              <button
                type="button"
                onClick={() => setKlingSoundOn((v) => !v)}
                disabled={readOnly}
                aria-pressed={klingSoundOn}
                className={cn(
                  "flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border bg-card px-2.5",
                  "font-medium text-foreground",
                  "transition-[color,background-color,border-color] duration-150",
                  "hover:border-foreground/40 hover:bg-accent/40",
                  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                <MusicIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                Sound {klingSoundOn ? "On" : "Off"}
              </button>
            ) : isKling ? (
              <span
                aria-disabled="true"
                title="Audio is off for every render right now (AUDIO_ENABLED), so Kling renders silent."
                className="flex h-9 shrink-0 cursor-default items-center gap-1.5 rounded-lg border border-dashed bg-muted/40 px-2.5 text-xs text-muted-foreground"
              >
                <MusicIcon aria-hidden="true" className="size-3.5" />
                Sound off
              </span>
            ) : null}

            <div ref={lengthRef} className="relative shrink-0">
              <button
                type="button"
                disabled={readOnly}
                aria-label={`Length: ${activeDuration} seconds`}
                aria-expanded={lengthOpen}
                onClick={() => setLengthOpen((open) => !open)}
                className="flex h-9 items-center gap-1.5 rounded-lg border bg-card px-2.5 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <ClockIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                {activeDuration}s
              </button>
              {lengthOpen ? (
                <LengthSlider
                  durations={durations}
                  value={activeDuration}
                  disabled={readOnly}
                  onChange={setDurationS}
                  onDone={() => setLengthOpen(false)}
                />
              ) : null}
            </div>

            {aspectRatios.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={readOnly}
                  aria-label={`Aspect ratio: ${activeAspectRatio ?? "9:16"}`}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <AspectRatioIcon ratio={activeAspectRatio ?? "9:16"} />
                  {activeAspectRatio ?? "9:16"}
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-44 rounded-2xl p-2"
                >
                  <DropdownMenuLabel>Aspect ratio</DropdownMenuLabel>
                  {aspectRatios.map((ratio) => (
                    <DropdownMenuItem
                      key={ratio}
                      onSelect={() => setAspectRatio(ratio)}
                      className="gap-2 rounded-lg"
                    >
                      <AspectRatioIcon ratio={ratio} />
                      <span className="flex-1">{ratio}</span>
                      {ratio === (activeAspectRatio ?? "9:16") ? (
                        <Check aria-hidden="true" className="size-4 text-primary" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span
                aria-disabled="true"
                className="flex h-9 shrink-0 cursor-default items-center gap-1.5 rounded-lg border border-dashed bg-muted/40 px-2.5 text-xs text-muted-foreground"
              >
                <RectangleVerticalIcon aria-hidden="true" className="size-3.5" />
                <span className="sr-only">Aspect ratio</span>
                9:16
              </span>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={readOnly}
                aria-label={`Resolution: ${ugcTierLabel(option.modelId, option.resolution)}`}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <GaugeIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                {ugcTierLabel(option.modelId, option.resolution)}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-48 rounded-2xl p-2"
              >
                <DropdownMenuLabel>Resolution</DropdownMenuLabel>
                {resolutions.map((resolution) => {
                  const tier = tierOptions.find((o) => o.resolution === resolution);
                  const rate = tier?.nativeAudio
                    ? effectiveSoundOn
                      ? tier.soundCreditsPerSecond
                      : tier.silentCreditsPerSecond
                    : tier?.creditsPerSecond;
                  return (
                    <DropdownMenuItem
                      key={resolution}
                      disabled={!tier}
                      onSelect={() => tier && setModelIdx(options.indexOf(tier))}
                      className="gap-2 rounded-lg"
                    >
                      <span className="flex-1">{ugcTierLabel(option.modelId, resolution)}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {tier
                          ? rate == null
                            ? "Price unavailable"
                            : rateLabel(rate)
                          : "Price unverified"}
                      </span>
                      {resolution === option.resolution ? (
                        <Check aria-hidden="true" className="size-4 text-primary" />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Our own re-encode bitrate (lib/video-quality.ts), every model. No price change. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={readOnly}
                aria-label={`Quality: ${VIDEO_QUALITY_LABELS[quality].label}`}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <Sparkles aria-hidden="true" className="size-3.5 text-muted-foreground" />
                {VIDEO_QUALITY_LABELS[quality].label}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-56 rounded-2xl p-2"
              >
                <DropdownMenuLabel>Quality</DropdownMenuLabel>
                {VIDEO_QUALITIES.map((q) => (
                  <DropdownMenuItem
                    key={q}
                    onSelect={() => setQuality(q)}
                    className="gap-2 rounded-lg"
                  >
                    <span className="flex-1">{VIDEO_QUALITY_LABELS[q].label}</span>
                    <span className="text-xs text-muted-foreground">
                      {VIDEO_QUALITY_LABELS[q].hint}
                    </span>
                    {q === quality ? (
                      <Check aria-hidden="true" className="size-4 text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {bar && option.modelId === "gemini-omni-video" ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={readOnly}
                  aria-label={`Voice: ${geminiVoice || "Auto"}`}
                  className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 font-medium text-foreground capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <MusicIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  {geminiVoice || "Auto voice"}
                  <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="max-h-80 w-64 overflow-y-auto rounded-2xl p-2"
                >
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Voice
                  </DropdownMenuLabel>
                  {([["", "Gemini picks"], ...GEMINI_VOICES] as const).map(([name, style]) => (
                    <DropdownMenuItem
                      key={name || "auto"}
                      onSelect={() => setGeminiVoice(name)}
                      className="gap-2 rounded-lg"
                    >
                      <span className="flex-1 capitalize">
                        {name || "Auto"}{" "}
                        <span className="text-xs normal-case text-muted-foreground">{style}</span>
                      </span>
                      {name === geminiVoice ? (
                        <Check aria-hidden="true" className="size-4 text-primary" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {bar && credits !== null ? (
              // ml-auto pushes it to the far end; the pill skin above is
              // cancelled so it reads as text, like the image bar's cost.
              <p className="ml-auto whitespace-nowrap !border-0 !bg-transparent pr-1 text-xs text-muted-foreground">
                ${usd?.toFixed(2)} per {activeDuration}s clip
              </p>
            ) : null}
          </div>

          {/* Says so when the pin could not be honoured, rather than silently
            rendering a different model under a row that looks deliberate. */}
          {!pinHonoured ? (
            <p className="text-xs text-muted-foreground">
              {PINNED_MODEL_ID} at {PINNED_RESOLUTION} is not offerable right now, so this is
              rendering on {option.label} at {ugcTierLabel(option.modelId, option.resolution)}{" "}
              instead.
            </p>
          ) : null}
          {option.modelId === "gemini-omni-video" ? (
            <>
              <label
                className={cn(
                  "flex items-center gap-2 text-xs text-muted-foreground",
                  bar && "hidden",
                )}
              >
                Voice
                <select
                  value={geminiVoice}
                  onChange={(e) => setGeminiVoice(e.target.value)}
                  className="min-w-0 flex-1 cursor-pointer rounded-md border bg-transparent px-2 py-1 text-foreground"
                >
                  <option value="" className="bg-popover text-popover-foreground">
                    Auto (Gemini picks)
                  </option>
                  {GEMINI_VOICES.map(([name, style]) => (
                    <option key={name} value={name} className="bg-popover text-popover-foreground">
                      {name.charAt(0).toUpperCase() + name.slice(1)} ({style})
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                Gemini Omni Video generates its own audio; it cannot use your audio references.
              </p>
            </>
          ) : null}
        </div>

        <div className={bar ? "absolute right-3 top-3 flex flex-col items-end gap-1" : "contents"}>
          {/* ---- generate ---- */}
          {/* Two buttons, because the two writes are not the same commitment.
            A new scene submits the form directly. A regenerate opens the
            confirm first, because one of ITS choices — "update this version"
            — deletes the clip currently standing, and because the caps have
            to be able to refuse before anything is queued rather than after.

            The dialog is the wizard's own, not a copy: the cost, the vendor
            balance, the cap refusal and the new-vs-update choice are one
            question, and asking it twice in two places is how two sets of
            numbers drift apart. */}
          {selectedScene ? (
            <>
              <SceneRerenderDialog
                sceneId={selectedScene.id}
                sceneLabel={`Scene ${selectedScene.idx}`}
                // THE CLIP-ONLY NUMBER, deliberately, and it is the honest one
                // here: regenerateClip re-renders the SCENE, whose references
                // live in scene_references and are not the prompt's tags this
                // column can see. Pricing it off the tags would be a different
                // render's bill. The page's retry control, which does have the
                // scene's own references, prices those.
                costUsd={regenerateUsd}
                notice={unknownTagsNotice}
                unpaidRate={option.unpaid}
                rateSource={rateSource}
                vendor={vendor}
                budget={budget}
                trigger={
                  <Button
                    type="button"
                    className={cn(
                      "w-full motion-safe:transition-transform motion-safe:active:scale-[0.99]",
                      bar &&
                        "h-9 min-h-0 w-auto whitespace-nowrap rounded-lg bg-primary px-4 text-xs font-bold uppercase text-primary-foreground hover:bg-primary/90",
                    )}
                    disabled={
                      !prompt.trim() ||
                      readOnly ||
                      geminiSourceVideoUnavailable ||
                      geminiAudioReference ||
                      (!isKling && tooManyReferences) ||
                      // Kling can't use @tags at all (see the red line above) —
                      // regenerateClip refuses this server-side too, but the
                      // button says so before a press ever reaches it.
                      (isKling && promptTags.length > 0) ||
                      // Nor a webp Start/End frame — same reasoning, same
                      // server-side backstop, see klingBadFrames above.
                      (isKling && klingBadFrames.length > 0)
                    }
                  >
                    {geminiSourceVideoUnavailable
                      ? "Gemini source-video regeneration unavailable"
                      : `Regenerate scene ${selectedScene.idx} · $${regenerateUsd.toFixed(2)}`}
                  </Button>
                }
                // Not rerenderScene directly: the prompt in the field may have
                // been edited since the scene was saved, and regenerateClip
                // writes it first so nobody pays for the words that WERE there.
                confirmAction={async (versionMode) => {
                  const formData = new FormData();
                  formData.set("sceneId", selectedScene.id);
                  formData.set("prompt", prompt);
                  formData.set("versionMode", versionMode);
                  // The pickers reach the render through here. Without these three
                  // the column showed a model and a length that Regenerate then
                  // ignored, quoting a price for a clip it was not about to make.
                  if (option) {
                    formData.set("modelId", option.modelId);
                    formData.set("resolution", option.resolution);
                  }
                  formData.set("durationS", String(activeDuration));
                  if (option?.modelId === "gemini-omni-video" && geminiVoice) {
                    formData.set("geminiVoice", geminiVoice);
                  }
                  if (activeAspectRatio) formData.set("aspectRatio", activeAspectRatio);
                  formData.set("quality", quality);
                  if (isKling) {
                    // KLING'S OWN PAIR, not the box's marker/tags — see the
                    // hidden-fields block above this form's effectiveReference
                    // input for the same branch on the direct-submit path.
                    if (startElement) formData.set("startElementId", startElement.id);
                    if (endElement) formData.set("endElementId", endElement.id);
                    formData.set("sound", effectiveSoundOn ? "1" : "0");
                  } else {
                    // Same marker/box pair the direct-submit form carries for
                    // Generate — see the hidden fields above this form's
                    // effectiveReference input for why the marker is unconditional
                    // and what its absence means to actions/ugc.ts.
                    formData.set("referencesBox", "1");
                    for (const tag of boxTags) formData.append("referenceTag", tag);
                  }
                  return regenerateClip(formData);
                }}
              />
              {geminiSourceVideoUnavailable ? (
                <p
                  className={cn(
                    "text-center text-xs text-muted-foreground",
                    // Capped to the room the bar's prompt box reserves (pr-32),
                    // or the hint spreads left over the text being typed.
                    bar && "w-28 text-right text-[10px] leading-snug",
                  )}
                >
                  A paid Gemini video-input receipt is required for this resolution before this
                  scene can be regenerated with its saved source video.
                </p>
              ) : geminiAudioReference ? (
                <p
                  className={cn(
                    "text-center text-xs text-muted-foreground",
                    // Capped to the room the bar's prompt box reserves (pr-32),
                    // or the hint spreads left over the text being typed.
                    bar && "w-28 text-right text-[10px] leading-snug",
                  )}
                >
                  {option.label} can&apos;t use audio references. Remove the audio reference, or
                  switch to Seedance to use your audio.
                </p>
              ) : null}
            </>
          ) : (
            <>
              {/* CONFIRMED, not one-click. Generate was the last control on
                this route that spent on a single press: it submitted the
                form directly, so a mis-aimed click bought a clip at
                whatever the pickers happened to say.

                It is the wizard’s own dialog, same as Regenerate above, so
                the two presses in this column cannot quote different
                numbers or enforce different caps.

                requestSubmit() on the form this column already is, rather
                than rebuilding the FormData by hand: the reference file
                input, the hidden model/resolution/duration fields, the
                notice toast and the post-success clearing in submit() all
                keep working exactly as they did, and the only thing that
                changed is what has to happen before the submit. The form is
                reached through the file input’s own .form — it is mounted
                unconditionally inside this <form>, so no second ref is
                needed to find it. */}
              <SceneRerenderDialog
                kind="generate"
                sceneLabel="this clip"
                // Non-null here: the trigger below is disabled whenever the
                // price is unknown, so the dialog cannot be opened without one.
                costUsd={usd ?? 0}
                settingsLabel={settingsLabel}
                notice={unknownTagsNotice}
                unpaidRate={option.unpaid}
                rateSource={rateSource}
                vendor={vendor}
                budget={budget}
                trigger={
                  <Button
                    type="button"
                    className={cn(
                      "w-full motion-safe:transition-transform motion-safe:active:scale-[0.99]",
                      bar &&
                        "h-auto min-h-12 w-auto shrink-0 flex-col gap-0.5 whitespace-nowrap rounded-lg bg-primary px-4 py-1 text-xs font-bold uppercase leading-tight text-primary-foreground hover:bg-primary/90",
                    )}
                    disabled={
                      !prompt.trim() ||
                      readOnly ||
                      promptOverBy > 0 ||
                      (isKling
                        ? missingRequiredReference ||
                          promptTags.length > 0 ||
                          klingBadFrames.length > 0
                        : missingRequiredReference ||
                          videoPriceUnknown ||
                          geminiAudioReference ||
                          tooManyReferences)
                    }
                  >
                    {credits === null ? (
                      "Generate"
                    ) : bar ? (
                      <>
                        <span>Generate</span>
                        <span className="text-[10px] font-semibold normal-case opacity-90">
                          ${usd?.toFixed(2)}
                        </span>
                      </>
                    ) : (
                      `Generate · $${usd?.toFixed(2)}`
                    )}
                  </Button>
                }
                confirmAction={async () => {
                  // Reads the settings AT CONFIRM TIME, from the same hidden
                  // fields the button was priced from. The dialog is modal, so
                  // nothing in the column can move between the quote and this
                  // line; changing the model or the length afterwards means
                  // pressing Generate again, and being asked again.
                  if (ensureProject) {
                    const created = await ensureProject();
                    if ("error" in created) return { error: created.error };
                    // Committed before the submit reads the hidden field.
                    flushSync(() => setTargetProjectId(created.projectId));
                  }
                  fileRef.current?.form?.requestSubmit();
                }}
              />

              {/* Why the button is off, named.
                A greyed control with no explanation makes the operator guess
                which of two things is missing, and the guess is silent — there
                is nothing on screen that distinguishes "no prompt" from "no
                reference". Both are one line away from being said out loud, so
                they are. The prompt is checked first because it is the field
                directly above; a missing reference is further from the eye. */}
              {(!bar &&
                ((isKling && (!prompt.trim() || missingRequiredReference || promptOverBy > 0)) ||
                  (!isKling &&
                    (!prompt.trim() ||
                      missingRequiredReference ||
                      videoPriceUnknown ||
                      geminiAudioReference ||
                      promptOverBy > 0)))) ||
              (bar &&
                !!prompt.trim() &&
                ((isKling && (missingRequiredReference || promptOverBy > 0)) ||
                  (!isKling &&
                    (missingRequiredReference ||
                      videoPriceUnknown ||
                      geminiAudioReference ||
                      promptOverBy > 0)))) ? (
                <p
                  className={cn(
                    "text-center text-xs text-muted-foreground",
                    // Capped to the room the bar's prompt box reserves (pr-32),
                    // or the hint spreads left over the text being typed.
                    bar && "w-28 text-right text-[10px] leading-snug",
                  )}
                >
                  {!prompt.trim()
                    ? "Write a prompt to generate."
                    : promptOverBy > 0
                      ? isKling
                        ? // KLING NEVER SUBSTITUTES, so the typed prompt IS the
                          // submitted one — no "every @tag is replaced" caveat,
                          // which would be false for this model and would send
                          // the operator looking for a tag to remove that has
                          // nothing to do with the overrun.
                          `This prompt reaches ${option.label} ${promptOverBy.toLocaleString()} characters over its ${option.maxPromptChars?.toLocaleString()} limit. Shorten it to generate.`
                        : /* THE THIRD SENTENCE EXISTS SO A VIDEO TAG IS NOT A SILENT
                           NO. Once a prompt can tag a voice or a video, "attach a
                           reference image" is true and useless: the operator HAS
                           attached a reference, sees its card in the panel, and is
                           being told to attach one. Naming which kind is missing
                           is the difference between a hint and a riddle. */
                          `This prompt reaches ${option.label} ${promptOverBy.toLocaleString()} characters over its ${option.maxPromptChars?.toLocaleString()} limit. Every @tag is replaced by its full description before it is sent, so shortening the prompt or removing a tag both help.`
                      : isKling
                        ? "Pick a start frame to generate."
                        : geminiAudioReference
                          ? `${option.label} can't use audio references. Remove the @audio tag, or switch to Seedance to use your audio.`
                          : modelTakesNoVideo
                            ? `${option.label} cannot take a video reference — no render carrying one has ever been billed at this tier. Remove the tag, or switch to a model that can.`
                            : videoLengthUnmeasured
                              ? "That video's length was never measured, so this render cannot be priced. Re-upload it, or remove the tag."
                              : hasNonImageTagOnly
                                ? "A voice tag can’t carry a clip on its own. Tag a picture or a video too — the voice still reaches the render."
                                : "Attach a reference image to generate — the prompt’s @tag points at it."}
                </p>
              ) : !bar && promptOnlyAllowed ? (
                <p className="text-center text-xs text-muted-foreground">
                  References are optional. Leave them empty to generate from your prompt.
                </p>
              ) : null}
            </>
          )}

          {option.fixedVideoCredits !== undefined &&
          option.fixedVideoCredits !== null &&
          taggedVideoDurationsS.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Gemini source-video renders cost a fixed $
              {(option.fixedVideoCredits / 200).toFixed(2)}; Kie ignores the selected output
              duration when a source video is attached.
            </p>
          ) : null}
        </div>
      </PendingFieldset>
    </ActionForm>
  );
}

/**
 * True when this element cannot be a Kling Start/End frame because of its
 * own file extension — see KLING_FRAME_EXTS' doc comment (lib/elements.ts)
 * for the kie 422 this exists to catch before a submit ever reaches it.
 *
 * null and "unknown" (imageExt absent or empty) both read as fine here,
 * deliberately: this is the client's courtesy warning, not the enforcement
 * — actions/ugc.ts refuses the real webp regardless of what this says.
 */
function isBadKlingFrameExt(element: ElementTag | null): boolean {
  if (!element || !element.imageExt) return false;
  return !KLING_FRAME_EXTS.has(element.imageExt.toLowerCase());
}

/**
 * One Kling frame slot — Start (required) or End (optional).
 *
 * SAME TILE SHAPE THE REFERENCES BOX ALREADY USES, deliberately: a dashed
 * target when empty, a small thumbnail with the element's @name and a
 * remove button once one is picked. Kling mode does not reuse the box
 * itself (it names exactly two positions, not an open-ended allowlist), but
 * there is no reason its one tile should look like a different control.
 *
 * Clicking the FILLED tile reopens the picker to change it — the box's own
 * tiles have no such affordance (removing and re-adding is the only way to
 * change one there), but a slot only ever holds one thing, so "click it to
 * replace it" is the obvious gesture and costs nothing else on screen.
 */
function KlingFrameSlot({
  label,
  required,
  element,
  disabled,
  onOpen,
  onRemove,
  badExt = false,
  compact = false,
}: {
  /** The bar's chip: a small thumbnail and the slot's name, not a square tile. */
  compact?: boolean;
  label: string;
  required: boolean;
  element: ElementTag | null;
  disabled: boolean;
  onOpen: () => void;
  onRemove: () => void;
  /** See isBadKlingFrameExt's own comment. Rings the filled tile red; the reason is under the grid. */
  badExt?: boolean;
}): JSX.Element {
  if (compact) {
    return (
      <span
        className={cn(
          "inline-flex h-11 items-center gap-2 rounded-lg border bg-muted/40 pl-1.5 pr-1 text-sm",
          !element && "border-dashed",
          badExt && "border-destructive",
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          disabled={disabled}
          title={element ? `@${element.name}` : undefined}
          className="flex items-center gap-2 pr-1 font-medium disabled:cursor-not-allowed"
        >
          {element ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={element.previewUrl}
              alt=""
              className="size-8 shrink-0 rounded-md border object-cover"
            />
          ) : (
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-dashed">
              <PlusIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            </span>
          )}
          <span className={element ? "text-foreground" : "text-muted-foreground"}>{label}</span>
        </button>
        {element ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove ${label.toLowerCase()}`}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon aria-hidden="true" className="size-3" />
          </button>
        ) : null}
      </span>
    );
  }
  if (!element) {
    return (
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className={cn(
          "flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-3 text-center",
          "aspect-square",
          "transition-colors hover:border-foreground/40 hover:bg-accent/20",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <span className="grid size-7 place-items-center rounded-full border bg-muted/50">
          <ImageIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </span>
        <span className="text-xs font-medium">
          {label}
          {required ? null : <span className="ml-1 text-muted-foreground">Optional</span>}
        </span>
      </button>
    );
  }
  return (
    <div
      className={cn(
        "relative flex flex-col items-center gap-1 rounded-md border p-1.5",
        badExt && "border-destructive",
      )}
    >
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${label.toLowerCase()}`}
        // Inside the slot, not hanging off its corner: the End frame slot
        // sits flush with the column's right edge, and a button poking past
        // it gave the scrolling column a horizontal scrollbar.
        className="absolute right-2.5 top-2.5 z-10 grid size-5 place-items-center rounded-full border bg-background/90 text-muted-foreground hover:text-foreground"
      >
        <XIcon aria-hidden="true" className="size-2.5" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="flex w-full flex-col items-center gap-1 disabled:cursor-not-allowed"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={element.previewUrl}
          alt=""
          className="aspect-square w-full rounded-sm border object-cover"
        />
        <span className="w-full truncate text-center text-[10px] font-medium">@{element.name}</span>
      </button>
    </div>
  );
}

/**
 * The Length popover: "Total duration", the value, and a filled track over a
 * transparent native range input (which keeps keyboard and screen-reader
 * support). Releasing the slider, or Enter, counts as done and closes it.
 * Positions are by index, matching the input, so uneven lists (Kling 6/10) line up.
 */
function LengthSlider({
  durations,
  value,
  disabled,
  onChange,
  onDone,
}: {
  durations: readonly number[];
  value: number;
  disabled: boolean;
  onChange: (seconds: number) => void;
  onDone: () => void;
}): JSX.Element {
  const last = durations.length - 1;
  const at = (i: number): number => (last > 0 ? (i / last) * 100 : 100);
  const pct = at(Math.max(0, durations.indexOf(value)));
  const labels = [...new Set([0, Math.round(last / 2), last])];
  // Inset so a handle or dot at either end stays visible inside the rounded track.
  const inset = (p: number): string => `clamp(6px, ${p}%, calc(100% - 8px))`;

  return (
    <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-2xl border bg-popover p-4 shadow-lg shadow-black/10">
      <p className="text-sm text-muted-foreground">Total duration</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}s</p>
      <div className="relative mt-3 h-10 overflow-hidden rounded-lg bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-foreground/15"
          style={{ width: `${pct}%` }}
        />
        {labels
          .slice(1)
          .map((i) =>
            at(i) > pct ? (
              <span
                key={i}
                aria-hidden="true"
                className="absolute top-1/2 size-1 -translate-y-1/2 rounded-full bg-muted-foreground/60"
                style={{ left: inset(at(i)) }}
              />
            ) : null,
          )}
        <span
          aria-hidden="true"
          className="absolute top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
          style={{ left: inset(pct) }}
        />
        <input
          type="range"
          aria-label="Length in seconds"
          aria-valuetext={`${value} seconds`}
          min={0}
          max={last}
          value={Math.max(0, durations.indexOf(value))}
          onChange={(e) => onChange(durations[Number(e.target.value)] ?? value)}
          onPointerUp={onDone}
          onKeyDown={(e) => {
            if (e.key === "Enter") onDone();
          }}
          disabled={disabled || last === 0}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </div>
      <div
        aria-hidden="true"
        className="relative mt-2 h-4 text-xs tabular-nums text-muted-foreground"
      >
        {labels.map((i) => (
          <span
            key={i}
            className={cn(
              "absolute",
              i === 0 ? "left-0" : i === last ? "right-0" : "-translate-x-1/2",
            )}
            style={i !== 0 && i !== last ? { left: `${at(i)}%` } : undefined}
          >
            {durations[i]}
          </span>
        ))}
      </div>
    </div>
  );
}

function AspectRatioIcon({ ratio, className = "size-3.5" }: { ratio: string; className?: string }) {
  const Icon =
    ratio === "16:9"
      ? RectangleHorizontalIcon
      : ratio === "1:1"
        ? SquareIcon
        : RectangleVerticalIcon;
  return <Icon aria-hidden="true" className={cn(className, "text-muted-foreground")} />;
}
