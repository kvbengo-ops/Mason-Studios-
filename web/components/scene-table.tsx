"use client";

// Gate 1 editing surface (docs/architecture.md § "User flow" step 4). The
// operator reads and fixes up to ~30 rows before the render button becomes
// reachable, so this prioritises fast per-row editing over anything fancy:
// autosaved fields, an instant toggle, and a cost badge that visibly reacts.

import { useCallback, useOptimistic, useRef, useState, useTransition } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import { formatUsd } from "@/lib/format-usd";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CostBadge } from "@/components/cost-badge";
import { RailBusyWhile } from "@/components/project-rail";
import {
  updateScenePrompt,
  updateSceneLine,
  toggleTalkingHead,
  updateSceneDuration,
  deleteScene,
  addScene,
  applyScenePrompt,
  splitScene,
} from "@/actions/brief";
import { getModel, type RenderSettings } from "@/lib/models";
import { isEditable, isSceneContentEditable } from "@/lib/editable-guard";
import type { Database } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];

type OptimisticAction =
  { type: "patch"; id: string; patch: Partial<SceneRow> } | { type: "remove"; id: string };

type SaveState = "idle" | "saving" | "saved" | "error";

const DEBOUNCE_MS = 600;

function reduceScenes(state: SceneRow[], action: OptimisticAction): SceneRow[] {
  switch (action.type) {
    case "patch":
      return state.map((scene) => (scene.id === action.id ? { ...scene, ...action.patch } : scene));
    case "remove":
      return state.filter((scene) => scene.id !== action.id);
    default:
      return state;
  }
}

/**
 * One scene's clip length, as a choice between the lengths the project's
 * selected model actually accepts.
 *
 * A picker rather than a number input because the constraint is a SET, not a
 * range: Seedance Mini takes every second from 4 to 15, LTX only even
 * numbers from 6 to 20, Veo exactly 4, 6 or 8. `min`/`max`/`step` cannot say
 * that, so the old number field accepted anything in range and silently
 * snapped it afterwards — which is how an editor came to believe a 20s scene
 * had been accepted on a model that stops at 15.
 *
 * The out-of-set case is the one worth getting right. A scene compiled
 * against a model with a wider set (a v7 brief carries 16/18/20; the
 * compiler now emits only what every model accepts — see
 * UNIVERSAL_DURATIONS_S) still has to be editable here, and a picker whose
 * value isn't among its options renders blank, which would read as data
 * loss. So the current value is always offered, flagged when illegal, and
 * the trigger carries the warning colour: the row says what is wrong and
 * what to pick instead, rather than quietly rewriting the operator's ad.
 */
function DurationPicker({
  durationS,
  allowedDurationsS,
  modelLabel,
  onChange,
}: {
  durationS: number;
  allowedDurationsS: readonly number[];
  modelLabel: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const isAllowed = allowedDurationsS.includes(durationS);

  return (
    <Select value={String(durationS)} onValueChange={onChange}>
      <SelectTrigger
        className={cn("w-24", !isAllowed && "border-amber-500 text-amber-600 dark:text-amber-500")}
        aria-label={`Clip length in seconds${isAllowed ? "" : ` — ${modelLabel} will not accept ${durationS}s`}`}
        title={isAllowed ? undefined : `${modelLabel} will not accept ${durationS}s.`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {!isAllowed ? (
          // Kept selectable-looking but plainly marked: removing it would
          // blank the trigger, and blanking a value the operator never
          // changed is worse than showing it as the problem it is.
          <SelectItem value={String(durationS)} className="text-amber-600 dark:text-amber-500">
            {durationS}s — not supported
          </SelectItem>
        ) : null}
        {allowedDurationsS.map((seconds) => (
          <SelectItem key={seconds} value={String(seconds)}>
            {seconds}s
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A-roll/B-roll segmented control — deliberately not a single toggle
 * button. A button labelled with the scene's *current* value ("A-roll")
 * can't be read as "this scene is A-roll" vs. "click to make it A-roll";
 * that ambiguity is exactly what QA flagged. Showing both options side by
 * side with one visibly and programmatically marked as selected removes
 * it. Built as a two-option radiogroup (no ToggleGroup/RadioGroup
 * primitive exists in components/ui, and Tabs' role="tablist" semantics
 * are for switching panels, not for a value picker) so assistive tech
 * announces one choice between two options rather than two unrelated
 * buttons. Module-scope function component — no per-row provider/context,
 * just plain props, so it stays cheap across many table rows.
 */
function RollToggle({
  isTalkingHead,
  onChange,
}: {
  isTalkingHead: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  const options = [
    { label: "A-roll", value: true },
    { label: "B-roll", value: false },
  ] as const;

  return (
    <div
      role="radiogroup"
      aria-label="A-roll or B-roll"
      // shrink-0: the Roll column is one of the narrowest in the table, and a
      // segmented control that is allowed to shrink hands its squeeze to the
      // labels inside it.
      className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md border border-input bg-background p-0.5"
    >
      {options.map((option) => {
        const selected = isTalkingHead === option.value;
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className={cn(
              // whitespace-nowrap: these are raw <button>s, not the ui Button
              // (which carries it already), and "A-roll" has a hyphen — the
              // one character a browser is happy to break a line on. In a
              // narrow Roll column it broke to "A-" over "roll", turning a
              // one-line control into a cramped two-line one.
              "h-7 whitespace-nowrap rounded-sm px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState | undefined }): JSX.Element | null {
  if (!state || state === "idle") return null;
  if (state === "saving") {
    return <span className="text-xs text-muted-foreground">Saving…</span>;
  }
  if (state === "error") {
    return <span className="text-xs text-destructive">Failed to save</span>;
  }
  return <span className="text-xs text-muted-foreground">Saved</span>;
}

export function SceneTable({
  projectId,
  initialScenes,
  audioEnabled,
  renderSettings,
  applySceneCostUsd,
  readOnly = false,
}: {
  projectId: string;
  initialScenes: SceneRow[];
  /** Server-computed AUDIO_ENABLED flag, threaded down to CostBadge. */
  audioEnabled: boolean;
  /**
   * The project's persisted render settings, threaded down to CostBadge for
   * pricing and used here for the selected model's allowed clip lengths —
   * which are a property of the model now, not a global constant (see
   * 0012_render_settings.sql).
   */
  renderSettings: RenderSettings;
  /**
   * What one Apply costs on THIS project, in dollars — derived server-side
   * from the project's chosen compiler model (lib/models.ts's
   * applySceneCostUsd) and passed in rather than computed here, because
   * `renderSettings` above has already had compileModel parsed out of it:
   * RenderSettings is model/resolution/fps only. Split quotes 2x this.
   *
   * It is a prop and not the old flat APPLY_SCENE_COST_USD constant because
   * the constant was only ever right for Haiku — a project on Sonnet was
   * charged roughly three times what the button promised.
   */
  applySceneCostUsd: number;
  /**
   * True when the viewer is an admin looking at someone else's project
   * (requireProjectReadable's `isOwner: false` — see actions/guard.ts).
   * Every mutation this table can trigger is still refused server-side by
   * the owner-only actions in actions/brief.ts regardless of this prop, so
   * this is cosmetic, not the security boundary — it just keeps a
   * read-only viewer from seeing editable-looking controls that would only
   * error on submit.
   */
  readOnly?: boolean;
}): JSX.Element {
  const [scenes, applyOptimistic] = useOptimistic(initialScenes, reduceScenes);
  const [, startTransition] = useTransition();
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Tracks in-flight Apply/Split calls per scene — both spend a real Claude
  // call (see APPLY_SCENE_COST_USD), unlike the debounced text/duration
  // saves above, so the button itself needs a disabled "working" state
  // rather than relying on the save indicator.
  const [pendingSceneAction, setPendingSceneAction] = useState<Record<string, boolean>>({});

  // Per-model, not global: the render gate lets the project pick a model and
  // each one has its own accepted clip lengths (0012_render_settings.sql
  // dropped the schema-level set for this reason).
  const selectedModel = getModel(renderSettings.model);
  const allowedDurationsS = selectedModel.allowedDurationsS;
  const modelLabel = selectedModel.label;

  const setFieldState = useCallback((key: string, state: SaveState): void => {
    setSaveStates((prev) => ({ ...prev, [key]: state }));
  }, []);

  const scheduleTextSave = useCallback(
    (sceneId: string, field: "video_prompt" | "script_line", value: string): void => {
      const key = `${sceneId}:${field}`;
      const patch =
        field === "video_prompt"
          ? { video_prompt: value, edited_by_human: true }
          : { script_line: value };

      // Applied synchronously in its own transition so the "edited" badge
      // and cost-relevant fields stay in sync with what's on screen while
      // the debounced save is still in flight.
      startTransition(() => {
        applyOptimistic({ type: "patch", id: sceneId, patch });
      });
      setFieldState(key, "saving");

      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);

      timers.current.set(
        key,
        setTimeout(() => {
          startTransition(async () => {
            try {
              const result =
                field === "video_prompt"
                  ? await updateScenePrompt(sceneId, value)
                  : await updateSceneLine(sceneId, value);
              if (result?.error) {
                setFieldState(key, "error");
                toast.error(result.error);
                return;
              }
              setFieldState(key, "saved");
            } catch (err) {
              setFieldState(key, "error");
              toast.error(err instanceof Error ? err.message : "Failed to save scene.");
            }
          });
        }, DEBOUNCE_MS),
      );
    },
    [applyOptimistic, setFieldState],
  );

  function handleToggle(scene: SceneRow): void {
    startTransition(async () => {
      applyOptimistic({
        type: "patch",
        id: scene.id,
        patch: { is_talking_head: !scene.is_talking_head },
      });
      try {
        const result = await toggleTalkingHead(scene.id);
        if (result?.error) toast.error(result.error);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to toggle scene.");
      }
    });
  }

  /**
   * Saves one scene's clip length, chosen from this model's allowed set.
   *
   * No clamping and no debounce, unlike the free-text fields above, and both
   * omissions are the point. This used to be a number input that silently
   * snapped whatever was typed to the nearest legal value — type 20 on a
   * Seedance project, watch it become 15, get told nothing. An editor read
   * that as "the app accepted 20 seconds" and only found out at render time
   * that it hadn't. A picker can only ever produce a legal value, so there
   * is nothing left to correct behind the operator's back. And a discrete
   * choice is deliberate in a way typing isn't: waiting DEBOUNCE_MS to save
   * a click only delays the confirmation.
   */
  function handleDurationChange(scene: SceneRow, raw: string): void {
    const durationS = Number(raw);
    if (Number.isNaN(durationS)) return;

    const key = `${scene.id}:duration_s`;
    setFieldState(key, "saving");
    // A pending debounce from this row's earlier life as a text field can
    // still be in flight; drop it rather than let it land on top of this.
    const existing = timers.current.get(key);
    if (existing) clearTimeout(existing);

    startTransition(async () => {
      applyOptimistic({ type: "patch", id: scene.id, patch: { duration_s: durationS } });
      try {
        const result = await updateSceneDuration(scene.id, durationS);
        if (result?.error) {
          setFieldState(key, "error");
          toast.error(result.error);
          return;
        }
        setFieldState(key, "saved");
      } catch (err) {
        setFieldState(key, "error");
        toast.error(err instanceof Error ? err.message : "Failed to update duration.");
      }
    });
  }

  function handleDelete(sceneId: string, sceneIdx: number): void {
    // Before the optimistic removal, not after: deleteScene only ever takes a
    // draft or frame_ready scene (nothing rendered, nothing to lose but the
    // typing), but a cancelled confirm still has to leave the row on screen.
    // Guarding after applyOptimistic would have removed it regardless of the
    // answer.
    if (!window.confirm(`Delete scene ${sceneIdx + 1}? Everything typed on it goes with it.`)) {
      return;
    }
    startTransition(async () => {
      applyOptimistic({ type: "remove", id: sceneId });
      try {
        const result = await deleteScene(sceneId);
        if (result?.error) toast.error(result.error);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to delete scene.");
      }
    });
  }

  function handleApply(sceneId: string): void {
    setPendingSceneAction((prev) => ({ ...prev, [sceneId]: true }));
    startTransition(async () => {
      try {
        const result = await applyScenePrompt(sceneId);
        if (result?.error) {
          toast.error(result.error);
        } else {
          // Says what happened to the previous text, not just that
          // something happened. "Prompt regenerated" reads as additive.
          toast.success("Prompt rewritten from scratch.");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to generate a prompt.");
      } finally {
        setPendingSceneAction((prev) => ({ ...prev, [sceneId]: false }));
      }
    });
  }

  function handleSplit(sceneId: string): void {
    setPendingSceneAction((prev) => ({ ...prev, [sceneId]: true }));
    startTransition(async () => {
      try {
        const result = await splitScene(sceneId);
        if (result?.error) toast.error(result.error);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to split scene.");
      } finally {
        setPendingSceneAction((prev) => ({ ...prev, [sceneId]: false }));
      }
    });
  }

  function handleAdd(afterIdx: number | null): void {
    startTransition(async () => {
      try {
        const result = await addScene(projectId, afterIdx);
        if (result?.error) toast.error(result.error);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add scene.");
      }
    });
  }

  // True once every scene has left draft/frame_ready — i.e. render money is
  // committed and actions/brief.ts's assertEditable would refuse every
  // mutation below. Drives both the top-of-table notice and each row's
  // read-only rendering, so the UI stops offering an ability the server
  // already denies instead of letting the operator type into a field and
  // only finding out from an error toast.
  const allLocked = scenes.length > 0 && scenes.every((scene) => !isEditable(scene.status));

  return (
    <div className="flex flex-col gap-4">
      <CostBadge scenes={scenes} audioEnabled={audioEnabled} renderSettings={renderSettings} />

      {allLocked && (
        <p className="text-sm text-muted-foreground">
          Rendering has started on every scene, so this brief is locked — it&apos;s now the record
          of what was actually produced, not an editable draft.
        </p>
      )}

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead className="w-64">Script line</TableHead>
              <TableHead>Video prompt</TableHead>
              <TableHead className="w-28">Roll</TableHead>
              <TableHead className="w-20">Sec</TableHead>
              <TableHead className="w-24" />
              <TableHead className="w-20" />
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {scenes.map((scene) => {
              // Content-editability: the fields and per-scene buttons in this row
              // are refused only while the worker owns the scene. The
              // money-boundary predicate (isEditable) is a different question and
              // is not what gates a textarea.
              const editable = isSceneContentEditable(scene.status);
              // Server-side editability ANDed with the viewer's own
              // read-only status — see the `readOnly` prop doc comment
              // above. `editable` alone still governs the informational
              // badge/plain-text fallbacks a locked-but-owned row shows;
              // `canEdit` is what actually gates rendering a control that
              // submits a write.
              const canEdit = editable && !readOnly;
              return (
                // id, not just key: the Deliver page's "Fix the prompt"
                // control (scene-fix-prompt-dialog.tsx) navigates here with
                // a `#scene-<id>` fragment so the operator lands on the
                // exact row it unlocked, not the top of a ~30-row table.
                <TableRow key={scene.id} id={`scene-${scene.id}`}>
                  <TableCell className="align-top text-muted-foreground">{scene.idx + 1}</TableCell>
                  <TableCell className="align-top">
                    <Textarea
                      defaultValue={scene.script_line ?? ""}
                      onChange={(e) => scheduleTextSave(scene.id, "script_line", e.target.value)}
                      disabled={!canEdit}
                      className="min-h-16"
                      // Named per ROW, not just per column: the column
                      // header is not a label, and thirty fields all called
                      // "Script line" are as good as unnamed to anyone
                      // moving through them by keyboard or screen reader.
                      aria-label={`Script line for scene ${scene.idx + 1}`}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-col gap-1">
                      <Textarea
                        defaultValue={scene.video_prompt ?? ""}
                        onChange={(e) => scheduleTextSave(scene.id, "video_prompt", e.target.value)}
                        disabled={!canEdit}
                        className="min-h-24"
                        aria-label={`Video prompt for scene ${scene.idx + 1}`}
                      />
                      <div className="flex items-center gap-2">
                        {scene.edited_by_human && <Badge variant="secondary">edited</Badge>}
                        <SaveIndicator state={saveStates[`${scene.id}:video_prompt`]} />
                      </div>
                      {canEdit && (
                        <PendingButton
                          type="button"
                          variant="outline"
                          size="sm"
                          className="self-start"
                          pending={pendingSceneAction[scene.id]}
                          disabled={!scene.script_line?.trim()}
                          onClick={() => handleApply(scene.id)}
                          // Named for what it does, per the design's own note
                          // on this control. applyScenePrompt (actions/brief.ts)
                          // overwrites video_prompt wholesale and sets
                          // edited_by_human back to false -- there is no merge
                          // and no guard. "Apply" does not say that, and an
                          // operator lost a hand-edited prompt to it.
                          title={
                            scene.edited_by_human
                              ? "Rewrites this prompt from scratch and discards your edit."
                              : undefined
                          }
                        >
                          {`Rewrite with AI (${formatUsd(applySceneCostUsd)})`}
                        </PendingButton>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    {/* Rewrite with AI and Split are both paid Claude calls
                        on THIS scene, and both are slow enough to walk away
                        from. pendingSceneAction is already the per-scene
                        flag both of them set, so the row in the rail can say
                        the same thing the button does — from wherever the
                        operator has gone. */}
                    <RailBusyWhile
                      entryId={scene.id}
                      active={pendingSceneAction[scene.id] === true}
                    />
                    {canEdit ? (
                      <RollToggle
                        isTalkingHead={scene.is_talking_head}
                        onChange={() => handleToggle(scene)}
                      />
                    ) : (
                      <Badge variant={scene.is_talking_head ? "default" : "secondary"}>
                        {scene.is_talking_head ? "A-roll" : "B-roll"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {canEdit ? (
                      <DurationPicker
                        durationS={scene.duration_s}
                        allowedDurationsS={allowedDurationsS}
                        modelLabel={modelLabel}
                        onChange={(value) => handleDurationChange(scene, value)}
                      />
                    ) : (
                      <span
                        className={cn(
                          "text-sm tabular-nums",
                          allowedDurationsS.includes(scene.duration_s)
                            ? "text-muted-foreground"
                            : "font-medium text-amber-600 dark:text-amber-500",
                        )}
                        title={
                          allowedDurationsS.includes(scene.duration_s)
                            ? undefined
                            : `${modelLabel} will not accept ${scene.duration_s}s.`
                        }
                      >
                        {scene.duration_s}s
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {canEdit && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleAdd(scene.idx)}
                      >
                        + row
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {canEdit && (
                      <PendingButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        pending={pendingSceneAction[scene.id]}
                        disabled={!scene.script_line?.trim()}
                        onClick={() => handleSplit(scene.id)}
                        title={`Splits this scene into two, generating a fresh prompt for each half (${formatUsd(2 * applySceneCostUsd)})`}
                      >
                        Split
                      </PendingButton>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {/* Draft/frame_ready only, narrower than canEdit. That
                        predicate widened to include rendered scenes
                        (lib/editable-guard.ts) because everything else it
                        gates can be re-done by spending again; deleting the
                        scene takes its clips and versions with it and
                        cannot. deleteScene enforces the same, tighter rule
                        server-side. */}
                    {canEdit && (scene.status === "draft" || scene.status === "frame_ready") ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(scene.id, scene.idx)}
                      >
                        Delete
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {!readOnly && scenes.length === 0 && (
        <Button type="button" variant="outline" onClick={() => handleAdd(null)}>
          + Add scene
        </Button>
      )}
    </div>
  );
}
