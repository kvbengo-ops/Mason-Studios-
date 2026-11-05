"use client";

// The Script page's own empty-form + field-attachment pattern — see
// components/setup-form.tsx's header for why, and character-setup-form.tsx's
// header for where this file's fields used to live before the single
// Character Setup page split into Character/Product/Script routes. Compile
// lives here too — it's the gate this route exists to reach: no script, no
// scenes.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type JSX,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { createSetupForm } from "@/components/setup-form";
import { useRailBusyWhile } from "@/components/project-rail";
import { RAIL_ENTRY_SCRIPT } from "@/lib/project-rail";
import { InfoHint } from "@/components/info-hint";
import type { ActionResult } from "@/lib/action-result";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { ShimmerText } from "@/components/shimmer-text";
import { elapsedLabel } from "@/lib/render-elapsed";
import { updateCompileModel } from "@/actions/compiler-model";
import { CLAUDE_HAIKU_4_5, COMPILER_MODELS, getCompilerModel } from "@/lib/models";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatFileSizeMB } from "@/lib/file-type";
import {
  isAcceptedScriptFile,
  isAcceptedScriptFileSize,
  looksLikeUnsplitParagraph,
  MAX_SCRIPT_FILE_BYTES,
  parseTwoColumnScript,
  scriptRowsHaveVisualIdea,
  type ScriptRow,
} from "@/lib/script-columns";

const {
  formId: SCRIPT_SETUP_FORM_ID,
  SetupForm: ScriptSetupForm,
  useSetupFormState: useScriptSetupState,
  SaveButton,
} = createSetupForm("script-setup-form");

export { ScriptSetupForm, SaveButton };

/**
 * The script text currently in the textarea, shared with the blocks that
 * render BELOW the Compile button.
 *
 * `dirty` (setup-form.tsx's Context) says only *that* the field changed;
 * the "What this unlocks" forecast needs the text itself, and it is not a
 * descendant of ScriptField — the mockup puts it under the button, past a
 * divider, so it cannot read ScriptField's local state. One provider around
 * both is the smallest thing that works; lifting the whole textarea to a
 * controlled component would fight the uncontrolled `defaultValue` the
 * upload path writes through a ref.
 */
const ScriptDraftContext = createContext<{
  text: string;
  setText: (next: string) => void;
} | null>(null);

function useScriptDraft(): { text: string; setText: (next: string) => void } {
  const ctx = useContext(ScriptDraftContext);
  if (!ctx) {
    throw new Error("Script page fields must render inside <ScriptDraftProvider>.");
  }
  return ctx;
}

export function ScriptDraftProvider({
  initialValue,
  children,
}: {
  initialValue: string;
  children: ReactNode;
}): JSX.Element {
  const [text, setText] = useState(initialValue);
  const value = useMemo(() => ({ text, setText }), [text]);
  return <ScriptDraftContext.Provider value={value}>{children}</ScriptDraftContext.Provider>;
}

// Only the first N rows are ever shown — the point here is a fast sanity
// check on the delimiter, not a full editable review (Review Brief,
// downstream, is for that).
const SCRIPT_PREVIEW_ROW_LIMIT = 5;

/**
 * The live two-column preview — the single most important piece of UI this
 * feature adds: the operator must see how their paste was interpreted
 * before they spend money on it. A wrong delimiter (or a script that isn't
 * actually two-column at all) shows up here immediately.
 */
function ScriptPreview({ rows }: { rows: ScriptRow[] }): JSX.Element {
  const hasVisualIdeas = scriptRowsHaveVisualIdea(rows);
  const shown = rows.slice(0, SCRIPT_PREVIEW_ROW_LIMIT);
  const hiddenCount = rows.length - shown.length;
  const unsplit = looksLikeUnsplitParagraph(rows);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-xs font-medium text-foreground">
          {rows.length} line{rows.length === 1 ? "" : "s"}
        </p>
        {hasVisualIdeas ? (
          <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-primary">
            Script + Visual Idea
          </span>
        ) : null}
        <InfoHint>
          Claude groups these into scenes when you compile — the scene count can differ.
        </InfoHint>
      </div>
      {unsplit ? (
        <p className="text-xs text-warning">
          This is one long line with several sentences in it. If the whole ad landed here as a
          single block, put each spoken beat on its own line — otherwise it compiles as one scene.
        </p>
      ) : null}
      <div className="rounded-md border border-border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Script</TableHead>
              <TableHead>Visual idea</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row, i) => (
              <TableRow key={i}>
                <TableCell className="max-w-64 whitespace-normal break-words align-top text-xs">
                  {row.script.length > 0 ? (
                    row.script
                  ) : (
                    <span className="italic text-muted-foreground">(no dialogue)</span>
                  )}
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal break-words align-top text-xs text-muted-foreground">
                  {row.visualIdea ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {hiddenCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          + {hiddenCount} more line{hiddenCount === 1 ? "" : "s"} not shown.
        </p>
      ) : null}
    </div>
  );
}

const SCRIPT_FORMAT_EXAMPLE_ROWS: readonly { script: string; visualIdea: string }[] = [
  { script: "Okay, I need to talk about this.", visualIdea: "Close-up, holding it to camera" },
  { script: "Three weeks in and my skin is different.", visualIdea: "Bathroom mirror, morning" },
];

/** What the empty Script field shows in place of the preview — see ScriptPreview's doc comment for the reasoning this shares. */
function ScriptFormatExample(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
      <p className="text-xs font-medium text-muted-foreground">
        Example — one line per beat. Two columns? Separate them with a Tab or a <code>|</code>.
      </p>
      <div className="rounded-md border border-border bg-background/50">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Script</TableHead>
              <TableHead>Visual idea</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SCRIPT_FORMAT_EXAMPLE_ROWS.map((row) => (
              <TableRow key={row.script}>
                <TableCell className="max-w-64 whitespace-normal break-words align-top text-xs text-muted-foreground">
                  {row.script}
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal break-words align-top text-xs text-muted-foreground">
                  {row.visualIdea}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * The script itself, plus a `.txt` upload, a live parsed-line-count +
 * two-column preview (ScriptPreview above), and the `Include Visual Idea`
 * checkbox.
 */
export function ScriptField({
  initialValue,
  locked,
  initialIncludeVisualIdea,
}: {
  initialValue: string;
  locked: boolean;
  /** projects.include_visual_idea (0024) — see IncludeVisualIdeaField below. */
  initialIncludeVisualIdea: boolean;
}): JSX.Element {
  const { pending, markDirty } = useScriptSetupState();
  const disabled = locked || pending;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { text: scriptText, setText: setScriptText } = useScriptDraft();
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  const parsedRows = useMemo(() => parseTwoColumnScript(scriptText), [scriptText]);

  function handleTextareaChange(e: ChangeEvent<HTMLTextAreaElement>): void {
    markDirty();
    setScriptText(e.target.value);
    setUploadedFileName(null);
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) {
      return;
    }

    if (!isAcceptedScriptFile(file)) {
      toast.error(`"${file.name}" doesn't look like a .txt file — pick a plain-text script.`);
      return;
    }
    if (!isAcceptedScriptFileSize(file)) {
      toast.error(
        `"${file.name}" is ${formatFileSizeMB(file.size)} — the limit for a script upload is ` +
          `${formatFileSizeMB(MAX_SCRIPT_FILE_BYTES)}.`,
      );
      return;
    }

    const reader = new FileReader();
    reader.onerror = (): void => {
      toast.error(`Failed to read "${file.name}".`);
    };
    reader.onload = (): void => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (textareaRef.current) {
        textareaRef.current.value = text;
      }
      setScriptText(text);
      setUploadedFileName(file.name);
      markDirty();
    };
    reader.readAsText(file);
  }

  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="script_raw" required>
        Script
      </Label>
      <Textarea
        id="script_raw"
        name="script_raw"
        form={SCRIPT_SETUP_FORM_ID}
        required
        rows={12}
        ref={textareaRef}
        defaultValue={initialValue}
        disabled={disabled}
        readOnly={locked}
        onChange={handleTextareaChange}
        className="max-h-64 overflow-y-auto font-mono text-base md:text-sm"
        placeholder={
          "Paste the full script here… or paste two columns (Script, then a Tab or a | , " +
          "then Visual Idea) copied straight out of a spreadsheet."
        }
      />

      {/* No <UnsavedChangesNotice /> here: SaveButton renders the same
          component a few dozen pixels below this card, so the page printed
          the identical "Unsaved changes" paragraph twice. */}

      {locked ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            onChange={handleFile}
            disabled={disabled}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            Upload .txt script
          </Button>
          {uploadedFileName ? (
            <span className="text-xs text-muted-foreground">{uploadedFileName}</span>
          ) : null}
        </div>
      )}

      {parsedRows.length > 0 ? (
        <ScriptPreview rows={parsedRows} />
      ) : locked ? null : (
        <ScriptFormatExample />
      )}

      <IncludeVisualIdeaField
        initialValue={initialIncludeVisualIdea}
        locked={locked}
        pending={pending}
        hasVisualIdea={scriptRowsHaveVisualIdea(parsedRows)}
      />
    </div>
  );
}

/**
 * Spec §3.3: "Include Visual Idea" checkbox, checked by default. Always
 * rendered, never conditionally unmounted — see lib/direction.ts's
 * DirectionSchema doc comment for why that matters to how the save action
 * reads this key off FormData.
 */
function IncludeVisualIdeaField({
  initialValue,
  locked,
  pending,
  hasVisualIdea,
}: {
  initialValue: boolean;
  locked: boolean;
  pending: boolean;
  /** Whether any parsed row actually carries a Visual Idea — see the inert-toggle note below. */
  hasVisualIdea: boolean;
}): JSX.Element {
  const { markDirty } = useScriptSetupState();
  const disabled = locked || pending;
  const [checked, setChecked] = useState(initialValue);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="include_visual_idea"
          name="include_visual_idea"
          form={SCRIPT_SETUP_FORM_ID}
          defaultChecked={initialValue}
          disabled={disabled}
          onChange={(e) => {
            setChecked(e.target.checked);
            markDirty();
          }}
          className="size-4 rounded border-input"
        />
        <Label htmlFor="include_visual_idea" className="flex items-center gap-2 font-normal">
          <span>Include Visual Idea</span>
          <InfoHint>
            Treats the Visual Idea column above as a direction to expand, instead of writing the
            camera and shot direction from scratch. Add one by putting a Tab or a | after a line,
            then the shot you want.
          </InfoHint>
        </Label>
      </div>
      {checked && !hasVisualIdea ? (
        <p className="pl-6 text-xs text-muted-foreground">
          No Visual Idea column in the script above, so this changes nothing yet. Add one by putting
          a Tab or a <code>|</code> after a line, then the shot you want.
        </p>
      ) : null}
    </div>
  );
}

const compileCostFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Which model compileScript/recompile (actions/compile.ts) will actually
 * run on — persisted to projects.render_settings.compileModel via
 * actions/compiler-model.ts's updateCompileModel.
 *
 * Presentational: the selection lives in CompileAction, because the button
 * now carries the chosen model and its price and the two must never
 * disagree. The design states the model as a fact on the button and offers
 * no picker at all — dropping this control would delete a real capability
 * (and its persisted setting), so it stays, demoted to a secondary row
 * UNDER the button instead of a bordered box above it. The design's actual
 * point — the money rides on the thing you click — is served by the button.
 */
function CompilerModelPicker({
  selectedId,
  onSelect,
  saving = false,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
  /**
   * True while a previous pick is still being written.
   *
   * The picker updates optimistically and reverts on refusal, so a second
   * click mid-save would race the first: two writes, and the loser's revert
   * could undo the winner. Cheap to prevent, and the flag already existed —
   * it was briefly pointed at the rail instead, where it lit the Script row
   * for a sub-second save while the actual compile went unreported.
   */
  saving?: boolean;
}): JSX.Element {
  const disabledModels = COMPILER_MODELS.filter((candidate) => !candidate.enabled);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="shrink-0 text-xs text-muted-foreground">Compiler</span>
        <div className="flex flex-wrap gap-1">
          {COMPILER_MODELS.map((candidate) => (
            <Button
              key={candidate.id}
              type="button"
              size="sm"
              variant={candidate.id === selectedId ? "default" : "outline"}
              disabled={!candidate.enabled || saving}
              title={
                candidate.enabled
                  ? `${compileCostFormatter.format(candidate.costUsd)} per compile`
                  : (candidate.disabledReason ?? undefined)
              }
              onClick={candidate.enabled ? (): void => onSelect(candidate.id) : undefined}
              className={`h-7 px-2.5 text-xs font-medium ${!candidate.enabled ? "opacity-50" : ""}`}
            >
              {candidate.label}
              <span className="ml-1 opacity-70">
                {compileCostFormatter.format(candidate.costUsd)}
              </span>
            </Button>
          ))}
        </div>
      </div>
      {disabledModels.map((candidate) => (
        <p key={candidate.id} className="text-xs text-muted-foreground">
          {candidate.label}: {candidate.disabledReason}
        </p>
      ))}
      {selectedId !== CLAUDE_HAIKU_4_5.id ? (
        <p className="text-xs text-muted-foreground">
          {(getCompilerModel(selectedId).costUsd / CLAUDE_HAIKU_4_5.costUsd).toFixed(1)}x{" "}
          {CLAUDE_HAIKU_4_5.label}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The clock on the running Compile button.
 *
 * A real compileBrief call is ten to thirty seconds, and a button with no
 * moving number on it reads as hung — which is how an operator ends up
 * clicking a paid action twice. The spinner says "running"; this says "for
 * how long". Mounted only while the form is pending (SubmitButton renders
 * `pendingLabel` in that branch alone), so its own mount IS the start of
 * the run and there is no submitted_at to thread down from the server.
 *
 * Reuses lib/render-elapsed.ts's `m:ss` formatter rather than growing a
 * second one — the render header already spells elapsed time this way.
 */
function CompileElapsed(): JSX.Element {
  const [elapsedMs, setElapsedMs] = useState(0);
  // This component's lifetime IS the compile's — React mounts it only while
  // the form is pending — which is why it can show a clock, and why it is
  // the honest place to report the run to the rail. The Script row spins
  // from mount and stops on unmount, including when the operator navigates
  // away mid-compile: the case the rail exists for.
  useRailBusyWhile(RAIL_ENTRY_SCRIPT, true);

  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return (): void => clearInterval(id);
  }, []);

  return <span className="tabular-nums">{elapsedLabel(elapsedMs)}</span>;
}

/**
 * "Compiling…  0:14 · Claude Sonnet 5 · $0.12" — the design's running
 * button, verbatim in shape.
 *
 * Exported for its own test: driving the clock through a real form submit
 * needs fake timers, and advancing those clears React's form-action pending
 * state, which unmounts the very thing under test.
 */
export function CompilePendingLabel({
  label,
  amount,
}: {
  label: string;
  amount: string;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <ShimmerText label={label} />
      <span className="text-xs font-normal opacity-75">
        <CompileElapsed /> · {amount}
      </span>
    </span>
  );
}

/**
 * Compile/Recompile — the gate this route exists to reach.
 *
 * runCompile (actions/compile.ts) reads PERSISTED project state
 * (`project.script_raw`), never what is on screen. This used to be resolved
 * by refusing: the button was disabled while the form was dirty, under a
 * paragraph telling the operator to go press Save first. The design has one
 * control between typing and compiling, and the honest way to have one is
 * not to drop the save but to DO it — hence `saveAction` and
 * saveThenCompile below, which keep "compiling reads the saved script" true
 * by making sure the script is saved by the time it runs.
 *
 * It still has to live inside <ScriptSetupForm> (as a child, not a sibling)
 * to reach `dirty` and the form's fields. The Server Component page does
 * all the real work — requireProjectReadable, the data loads, and deciding
 * via `locked`/`hasScript`/`characterMessage` whether this is offered at
 * all.
 */
export function CompileAction({
  action,
  saveAction,
  label,
  dirtyLabel,
  pendingLabel,
  fallbackErrorMessage,
  projectId,
  initialCompilerModel,
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  /**
   * saveScript bound to this project. The design has ONE control between
   * typing and compiling, and this is what makes that honest rather than a
   * lie about what compiling reads: when the form is dirty the button saves
   * the script first and only then compiles it, so the brief is always
   * compiled from the text on screen.
   */
  saveAction: (formData: FormData) => Promise<ActionResult | void>;
  /** Idle label, e.g. "Compile script". A string, not a node — `dirtyLabel` has to be able to replace it. */
  label: string;
  /** Idle label when the form is dirty, e.g. "Save & compile" — same click, one more step, said out loud. */
  dirtyLabel: string;
  pendingLabel: string;
  fallbackErrorMessage: string;
  projectId: string;
  initialCompilerModel: string;
}): JSX.Element {
  const { dirty, pending } = useScriptSetupState();
  const [modelId, setModelId] = useState(initialCompilerModel);
  // The pending flag was discarded here. Compiling is the longest call in
  // the app and the one the operator is most likely to walk away from, so
  // the Script row in the rail has to carry it — that is the rail's whole
  // job as an activity indicator, and this hook was plumbing nobody called.
  // Named for what it actually tracks. This transition belongs to
  // selectModel below — the sub-second compiler-model save — and nothing
  // else. It was briefly wired to the rail under the name `isCompiling`,
  // which turned the Script row's ring for that save and left it still for
  // the ten-to-thirty-second compile: exactly backwards, and a false
  // "running" claim whenever someone merely changed the model.
  //
  // The compile submits through ActionForm and is tracked by useFormStatus
  // inside SubmitButton, so the rail is reported from CompileElapsed, which
  // React mounts only while that form is pending.
  const [savingModel, startTransition] = useTransition();

  function selectModel(id: string): void {
    if (id === modelId) return;
    const previous = modelId;
    setModelId(id);
    startTransition(async () => {
      try {
        const result = await updateCompileModel(projectId, id);
        if (result?.error) {
          toast.error(result.error);
          setModelId(previous);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save compiler model.");
        setModelId(previous);
      }
    });
  }

  const selected = getCompilerModel(modelId);
  // What the click costs, on the click. The price used to sit in a bordered
  // box above the button, which is the one place it cannot be read as a
  // property of the action.
  const amount = `${selected.label} · ${compileCostFormatter.format(selected.costUsd)}`;

  async function saveThenCompile(formData: FormData): Promise<ActionResult | void> {
    if (dirty) {
      const form = document.getElementById(SCRIPT_SETUP_FORM_ID);
      if (form instanceof HTMLFormElement) {
        const saveResult = await saveAction(new FormData(form));
        // Stop on a save failure rather than compiling the OLD script: the
        // operator asked to compile what they typed, and spending on the
        // previous text would be the expensive kind of surprise.
        if (saveResult?.error) return saveResult;
      }
    }
    return action(formData);
  }

  return (
    <div id="compile-action" className="flex flex-col gap-2">
      <ActionForm action={saveThenCompile} fallbackErrorMessage={fallbackErrorMessage}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SubmitButton
            size="lg"
            disabled={pending}
            pendingLabel={<CompilePendingLabel label={pendingLabel} amount={amount} />}
          >
            <span>{dirty ? dirtyLabel : label} →</span>
            <span className="text-xs font-normal opacity-75">{amount}</span>
          </SubmitButton>
          {/* The design puts "you can leave — this runs in the background"
              right here. It is false in this app and printing it would be
              the expensive kind of wrong: compileBrief is awaited inline
              inside the server action (actions/compile.ts) and the scene
              rows are written only after it returns, so navigating away
              aborts the request the result was coming back on while the
              Claude call it triggered has already been made and billed.
              What the design is actually buying with that line is an
              operator who is not left guessing — so this says the true
              thing AND gives the number (ten to thirty seconds) that makes
              the wait legible, which is the same job. Making backgrounding
              real is a queued job, the way renders already work; until that
              exists this warning stands — but the rail DOES carry the compile
              now (see CompileElapsed), so leaving at least shows the work is
              still going rather than showing nothing at all. */}
          <p className="max-w-xs text-xs text-muted-foreground">
            Runs in this tab — usually ten to thirty seconds. Leaving before it finishes can lose a
            result you have already paid for.
          </p>
        </div>
      </ActionForm>
      <CompilerModelPicker selectedId={selected.id} onSelect={selectModel} saving={savingModel} />
    </div>
  );
}

/**
 * How the pasted lines are likely to land as A-roll vs. B-roll.
 *
 * Grounded in the one rule the compiler template states outright
 * (0019_seed_template_v5.sql §4): `is_talking_head` is true only when a
 * person is visibly speaking, and "B-roll or product-only beats with no
 * spoken line still get their own scene" (§ scene sizing). So a parsed row
 * WITH a spoken line is an A-roll candidate and a visual-only row (a Visual
 * Idea with an empty script cell — see lib/script-columns.ts's
 * ragged-input policy) is a B-roll one.
 *
 * It is a forecast, not a promise: Claude merges and splits beats, the
 * template tells it to default to `false` when in doubt, and a `voiceover`
 * UGC style biases the whole ad away from talking heads. The UI says so and
 * prefixes every count with `~`.
 */
export function forecastRollSplit(rows: readonly ScriptRow[]): {
  aRoll: number;
  bRoll: number;
} {
  let aRoll = 0;
  let bRoll = 0;
  for (const row of rows) {
    if (row.script.trim().length > 0) {
      aRoll += 1;
    } else {
      bRoll += 1;
    }
  }
  return { aRoll, bRoll };
}

/**
 * A per-frame price rounded UP to the cent — fal's $0.0398 must read $0.04
 * and never $0.03. Same rule and same epsilon as render-settings-form.tsx's
 * ceilToCents: a quoted number is allowed to overstate, never to understate,
 * and the epsilon keeps an exact figure (kie's $0.02, which is
 * 2.0000000000000004 cents in IEEE754) from being pushed up a whole cent.
 */
export function frameCostLabel(costUsd: number): string {
  return compileCostFormatter.format(Math.ceil(costUsd * 100 - 1e-9) / 100);
}

/**
 * "What this unlocks" — the forecast the design puts below a divider under
 * the Compile button: what you get for the money, before you spend it.
 *
 * Reads the LIVE textarea text (ScriptDraftProvider), not the saved script,
 * because the button beside it now compiles the live text too.
 */
export function UnlocksForecast({
  /** estimatedRefFrameCostUsd(imageVendor()), resolved on the server — IMAGE_VENDOR is not NEXT_PUBLIC_ and reads as "fal" for everything in a browser. */
  frameCostUsd,
}: {
  frameCostUsd: number;
}): JSX.Element | null {
  const { text } = useScriptDraft();
  const rows = useMemo(() => parseTwoColumnScript(text), [text]);

  if (rows.length === 0) {
    return null;
  }

  const { aRoll, bRoll } = forecastRollSplit(rows);
  const perFrame = frameCostLabel(frameCostUsd);

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <p className="text-sm font-medium text-foreground">What this unlocks</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          { key: "a", label: "A-roll", count: aRoll, hint: "lines spoken to camera" },
          { key: "b", label: "B-roll", count: bRoll, hint: "visual-only beats" },
        ].map((card) => (
          <div
            key={card.key}
            className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
                {card.label}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">~{card.count}</span>
            </div>
            <div className="flex h-12 items-center justify-center rounded-sm border border-border bg-background/50 text-[0.6875rem] text-muted-foreground">
              frame · {perFrame}
            </div>
            <p className="text-[0.6875rem] text-muted-foreground">{card.hint}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Estimated from the {rows.length} line{rows.length === 1 ? "" : "s"} above. Claude sets the
        final scene count and decides which scenes are talking-head; each scene then needs one
        reference frame at {perFrame} before any video is rendered.
      </p>
    </div>
  );
}
