"use client";
import { formatUsdRate } from "@/lib/format-usd";

import { useEffect, useState, useTransition } from "react";
import type { DragEvent, FormEvent, JSX } from "react";
import { useRouter } from "next/navigation";
import type { GenerateProjectImageResult, ImageAttempt } from "@/actions/image-generator";
import { PendingButton } from "@/components/pending-button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { UgcPromptEditor } from "@/components/ugc-prompt-editor";
import { MAX_PROMPT_CHARS } from "@/lib/prompt-limits";
import { UgcReferencePicker } from "@/components/ugc-reference-picker";
import type { PickedReference } from "@/components/ugc-reference-picker";
import { findElementByTag, type ElementTag } from "@/lib/elements";
import { tagsInOrder } from "@/lib/element-tags";
import { unknownPromptTags, unknownTagsWarning } from "@/lib/unknown-tags";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import { imageCostUsd, type ImageModelDescriptor } from "@/lib/models";
import type { ImageResolutionId } from "@/lib/image-resolutions";
import type { ImageAspectRatio } from "@/lib/image-aspect-ratios";
import { parseImageDraft, serializeImageDraft } from "@/lib/image-draft";
import { isImageAttemptUnfinished } from "@/lib/image-attempt";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AtSign, Check, ChevronRight, Gem, Plus, Sparkles, XIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { removeTagFromPrompt } from "@/lib/rename-tag";
import { MAX_REFERENCES } from "@/lib/ugc-references";
import { ResizablePromptBar } from "@/components/resizable-prompt-bar";
import {
  GENERATED_IMAGE_DRAG_TYPE,
  IMAGE_REUSE_EVENT,
  dragReferenceName,
  type ImageReuseDetail,
} from "@/lib/image-reuse";
import { saveGeneratedElement } from "@/actions/save-generated-element";

/** A control on the prompt bar: model, ratio. Radix menus keep the keyboard behaviour. */
const PILL =
  "inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-muted/60 px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

/** An outline box in the shape of the ratio, longest side 14px. */
function RatioIcon({ ratio }: { ratio: ImageAspectRatio }): JSX.Element {
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  const scale = 14 / Math.max(w, h);
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-[3px] border-[1.5px] border-current"
      style={{ width: Math.max(w * scale, 6), height: Math.max(h * scale, 6) }}
    />
  );
}

export interface ImageGeneratorFormProps {
  action: (formData: FormData) => Promise<GenerateProjectImageResult>;
  /**
   * Selectable models, each priced from a measured call (lib/models.ts's
   * IMAGE_MODELS). The list is the page's, not this component's, so the price
   * shown here and the price the reservation holds come from one source.
   */
  models: readonly ImageModelDescriptor[];
  disabledReason: string | null;
  /**
   * Scopes the picker's uploads, exactly as it does on /ugc — or null on the
   * personal /image-generator (0085_personal_image_generator.sql), which has
   * no project to scope them to.
   *
   * Null HIDES the picker rather than passing an empty string down into it:
   * registerElement/updateElement/deleteElement all guard with requireProject
   * and refuse without one, so an offered control could only fail. Everything
   * the picker is not needed for still works there — @tags autocomplete from
   * `elements` below and resolve server-side.
   */
  projectId: string | null;
  /**
   * The operator's own saved references, resolved server-side.
   *
   * Empty is a normal first-run state. Where the picker is shown, it is how
   * that state ends: a reference uploaded there is registered as an element
   * immediately, which is what makes it taggable in the box above it.
   */
  elements: readonly ElementTag[];
  /**
   * Finishes a handed-off attempt (`{ pendingRunId }`) with one short read of
   * kie per call — reconcilePersonalImageAttempt on /image-generator. Absent on
   * /images/[id], whose action still waits on kie itself.
   */
  waitAction?: (runId: string) => Promise<ImageAttempt>;
}

/** How often a handed-off attempt is checked while the form waits on it. */
const HANDOFF_POLL_MS = 3000;
/**
 * Stop waiting here after this long; the attempt keeps running and the Runs
 * panel finishes it. Well past the slowest measured kie path (~149s).
 */
const HANDOFF_WAIT_LIMIT_MS = 6 * 60_000;

type SettledResult = Exclude<GenerateProjectImageResult, { pendingRunId: string }>;

export function ImageGeneratorForm({
  action,
  models,
  disabledReason: unavailableReason,
  projectId,
  elements,
  waitAction,
}: ImageGeneratorFormProps): JSX.Element {
  const router = useRouter();

  /**
   * Generate, and if the server handed the attempt off, wait for it HERE.
   *
   * The server returns as soon as kie has the job, so no Server Action is held
   * open while the image draws — Next.js runs a page's actions one at a time,
   * and a held generate made Save to Elements wait up to 100s behind it. Each
   * check below is one short reconcile call, so other actions get through.
   *
   * Once the attempt completes, the SAME formData (same idempotency key) is
   * submitted again: the server's duplicate branch hands back the stored image
   * at full size and charges nothing (0088).
   */
  async function generate(formData: FormData): Promise<SettledResult> {
    const first = await action(formData);
    if (first.pendingRunId === undefined) return first;
    startRefresh(() => router.refresh());
    if (!waitAction) {
      return {
        error: "The image is still generating. It will appear under Runs when it finishes.",
      };
    }

    // generate() runs from the submit handler, never during render; the
    // compiler's purity check cannot see that once it analyses this component.
    // eslint-disable-next-line react-hooks/purity
    const deadline = Date.now() + HANDOFF_WAIT_LIMIT_MS;
    // eslint-disable-next-line react-hooks/purity
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
      let attempt: ImageAttempt;
      try {
        attempt = await waitAction(first.pendingRunId);
      } catch {
        continue; // A failed read is not a failed attempt; ask again.
      }
      if (isImageAttemptUnfinished(attempt.status)) continue;
      if (attempt.status === "completed") {
        const done = await action(formData);
        return done.pendingRunId === undefined
          ? done
          : { error: "The image finished but could not be loaded yet. It is under Runs." };
      }
      // failed / billing_unknown: settled without an image, so the key is spent.
      return {
        error: attempt.reason ?? "The image could not be generated.",
        keyExhausted: true,
      };
    }
    return {
      error: "Still generating after several minutes. It will appear under Runs when it finishes.",
    };
  }

  const [refreshPending, startRefresh] = useTransition();
  // Images in flight from THIS page lock Generate until they are drawn AND the
  // refresh has put them on screen: no duplicate paid batch from a second press.
  const [inFlight, setInFlight] = useState(0);
  const pending = refreshPending;
  const generateLocked = pending || inFlight > 0;
  const disabledReason = unavailableReason;
  const [prompt, setPrompt] = useState("");
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [referencePickerTab, setReferencePickerTab] = useState<"uploads" | "elements">("elements");
  const taggedPictures = tagsInOrder(prompt)
    .map((tag) => findElementByTag(elements, tag))
    .filter(
      (element): element is ElementTag => !!element && IMAGE_ASSET_KINDS.has(element.assetKind),
    );
  // A tag that names no usable saved picture goes through as plain text, so the
  // confirm dialog says so before the image is paid for. The prompt being asked
  // about is the one in the box — beats of a sequence were planned from it.
  const unknownTagsNotice = unknownTagsWarning(
    unknownPromptTags(prompt, elements, { imagesOnly: true }),
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const [imageCount, setImageCount] = useState(1);
  const [modelId, setModelId] = useState(models[0]!.id);
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("9:16");
  const selectedModel = models.find((m) => m.id === modelId) ?? models[0]!;
  // Leave room for lib/kie.ts's required no-text instruction within the vendor cap.
  const promptLimit = Math.min(
    MAX_PROMPT_CHARS,
    selectedModel.maxPromptChars === undefined
      ? MAX_PROMPT_CHARS
      : selectedModel.maxPromptChars - 100,
  );
  const promptTooLong = prompt.trim().length > promptLimit;
  const selectedAspectRatio = selectedModel.aspectRatios.includes(aspectRatio)
    ? aspectRatio
    : selectedModel.aspectRatios[0]!;
  // The pixel tier. Falls back to 1K when the picked model does not offer the
  // one chosen on the last (kie documents none for google/nano-banana).
  const [resolution, setResolution] = useState<ImageResolutionId>("1K");
  const selectedResolution = selectedModel.resolutions?.includes(resolution) ? resolution : "1K";
  // Includes a per-reference charge where the model has one (Seedream 5.5 · Kie).
  const selectedCostUsd = imageCostUsd(selectedModel, selectedResolution, taggedPictures.length);
  const costLabel =
    selectedCostUsd === null ? "Pricing verification pending" : formatUsdRate(selectedCostUsd);
  const batchCostLabel =
    selectedCostUsd === null
      ? "Pricing verification pending"
      : formatUsdRate(selectedCostUsd * imageCount);

  // ---------------------------------------------------------------------
  // DRAFT PERSISTENCE (0088)
  //
  // Leaving the page unmounts this component and takes the prompt, the model,
  // the ratio and the batch count with it. None of that is server state — it is
  // half-written input, per-browser and per-person, so localStorage is the
  // right home for it and a database row would be the wrong one.
  //
  // Generated image URLs are not stored; signed links expire. Only unsent
  // prompt settings are restored when the page is revisited.
  //
  // Every access is wrapped: a browser with site data blocked throws on the
  // accessor itself, and a console that cannot start because of a storage
  // preference would be a worse bug than a forgotten draft.
  // ---------------------------------------------------------------------

  // "Reuse" in the image viewer (components/image-generator-history.tsx)
  // refills the bar: prompt, model and ratio. The model and ratio are only
  // applied if this bar offers them — the ratio falls back on its own through
  // selectedAspectRatio, and a model this page does not list is ignored.
  useEffect(() => {
    function onReuse(event: Event): void {
      const detail = (event as CustomEvent<ImageReuseDetail>).detail;
      setPrompt(detail.prompt);
      if (detail.modelId && models.some((model) => model.id === detail.modelId)) {
        setModelId(detail.modelId);
      }
      if (detail.aspectRatio) setAspectRatio(detail.aspectRatio);
      setImageCount(1);
      setErrorMessage(null);
    }
    window.addEventListener(IMAGE_REUSE_EVENT, onReuse);
    return () => window.removeEventListener(IMAGE_REUSE_EVENT, onReuse);
  }, [models]);

  const DRAFT_KEY = `image-generator:draft:${projectId ?? "personal"}`;
  // Restore happens once, and must not be written back over by the save effect
  // before it has run. STATE, not a ref: a ref flipped inside the restore effect
  // let the save effect in the SAME commit write the empty initial prompt over
  // the draft — and under StrictMode's double effect run the second restore
  // then read that empty draft back. Switching Image ⇄ Video on /create lost
  // the prompt that way. As state, the first save runs a render later, with
  // the restored values.
  const [restored, setRestored] = useState(false);

  // react-hooks/set-state-in-effect is disabled for THIS effect only, and the
  // reason is server rendering rather than convenience.
  //
  // The rule's usual advice is to compute the value during render instead —
  // `useState(() => read())`. That is exactly what cannot happen here: this
  // component renders on the server first, where `window` does not exist, and a
  // lazy initializer that read localStorage on the client would produce
  // different markup than the server sent and break hydration. Restoring in an
  // effect, after mount, is the only correct place for it.
  //
  // The cascade the rule guards against also does not happen: this runs once,
  // on mount, and React batches the setState calls below into a single
  // re-render. Every OTHER effect in this file stays under the rule.
  /* eslint-disable react-hooks/set-state-in-effect -- see the note above */
  useEffect(() => {
    try {
      const draft = parseImageDraft(window.localStorage.getItem(DRAFT_KEY), (id) =>
        models.some((model) => model.id === id),
      );
      if (draft.prompt !== undefined) setPrompt(draft.prompt);
      if (draft.modelId !== undefined) setModelId(draft.modelId);
      if (draft.aspectRatio !== undefined) setAspectRatio(draft.aspectRatio);
      if (draft.imageCount !== undefined) setImageCount(draft.imageCount);
    } catch {
      // A browser with site data blocked throws on the accessor itself. A
      // forgotten draft is a far smaller problem than a console that will not
      // start because of a storage preference.
    } finally {
      setRestored(true);
    }
    // Once, on mount. DRAFT_KEY is derived from a prop that cannot change for
    // the life of this page, and `models` is a server-rendered constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(
        DRAFT_KEY,
        serializeImageDraft({ prompt, modelId, aspectRatio, imageCount }),
      );
    } catch {
      // Out of quota, or blocked. The console still works; only the draft is
      // forgotten, which is what would have happened anyway.
    }
  }, [restored, DRAFT_KEY, prompt, modelId, aspectRatio, imageCount]);

  function updatePromptDraft(nextPrompt: string): void {
    setPrompt(nextPrompt);
    if (!restored) return;
    // Write on input too, so immediate navigation cannot beat the save effect.
    try {
      window.localStorage.setItem(
        DRAFT_KEY,
        serializeImageDraft({ prompt: nextPrompt, modelId, aspectRatio, imageCount }),
      );
    } catch {
      // The form still works when browser storage is blocked.
    }
  }

  /**
   * Appends the picked reference as an @tag.
   *
   * Append rather than insert-at-caret: this component does not own the
   * textarea's selection (UgcPromptEditor does), and guessing a caret position
   * across a dialog close is how text lands in the middle of a word. The
   * operator can move it; they cannot easily undo a splice they did not see.
   */
  function insertTag(reference: PickedReference): void {
    const tag = `@${reference.name.replace(/^@+/, "")}`;
    setPrompt((current) => {
      if (current.includes(tag)) return current;
      return current.trim() ? `${current.trimEnd()} ${tag}` : tag;
    });
  }

  /**
   * A wall tile dropped on the bar: save the picture to the user's own
   * elements under its fixed tag, then tag it. "Already used" means an earlier
   * drop of the same picture saved it, so the tag is simply added again.
   */
  const [dropTarget, setDropTarget] = useState(false);
  function handleDrop(event: DragEvent<HTMLFormElement>): void {
    const assetId = event.dataTransfer.getData(GENERATED_IMAGE_DRAG_TYPE);
    if (!assetId) return;
    event.preventDefault();
    setDropTarget(false);
    if (taggedPictures.length >= MAX_REFERENCES) {
      setErrorMessage(`A prompt can reference up to ${MAX_REFERENCES} pictures.`);
      return;
    }
    const name = dragReferenceName(assetId);
    const formData = new FormData();
    formData.set("assetId", assetId);
    formData.set("name", name);
    formData.set("destination", "mine");
    setErrorMessage(null);
    void saveGeneratedElement(formData).then(
      (result) => {
        const error = result?.error;
        if (error && !error.includes("already used")) {
          setErrorMessage(error);
          return;
        }
        insertTag({ kind: "element", elementId: "", name, previewUrl: "" });
        startRefresh(() => router.refresh());
      },
      () => setErrorMessage("Could not reference that image. Try again."),
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    handleGenerate();
  }

  function handleGenerate(confirmed = false): void {
    const trimmedPrompt = prompt.trim();
    if (disabledReason || generateLocked || !trimmedPrompt || promptTooLong) return;
    if (!confirmed) {
      setConfirmation(imageCount);
      return;
    }

    const requestedCount = imageCount;
    setErrorMessage(null);
    setInFlight((n) => n + requestedCount);
    void Promise.all(
      Array.from({ length: requestedCount }, async (_, index) => {
        try {
          const formData = new FormData();
          formData.set("prompt", trimmedPrompt);
          formData.set("idempotencyKey", crypto.randomUUID());
          formData.set("imageModel", modelId);
          formData.set("aspectRatio", selectedAspectRatio);
          formData.set("resolution", selectedResolution);

          // Each output remains its own priced, cap-checked image attempt.
          const result = await generate(formData);
          if (result.error !== undefined) {
            setErrorMessage(`Image ${index + 1}: ${result.error}`);
          }
        } catch (error) {
          setErrorMessage(
            `Image ${index + 1}: ${error instanceof Error ? error.message : "Failed to generate."}`,
          );
        } finally {
          setInFlight((n) => n - 1);
          startRefresh(() => router.refresh());
        }
      }),
    );
  }

  return (
    <>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="size-5" aria-hidden="true" />
            </div>
            <DialogTitle>
              {confirmation === 1 ? "Generate this image?" : `Generate ${confirmation} images?`}
            </DialogTitle>
            <DialogDescription>
              These images will use the same prompt and settings. Review them before generation.
            </DialogDescription>
          </DialogHeader>
          {unknownTagsNotice ? (
            <p
              role="status"
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            >
              {unknownTagsNotice}
            </p>
          ) : null}
          <dl className="space-y-3 rounded-xl border bg-muted/30 p-4 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Model</dt>
              <dd className="font-medium">{selectedModel.label}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Aspect ratio</dt>
              <dd className="font-medium">{selectedAspectRatio}</dd>
            </div>
            {selectedModel.resolutions ? (
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Resolution</dt>
                <dd className="font-medium">{selectedResolution}</dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Images</dt>
              <dd className="font-medium">{confirmation}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-t pt-3">
              <dt className="text-muted-foreground">Estimated cost</dt>
              <dd className="text-lg font-semibold">{batchCostLabel}</dd>
            </div>
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Generation counts toward your allowance and may continue in the background.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={generateLocked || !!disabledReason}
              onClick={() => {
                setConfirmation(null);
                handleGenerate(true);
              }}
            >
              Confirm generation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* THE PROMPT DOCK.
          Sticky rather than fixed: <main> in app/(app)/layout.tsx is the
          scroll container, so sticky keeps this inside the content column —
          a fixed bar would sit over the sidebar at every width and would have
          to re-derive the sidebar's own collapsed/expanded geometry to avoid
          it. The fade above it is what keeps the gallery readable as tiles
          scroll under the bar. */}
      <div className="pointer-events-none sticky bottom-0 z-30 mt-auto bg-gradient-to-t from-background via-background to-transparent px-3 pb-3 pt-8 has-[[data-moved=true]]:bg-none">
        <div className="flex w-full flex-col gap-2">
          {/* NOTHING IS PREVIEWED HERE, AND THAT IS THE DESIGN.
              A strip above the bar showed the newest picture for the few
              seconds before the gallery behind it refreshed with the same
              picture, larger — the same image twice, and the bar jumping up
              the screen each time one landed. The generation is handed to the
              Runs pill instead (components/image-attempt-panel.tsx), which is
              where an attempt lives whether or not this page is still open,
              and which now says so while one is in flight. */}
          {disabledReason ? (
            <p
              id="image-generator-disabled"
              role="status"
              className="pointer-events-auto rounded-xl border border-border bg-card/95 p-3 text-sm shadow-lg backdrop-blur"
            >
              {disabledReason}
            </p>
          ) : null}

          {errorMessage ? (
            <p
              role="alert"
              className="pointer-events-auto rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive shadow-lg backdrop-blur"
            >
              {errorMessage}
            </p>
          ) : null}

          <ResizablePromptBar storageKey="create" defaultPx={64}>
            <form
              aria-label="Generate image"
              aria-busy={pending}
              onSubmit={handleSubmit}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(GENERATED_IMAGE_DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDropTarget(true);
              }}
              onDragLeave={() => setDropTarget(false)}
              onDrop={handleDrop}
              className={cn(
                "relative rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur",
                dropTarget && "ring-2 ring-primary",
              )}
            >
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Label htmlFor="image-generator-prompt" required className="sr-only">
                    Prompt
                  </Label>
                  {/* THE REFERENCES BOX, in the video bar's style: a header with the
                    count and an Add button, then one chip per tagged picture.
                    The prompt's @tags stay the source of truth — removing a chip
                    removes its tag. Hidden while nothing is tagged; "@" in the
                    controls row is the way in. */}
                  {taggedPictures.length > 0 ? (
                    <section className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          References{" "}
                          <span className="font-normal tabular-nums normal-case tracking-normal">
                            {taggedPictures.length}/{MAX_REFERENCES}
                          </span>
                        </Label>
                        <button
                          type="button"
                          onClick={() => {
                            setReferencePickerTab("elements");
                            setReferencePickerOpen(true);
                          }}
                          disabled={taggedPictures.length >= MAX_REFERENCES}
                          className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Plus aria-hidden="true" className="size-3" />
                          Add
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {taggedPictures.map((element) => (
                          <span
                            key={element.id}
                            title={`@${element.name}`}
                            className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border bg-card pl-1 pr-0.5 text-xs"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- signed image URL */}
                            <img
                              src={element.previewUrl}
                              alt=""
                              className="size-6 shrink-0 rounded-sm border object-cover"
                            />
                            <span className="max-w-[9rem] truncate font-medium">
                              @{element.name}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setPrompt((current) => removeTagFromPrompt(current, element.name))
                              }
                              aria-label={`Remove @${element.name} reference`}
                              className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              <XIcon aria-hidden="true" className="size-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <UgcPromptEditor
                    id="image-generator-prompt"
                    name="prompt"
                    value={prompt}
                    onChange={updatePromptDraft}
                    elements={elements}
                    charCount={prompt.trim().length}
                    maxChars={promptLimit}
                    placeholder="Describe the scene you imagine — subject, setting, light. Type @ for a saved reference."
                    // Height and colour only — NOT padding or font metrics. Those are
                    // shared with the highlight mirror drawn on top of this box,
                    // and changing them on one layer paints every @tag twice,
                    // out of register. See UgcPromptEditorProps.textareaClassName.
                    textareaClassName="h-16 max-h-16 min-h-16 flex-none rounded-xl border-transparent bg-transparent shadow-none focus-visible:border-transparent focus-visible:ring-0"
                    boxClassName="pr-32"
                  />

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex h-9 items-center rounded-lg bg-muted/60">
                      <button
                        type="button"
                        onClick={() => {
                          setReferencePickerTab("uploads");
                          setReferencePickerOpen(true);
                        }}
                        aria-label="Upload a reference image"
                        title="Upload a reference image"
                        className="grid h-full w-9 place-items-center rounded-l-lg text-foreground transition-colors hover:bg-muted"
                      >
                        <Plus aria-hidden="true" className="size-4" />
                      </button>
                      <span aria-hidden="true" className="h-4 w-px bg-border" />
                      <button
                        type="button"
                        onClick={() => {
                          setReferencePickerTab("elements");
                          setReferencePickerOpen(true);
                        }}
                        aria-label="Add a reference image"
                        title="Tag a saved element"
                        className="grid h-full w-9 place-items-center rounded-r-lg text-foreground transition-colors hover:bg-muted"
                      >
                        <AtSign aria-hidden="true" className="size-4" />
                      </button>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        disabled={pending || !!disabledReason}
                        aria-label={`Images: ${imageCount}`}
                        className={PILL}
                      >
                        {imageCount} {imageCount === 1 ? "image" : "images"}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="top" align="start" sideOffset={8}>
                        <DropdownMenuLabel>Images per prompt</DropdownMenuLabel>
                        {[1, 2, 3, 4].map((count) => (
                          <DropdownMenuItem
                            key={count}
                            onSelect={() => setImageCount(count)}
                            className="gap-3 rounded-lg px-2 py-2"
                          >
                            <span className="flex-1">
                              {count} {count === 1 ? "image" : "images"}
                            </span>
                            {count === imageCount ? (
                              <Check aria-hidden="true" className="size-4 text-foreground" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        disabled={pending || !!disabledReason}
                        aria-label={`Model: ${selectedModel.label}`}
                        className={cn(PILL, "max-w-[16rem]")}
                      >
                        <Sparkles aria-hidden="true" className="size-4 text-primary" />
                        <span className="truncate">{selectedModel.label}</span>
                        <ChevronRight
                          aria-hidden="true"
                          className="size-3.5 text-muted-foreground"
                        />
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
                        {models.map((m) => (
                          <DropdownMenuItem
                            key={m.id}
                            disabled={m.costUsd === null}
                            onSelect={() => setModelId(m.id)}
                            className="gap-3 rounded-xl px-2 py-2"
                          >
                            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-sm font-semibold text-foreground">
                              {m.label.charAt(0)}
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate font-semibold">{m.label}</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {m.costUsd === null
                                  ? "Pricing verification pending"
                                  : m.inputImageCostUsd
                                    ? // The base rate alone read as the whole price (issue #53).
                                      `From ${formatUsdRate(m.costUsd)} · +${formatUsdRate(m.inputImageCostUsd)} per reference`
                                    : `${formatUsdRate(m.costUsd)} per image`}
                                {m.editId === null
                                  ? m.referenceDisabledReason
                                    ? " · references temporarily unavailable"
                                    : " · no references"
                                  : ""}
                              </span>
                            </span>
                            {m.id === selectedModel.id ? (
                              <Check aria-hidden="true" className="size-4 text-primary" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        disabled={pending || !!disabledReason}
                        aria-label={`Aspect ratio: ${selectedAspectRatio}`}
                        className={PILL}
                      >
                        <RatioIcon ratio={selectedAspectRatio} />
                        {selectedAspectRatio}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        side="top"
                        align="start"
                        sideOffset={8}
                        className="min-w-48 rounded-2xl p-2"
                      >
                        <DropdownMenuLabel className="text-xs text-muted-foreground">
                          Aspect ratio
                        </DropdownMenuLabel>
                        {selectedModel.aspectRatios.map((ratio) => (
                          <DropdownMenuItem
                            key={ratio}
                            onSelect={() => setAspectRatio(ratio)}
                            className="gap-3 rounded-lg px-2 py-2 font-semibold"
                          >
                            <span className="grid w-4 place-items-center">
                              <RatioIcon ratio={ratio} />
                            </span>
                            <span className="flex-1">{ratio}</span>
                            {ratio === selectedAspectRatio ? (
                              <Check aria-hidden="true" className="size-4 text-foreground" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Only for models kie documents tiers for. A tier nobody has been
                      billed at is listed but cannot be chosen — the same rule as a
                      model with no price. */}
                    {selectedModel.resolutions && selectedModel.resolutions.length > 1 ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          disabled={pending || !!disabledReason}
                          aria-label={`Resolution: ${selectedResolution}`}
                          className={PILL}
                        >
                          <Gem aria-hidden="true" className="size-4" />
                          {selectedResolution}
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="top"
                          align="start"
                          sideOffset={8}
                          className="min-w-56 rounded-2xl p-2"
                        >
                          <DropdownMenuLabel className="text-xs text-muted-foreground">
                            Resolution
                          </DropdownMenuLabel>
                          {selectedModel.resolutions.map((tier) => {
                            const cost = imageCostUsd(selectedModel, tier, taggedPictures.length);
                            return (
                              <DropdownMenuItem
                                key={tier}
                                disabled={cost === null}
                                onSelect={() => setResolution(tier)}
                                className="gap-3 rounded-lg px-2 py-2 font-semibold"
                              >
                                <span className="flex-1">{tier}</span>
                                <span className="text-xs font-normal text-muted-foreground">
                                  {cost === null ? "Pricing pending" : formatUsdRate(cost)}
                                </span>
                                {tier === selectedResolution ? (
                                  <Check aria-hidden="true" className="size-4 text-foreground" />
                                ) : null}
                              </DropdownMenuItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}

                    <p
                      id="image-generator-cost"
                      className="ml-auto whitespace-nowrap pr-1 text-xs text-muted-foreground"
                    >
                      {costLabel} per image
                      {imageCount > 1 ? ` · ${batchCostLabel} total` : null}
                    </p>
                  </div>
                </div>

                <PendingButton
                  type="submit"
                  pending={pending}
                  disabled={generateLocked || !!disabledReason || !prompt.trim() || promptTooLong}
                  aria-label={imageCount === 1 ? "Generate" : `Generate ${imageCount} images`}
                  aria-describedby={
                    disabledReason ? "image-generator-disabled" : "image-generator-cost"
                  }
                  className="absolute right-3 top-3 flex h-12 flex-col gap-0.5 rounded-lg bg-primary px-4 py-1 text-xs font-bold uppercase leading-tight tracking-wide text-primary-foreground hover:bg-primary/90"
                >
                  <span>{imageCount === 1 ? "Generate" : `Generate ${imageCount}`}</span>
                  <span className="text-[10px] font-semibold normal-case opacity-90">
                    {batchCostLabel}
                  </span>
                  {inFlight > 0 ? (
                    <span className="text-[10px] font-medium normal-case opacity-80">
                      {inFlight} generating
                    </span>
                  ) : null}
                </PendingButton>
              </div>
            </form>
          </ResizablePromptBar>

          {/* Only while there is nothing to read instead. The two things worth
              knowing before the first press — what a press costs you and what
              makes a portrait look real — and then it gets out of the way. */}
          <p
            aria-hidden={!!prompt.trim()}
            className={cn(
              "px-2 text-center text-[11px] leading-relaxed text-muted-foreground",
              prompt.trim() && "invisible",
            )}
          >
            Choose up to four images per prompt. A @tag adds its picture as a reference. For natural
            portraits, ask for visible pores, subtle skin-tone variation and soft daylight, with no
            beauty filter.
          </p>
        </div>
      </div>

      {/* OUTSIDE the <form> above, and it MUST stay outside.
          This sat inside it for one commit, and uploading a reference
          generated an image — a real charge, from a click that said Upload.

          The trap is that the DOM looks innocent. UgcReferencePicker's dialog
          is portalled to document.body (components/ui/dialog.tsx's
          DialogPortal), so its own <ActionForm> is never a DOM descendant of
          this one and devtools shows no nested <form> at all. But React
          propagates events through the REACT tree, not the DOM tree: the
          upload form's submit bubbled out of the portal and straight into this
          form's onSubmit, which generates.

          So neither `type="button"` (the trigger already has it) nor
          stopPropagation on the trigger would have helped — the submit came
          from inside the dialog, not from the button that opens it. */}
      <UgcReferencePicker
        projectId={projectId}
        hideTrigger
        open={referencePickerOpen}
        onOpenChange={setReferencePickerOpen}
        initialTab={referencePickerTab}
        elements={elements}
        current={null}
        onPick={(reference) => {
          if (reference.kind === "upload") {
            // Uploads are saved as named elements; refresh their new signed
            // preview into this picker instead of tagging the source filename,
            // which is not the saved element name.
            router.refresh();
            return;
          }
          insertTag(reference);
        }}
        onUseElement={(element) =>
          insertTag({
            kind: "element",
            elementId: element.id,
            name: element.name,
            previewUrl: element.previewUrl,
          })
        }
        // Image models cannot use audio references.
        imagesOnly
      />
    </>
  );
}
