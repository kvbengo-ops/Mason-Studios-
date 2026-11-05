"use client";

// Settings' Direction + Captions fields — project-wide defaults, not part
// of any of the three split Setup pages (see actions/setup.ts's header on
// why the write had to split by page, and this feature's task on why
// Direction/Captions specifically belong here instead: they're project-wide
// defaults, same category as render settings, not something Character,
// Product or Script individually own).
//
// Settings has no OTHER real <form>s interleaved with these fields today
// (unlike Character/Product/Script, which interleave upload/remove/
// regenerate forms with their field groups) — RenderSettingsForm and the
// Title field below are siblings, not nested inside this one. The
// empty-form + `form="…"` attribute pattern is used anyway, for the same
// reason character-setup-form.tsx's original single-page version used it:
// a shared `dirty`/pending Context is what lets a Save button, an unsaved-
// changes notice and a nav-away guard all agree on one bit of truth, and
// createSetupForm (components/setup-form.tsx) is the one place that logic
// lives now — reimplementing a parallel, form-attribute-free version here
// just to skip a pattern that costs nothing extra when unused would be a
// second copy of that logic for no benefit.

import { useState, type JSX } from "react";
import { createSetupForm } from "@/components/setup-form";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UGC_STYLES, type ProjectDirection } from "@/lib/direction";
import { HEX_COLOR_RE, isLowContrast, type CaptionStyle } from "@/lib/caption-style";
import type { SHOOTING_MODES } from "@/lib/direction";
import { cn } from "@/lib/utils";

const {
  formId: DIRECTION_SETUP_FORM_ID,
  SetupForm: DirectionSetupForm,
  useSetupFormState: useDirectionSetupState,
  SaveButton,
} = createSetupForm("direction-caption-form");

export { DirectionSetupForm, SaveButton };

const UGC_STYLE_LABELS: Record<(typeof UGC_STYLES)[number], string> = {
  auto: "Auto",
  talking_head: "Talking head",
  voiceover: "Voiceover",
  b_roll: "B-roll",
  testimonial: "Testimonial",
  unboxing: "Unboxing",
};

// Verbatim from spec §3.1's Shooting Mode table.
const SHOOTING_MODE_OPTIONS: readonly {
  value: (typeof SHOOTING_MODES)[number];
  emoji: string;
  label: string;
  description: string;
}[] = [
  {
    value: "selfie",
    emoji: "🤳",
    label: "Selfie",
    description: "Front camera, handheld w/ shake, direct eye contact",
  },
  {
    value: "static",
    emoji: "📱",
    label: "Static",
    description: "Propped phone, both hands free, stable",
  },
  {
    value: "mirror",
    emoji: "🪞",
    label: "Mirror Selfie",
    description: "Handheld rear cam pointed at mirror, phone visible in shot, shake always on",
  },
];

export function ShootingModeFields({
  initialDirection,
  locked,
}: {
  initialDirection: ProjectDirection;
  locked: boolean;
}): JSX.Element {
  const { pending, markDirty } = useDirectionSetupState();
  const disabled = locked || pending;

  const [shootingMode, setShootingMode] = useState(initialDirection.shooting_mode);
  const savedMode = initialDirection.shooting_mode;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {SHOOTING_MODE_OPTIONS.map((option) => {
          const selected = shootingMode === option.value;
          const isSavedOption = savedMode === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                "flex flex-col gap-1 rounded-md border p-3 text-sm transition-colors",
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted/50",
                selected && !disabled && "border-primary bg-primary/5",
                selected && disabled && "border-primary/60",
              )}
            >
              <input
                type="radio"
                name="shooting_mode"
                form={DIRECTION_SETUP_FORM_ID}
                value={option.value}
                checked={selected}
                disabled={disabled}
                onChange={() => {
                  setShootingMode(option.value);
                  markDirty();
                }}
                className="sr-only"
              />
              <span className="flex items-center justify-between gap-2 font-medium text-foreground">
                <span>
                  {option.emoji} {option.label}
                </span>
                {isSavedOption ? (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                    Saved
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </label>
          );
        })}
      </div>

      {/* Spec §3.1: conditional on Static mode; not rendered under Selfie —
          see the original character-setup-form.tsx history for the full
          reasoning (unmounting, not disabling, is what keeps an unsaved
          switch away from Static submitting no camera_movement entry at
          all). */}
      {shootingMode === "static" ? (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="camera_movement"
            name="camera_movement"
            form={DIRECTION_SETUP_FORM_ID}
            defaultChecked={initialDirection.camera_movement}
            disabled={disabled}
            onChange={markDirty}
            className="size-4 rounded border-input"
          />
          <Label htmlFor="camera_movement" className="font-normal">
            Add camera movement — forces handheld shake and overrides the static/propped framing
            this mode would otherwise produce
          </Label>
        </div>
      ) : null}
    </div>
  );
}

export function DirectionDetailFields({
  initialDirection,
  locked,
}: {
  initialDirection: ProjectDirection;
  locked: boolean;
}): JSX.Element {
  const { pending, markDirty } = useDirectionSetupState();
  const disabled = locked || pending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="visual_idea">Visual idea (optional)</Label>
        <Textarea
          id="visual_idea"
          name="visual_idea"
          form={DIRECTION_SETUP_FORM_ID}
          rows={3}
          defaultValue={initialDirection.visual_idea}
          disabled={disabled}
          readOnly={locked}
          onChange={markDirty}
          placeholder="Lock the camera position completely. Absolutely zero zoom, zero panning… static at this exact wide distance for the entire video."
        />
        <p className="text-xs text-muted-foreground">
          A global directorial override applied to every scene, taking precedence over the default
          camera guidance for the chosen shooting mode.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="voice_profile">Voice profile (optional)</Label>
        <Input
          id="voice_profile"
          name="voice_profile"
          form={DIRECTION_SETUP_FORM_ID}
          defaultValue={initialDirection.voice_profile}
          disabled={disabled}
          readOnly={locked}
          onChange={markDirty}
          placeholder="warm, inspiring"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pronunciation_guide">Pronunciation guide (optional)</Label>
        <Textarea
          id="pronunciation_guide"
          name="pronunciation_guide"
          form={DIRECTION_SETUP_FORM_ID}
          rows={3}
          defaultValue={initialDirection.pronunciation_guide}
          disabled={disabled}
          readOnly={locked}
          onChange={markDirty}
          placeholder={"One word per line, e.g.\nSeranova → seh-rah-NOH-vah"}
        />
        <p className="text-xs text-muted-foreground">
          The phonetic is appended in brackets after a guided word&rsquo;s first occurrence in each
          scene&rsquo;s dialogue.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="ugc_style">UGC style</Label>
        <Select
          name="ugc_style"
          form={DIRECTION_SETUP_FORM_ID}
          defaultValue={initialDirection.ugc_style}
          disabled={disabled}
          onValueChange={markDirty}
        >
          <SelectTrigger id="ugc_style" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UGC_STYLES.map((style) => (
              <SelectItem key={style} value={style}>
                {UGC_STYLE_LABELS[style]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * One caption colour: a native swatch picker and a hex field, both editing
 * the same value. See the original character-setup-form.tsx history for the
 * full two-input reasoning.
 */
function CaptionColorField({
  id,
  label,
  value,
  onChange,
  hint,
  locked,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint: string;
  locked: boolean;
  disabled: boolean;
}): JSX.Element {
  const valid = HEX_COLOR_RE.test(value);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-hidden="true"
          tabIndex={-1}
          value={valid ? value : "#000000"}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          disabled={disabled}
          className="size-9 shrink-0 cursor-pointer rounded border border-input bg-transparent disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Input
          id={id}
          name={id}
          form={DIRECTION_SETUP_FORM_ID}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          readOnly={locked}
          placeholder="#730BF9"
          spellCheck={false}
          className="font-mono"
        />
      </div>
      {!valid ? (
        <p className="text-xs text-destructive">
          Use a 6-digit hex colour like #730BF9 — shorthand such as #FFF is not accepted.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/**
 * Per-project caption settings (0049): the on/off opt-out and the two
 * colours. These are ANDed with the worker's CAPTIONS_ENABLED env var,
 * which stays the global kill-switch.
 */
export function CaptionStyleFields({
  initialStyle,
  locked,
}: {
  initialStyle: CaptionStyle;
  locked: boolean;
}): JSX.Element {
  const { pending, markDirty } = useDirectionSetupState();
  const [enabled, setEnabled] = useState(initialStyle.captions_enabled);
  const [boxColor, setBoxColor] = useState(initialStyle.caption_box_color);
  const [textColor, setTextColor] = useState(initialStyle.caption_text_color);
  const disabled = locked || pending;

  const lowContrast = isLowContrast(textColor, boxColor);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="captions_enabled"
          name="captions_enabled"
          form={DIRECTION_SETUP_FORM_ID}
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            markDirty();
          }}
          disabled={disabled}
          className="size-4 rounded border-input"
        />
        <Label htmlFor="captions_enabled" className="font-normal">
          Burn word-synced captions into this project&rsquo;s final video
        </Label>
      </div>

      {enabled ? (
        <>
          <CaptionColorField
            id="caption_box_color"
            label="Highlight colour"
            value={boxColor}
            onChange={(next) => {
              setBoxColor(next);
              markDirty();
            }}
            hint="The box drawn behind the word currently being spoken."
            locked={locked}
            disabled={disabled}
          />
          <CaptionColorField
            id="caption_text_color"
            label="Caption text colour"
            value={textColor}
            onChange={(next) => {
              setTextColor(next);
              markDirty();
            }}
            hint="Caption text keeps a near-black outline behind it, which is not configurable — it is what holds the words off the video."
            locked={locked}
            disabled={disabled}
          />
          {lowContrast ? (
            <p className="text-xs text-muted-foreground">
              These two colours are close in brightness, so highlighted words may be hard to read.
              Saving is still allowed — the text&rsquo;s outline keeps them legible in most cases.
            </p>
          ) : null}
        </>
      ) : (
        <>
          {/* Hidden inputs keep the save a genuine no-op for the two fields
              the operator cannot see while captions are off — see the
              original character-setup-form.tsx history for why unmounting
              them outright would overwrite a chosen colour with the shipped
              default. */}
          <input
            type="hidden"
            name="caption_box_color"
            form={DIRECTION_SETUP_FORM_ID}
            value={boxColor}
          />
          <input
            type="hidden"
            name="caption_text_color"
            form={DIRECTION_SETUP_FORM_ID}
            value={textColor}
          />
          <p className="text-xs text-muted-foreground">
            Captions are off for this project. The final video is delivered without them; the
            colours you picked are kept for if you turn them back on.
          </p>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Captions also have to be enabled for the workspace as a whole. This setting can only turn
        them off for this project, never on when the workspace has them off.
      </p>
    </div>
  );
}
