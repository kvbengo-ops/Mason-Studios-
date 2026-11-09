"use client";

// The /ugc prompt field, with @tag awareness layered on top of a plain
// textarea.
//
// A textarea has no per-word hover targets and no native way to highlight
// one substring differently from the rest, so this draws a SECOND element —
// an invisible-text mirror — positioned exactly on top of the real
// `<textarea>`. Both share the identical font, size, line-height, padding
// and border (MIRROR_BOX below); the mirror's own text is fully transparent
// everywhere except inside a "@name" token, where a background/underline is
// painted on. Because the mirror's non-tag area is `pointer-events-none`,
// every click and keystroke falls straight through to the real textarea
// underneath — the mirror only ever intercepts the pointer exactly where a
// tag span opts back in with `pointer-events-auto`, which is what lets
// hovering a tag show a preview without breaking normal typing anywhere
// else in the field.
//
// SIZING IS FIXED-HEIGHT PLUS INTERNAL SCROLLING, and both layers have to
// agree about that.
//
// This comment used to describe the opposite — the textarea grew with its own
// text via `field-sizing-content`, the mirror was positioned top/left/right
// with no `bottom`, and both ended up the same height because they render the
// same string in the same box. Then the textarea was changed to fill its flex
// section (`min-h-40 flex-1`) so the Generate button would stay reachable,
// and the mirror was not changed with it.
//
// The result was a layer with no bottom edge inside a scrolling column: an
// absolutely positioned box still extends its scroll container's scrollable
// area, so a long prompt grew a tall region of invisible transparent text
// BELOW the button — a thousand pixels of blank page on a 5,750-character
// prompt, with a scrollbar to match. The highlights also drifted out of
// register the moment the textarea scrolled, because the mirror could not.
//
// So the mirror is now bounded to the same box (inset-0) and its scrollTop is
// driven from the textarea's. The cost is the one the old note named: a tag's
// hover preview opens upward and is clipped for tags on the first line or
// two. That is a hover nicety; a page that scrolls into nothing is not.
//
// An unknown tag (no element of that name) is styled as visibly a miss —
// per the standing rule, a typo costs exactly what a real reference costs,
// so it must not look like one at a glance.

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
// A NOTE, NOT A PLAY TRIANGLE. Neither of these is a control — they mark
// a row and a hover card as "this reference is a sound" — and a triangle
// invites a press that does nothing here. The picker was moved off it for
// the same reason.
import { createPortal } from "react-dom";
import { MusicIcon, Redo2Icon, Undo2Icon, VideoIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  activeTagQuery,
  matchElementsByPrefix,
  splitPromptIntoTagSegments,
  type ElementTag,
  type PromptTagSegment,
} from "@/lib/elements";
import { tagSuggestAnchor, type TagSuggestAnchor } from "@/lib/tag-suggest-anchor";

/** The suggestion menu's box, in px, so the flip/clamp math and the CSS agree. */
const MENU_WIDTH = 240;
const MENU_MAX_HEIGHT = 208;

/**
 * Disabled rather than hidden when there is nothing to undo.
 *
 * A control that vanishes takes its own position with it, so the one beside
 * it moves under the cursor that was reaching for it — and an operator who
 * has never seen these cannot learn they exist from an empty corner.
 */
const HISTORY_BUTTON =
  "grid size-7 place-items-center rounded-md border bg-background/80 text-muted-foreground " +
  "backdrop-blur transition-colors hover:bg-muted hover:text-foreground " +
  "disabled:pointer-events-none disabled:opacity-40 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** One snapshot of the box: the text, and where the caret was in it. */
interface PromptSnapshot {
  value: string;
  cursor: number;
}

/**
 * A prompt is a paragraph, not a document, and every step holds a full copy
 * of it. Fifty is far more than anyone walks back and still nothing next to
 * what the page already carries.
 */
const MAX_HISTORY_STEPS = 50;

/**
 * The caret marker. Zero width so it cannot move a single glyph of the text it
 * sits in, and inline-block rather than an empty inline span (which has no box
 * at all) or a zero-width space (which is a line-break opportunity, and would
 * let the mirror wrap where the textarea does not).
 */
const MARKER = "inline-block h-[1em] w-0 align-baseline";

/**
 * Every box-affecting property BOTH layers must share pixel-for-pixel:
 * width, font, size, line-height, padding, border-width, and the wrapping
 * rules (textareas wrap like `pre-wrap` + word-breaking by default — the
 * mirror has to say so explicitly, since a plain `<div>` does not). Colour
 * is deliberately absent here — the two layers disagree about that on
 * purpose, see the two call sites below.
 */
// no-scrollbar is load-bearing, not polish.
//
// The textarea scrolls internally and therefore carried a scrollbar; the
// mirror is overflow-hidden and never did. That made their CONTENT boxes
// different widths, so the same string wrapped at different points, and every
// highlight after the first wrap drifted further from the word it marks —
// "@lena_ref1" painted over "s. @lena_r" three characters to its left.
//
// That was first fixed by reserving the gutter on both (scrollbar-gutter:
// stable), which kept them equal but left a permanent grey track down the
// field. Not drawing the bar at all is the same equality with nothing to look
// at, so the two layers still agree at any prompt length.
//
// The cost is the one no-scrollbar's own note names: the bar is the only cue
// that there is more text below, and a wall of prose does not show its own
// overflow the way a cut-off card does. It is acceptable HERE and only here
// because this is a field being typed in, not a panel being read — the caret
// is inside the text and every keystroke scrolls it into view.
const MIRROR_BOX =
  "no-scrollbar w-full whitespace-pre-wrap break-words rounded-md border px-3 py-2 font-mono text-xs leading-relaxed";

export interface UgcPromptEditorProps {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  /** The operator's own saved references — resolved server-side, signed URLs and all. Empty is a normal state (nobody has saved one yet). */
  elements: readonly ElementTag[];
  placeholder?: string;
  /** Live "n / max" counter under the box; red once n passes max. Omit to hide it. */
  charCount?: number;
  maxChars?: number;
  /**
   * What the history belongs to — the scene id.
   *
   * UNDO MUST NOT CROSS A SCENE. Picking another scene replaces the whole
   * box, and an Undo that reached past that boundary would paste one
   * scene's prompt into another with nothing on screen explaining where the
   * text came from. Changing this clears both stacks.
   */
  historyKey?: string;
  /**
   * Extra classes for the textarea box itself.
   *
   * The default is a tall writing area (min-h-40), which is right for the
   * /ugc column and wrong for the compact prompt bar on /image-generator.
   *
   * HEIGHT AND COLOUR ONLY — NEVER TEXT METRICS. The mirror above the
   * textarea is a second copy of the same string, and the highlights land on
   * the right characters only because both layers are laid out identically
   * (MIRROR_BOX: px-3 py-2 font-mono text-xs leading-relaxed). The mirror is
   * absolutely positioned at inset-0, so height follows for free — but
   * padding, font-family, font-size, line-height or border WIDTH passed here
   * change one layer and not the other, and every tag then renders twice,
   * visibly out of register. That is exactly the bug this note exists to stop
   * happening a second time: `px-2 text-sm` here painted "@jungle2" on top of
   * itself, four pixels and one font-size apart.
   */
  textareaClassName?: string;
  /**
   * Box metrics applied to BOTH layers — the place for padding that clears
   * an overlaid button (the bars' `pr-32` under Generate). On the textarea
   * alone it narrowed only that layer's wrap width, so every tag past the
   * first wrap painted a few characters off its own word.
   */
  boxClassName?: string;
  /** Disables prompt action buttons for read-only scenes. */
  controlsDisabled?: boolean;
}

/**
 * The mirror's children, with a zero-width marker spliced in at `markerAt` —
 * the index of the '@' the caret is inside, or null when it is inside none.
 *
 * The marker is what the suggestion menu is positioned from. It has to be
 * placed by character offset rather than by segment, because the tag being
 * typed is only sometimes a segment of its own: "@lena_ref1" matches the tag
 * pattern and gets a TagSpan, but "@" alone and "@zz" (mid-word, no element)
 * fall inside a plain text run, and those are exactly the moments the menu is
 * most useful.
 */
function renderMirror(
  segments: readonly PromptTagSegment[],
  markerAt: number | null,
  markerRef: React.RefObject<HTMLSpanElement | null>,
  onPreview: (preview: TagPreviewAt | null) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  let offset = 0;
  // Index as key: segments are fully re-derived from `value` on every render
  // (splitPromptIntoTagSegments), never reordered or patched in place, so the
  // index is stable for the render it belongs to.
  segments.forEach((segment, i) => {
    const end = offset + segment.text.length;
    // A tag segment is never split: the marker only ever lands on the '@' that
    // starts one, which is this segment's own start.
    if (markerAt !== null && markerAt >= offset && markerAt < end && !segment.tag) {
      const cut = markerAt - offset;
      out.push(<span key={`${i}a`}>{segment.text.slice(0, cut)}</span>);
      out.push(<span key={`${i}m`} ref={markerRef} className={MARKER} />);
      out.push(<span key={`${i}b`}>{segment.text.slice(cut)}</span>);
    } else {
      if (markerAt === offset) out.push(<span key={`${i}m`} ref={markerRef} className={MARKER} />);
      out.push(
        segment.tag ? (
          <TagSpan
            key={i}
            index={i}
            name={segment.tag.name}
            element={segment.tag.element}
            onPreview={onPreview}
          />
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      );
    }
    offset = end;
  });
  // The '@' can also be the very last character, past every segment's end when
  // the pattern did not match it.
  if (markerAt !== null && markerAt >= offset)
    out.push(<span key="m" ref={markerRef} className={MARKER} />);
  return out;
}

/**
 * The editor's line height in px. getComputedStyle resolves `leading-relaxed`
 * to a px value in a real browser, but returns the literal "normal" when no
 * layout has happened (and in jsdom), so the marker's own em box is the
 * fallback — a little short, which puts the menu slightly high rather than
 * over the text.
 */
function lineHeightOf(mirror: HTMLElement, marker: HTMLElement): number {
  const parsed = Number.parseFloat(getComputedStyle(mirror).lineHeight);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : marker.offsetHeight;
}

export function UgcPromptEditor({
  id,
  name,
  value,
  onChange,
  elements,
  placeholder,
  charCount,
  maxChars,
  historyKey,
  textareaClassName,
  boxClassName,
  controlsDisabled = false,
}: UgcPromptEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<TagSuggestAnchor | null>(null);
  // Bumped on scroll so the menu re-anchors while the text moves under it.
  // Only while the menu is open — otherwise this would re-render the editor on
  // every scroll event for nothing.
  const [scrollTick, setScrollTick] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [focused, setFocused] = useState(false);

  /**
   * UNDO IS OURS HERE, not the browser's.
   *
   * A textarea already has native undo, and it works for typing — but it
   * breaks the moment anything writes the value programmatically, which is
   * what picking a tag from the suggestion menu does. So the one edit an
   * operator most wants to take back is the one native undo cannot.
   *
   * Snapshots hold the caret as well as the text: restoring the words and
   * leaving the caret at the end turns an undo into a second thing to fix.
   */
  const [past, setPast] = useState<readonly PromptSnapshot[]>([]);
  const [future, setFuture] = useState<readonly PromptSnapshot[]>([]);
  /**
   * Whether the edit before this one was a keystroke, so a run of typing
   * collapses into one step instead of one per character — an Undo that
   * removes a single letter is an Undo nobody presses twenty times.
   *
   * A RUN, NOT A STOPWATCH. This was a 700ms window, which meant reading the
   * clock inside a function React's compiler cannot prove runs in an event
   * handler; it also drew the step boundary where an operator paused rather
   * than where they did something different. The run ends on anything that
   * is not another keystroke — a tag insertion, a paste, a click that moves
   * the caret, leaving the box — which is the boundary they would draw
   * themselves.
   */
  const lastEditWasTypingRef = useRef(false);

  // CLEARED DURING RENDER, not in an effect. React's own answer for "reset
  // state when a prop changes" is to compare it against a copy held in state
  // and set both on the spot: an effect would paint one frame with the new
  // scene's text and the old scene's history still offered.
  const [historyOwner, setHistoryOwner] = useState(historyKey);
  if (historyOwner !== historyKey) {
    setHistoryOwner(historyKey);
    setPast([]);
    setFuture([]);
  }

  const segments = useMemo(() => splitPromptIntoTagSegments(value, elements), [value, elements]);
  // The tag whose card is showing. Found by pointer position on the TEXTAREA
  // (previewAtPoint), because the mirror's tags sit underneath it and never
  // receive the mouse; or by a tag taking keyboard focus.
  const [preview, setPreview] = useState<TagPreviewAt | null>(null);
  const previewTag = preview ? segments[preview.index]?.tag : undefined;

  const query = activeTagQuery(value, cursor);
  const suggestions = query ? matchElementsByPrefix(elements, query.query) : [];
  const showSuggestions = focused && query !== null && suggestions.length > 0;

  // Measure after the DOM holds this render's marker, before the browser
  // paints — a plain effect would show the menu at the previous tag's spot for
  // one frame every time the caret moves to another tag.
  useLayoutEffect(() => {
    const marker = markerRef.current;
    const mirror = mirrorRef.current;
    if (!showSuggestions || !marker || !mirror) {
      setAnchor(null);
      return;
    }
    setAnchor(
      tagSuggestAnchor({
        // The mirror is the marker's offsetParent (it is absolutely
        // positioned) and covers the editor box exactly, so mirror-relative
        // offsets are already the coordinates the menu is placed in.
        caretTop: marker.offsetTop,
        caretLeft: marker.offsetLeft,
        // The line's height, read off the mirror rather than the marker: the
        // marker is one em tall by construction, and a line box is taller.
        caretHeight: lineHeightOf(mirror, marker),
        scrollTop: mirror.scrollTop,
        boxWidth: mirror.clientWidth,
        boxHeight: mirror.clientHeight,
        menuWidth: MENU_WIDTH,
        menuHeight: Math.min(MENU_MAX_HEIGHT, suggestions.length * 34 + 8),
      }),
    );
  }, [showSuggestions, value, cursor, suggestions.length, scrollTick]);

  function syncCursorFrom(el: HTMLTextAreaElement): void {
    setCursor(el.selectionStart ?? el.value.length);
  }

  /**
   * Records the state being replaced, and drops the redo stack.
   *
   * `coalesce` is false for the edits that are worth their own step however
   * fast they arrive — a tag insertion, a paste — and true for typing, where
   * TYPING_COALESCE_MS of continuous keys becomes one.
   */
  function pushHistory(replaced: PromptSnapshot, coalesce: boolean): void {
    if (coalesce && lastEditWasTypingRef.current && past.length > 0) {
      // Mid-run: the step already on the stack still describes where this
      // run of typing started, which is the state to go back to.
      setFuture([]);
      return;
    }
    lastEditWasTypingRef.current = coalesce;
    setPast((old) => [...old, replaced].slice(-MAX_HISTORY_STEPS));
    // A NEW EDIT ENDS THE REDO PATH. Keeping it would let Redo jump to text
    // that never followed what is now on screen.
    setFuture([]);
  }

  /** Ends the current run of typing, so the next keystroke starts a step. */
  function endTypingRun(): void {
    lastEditWasTypingRef.current = false;
  }

  /** Puts a snapshot back on screen, caret included. */
  function restore(snapshot: PromptSnapshot): void {
    onChange(snapshot.value);
    setCursor(snapshot.cursor);
    endTypingRun();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(snapshot.cursor, snapshot.cursor);
    });
  }

  function undo(): void {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast((old) => old.slice(0, -1));
    setFuture((old) => [{ value, cursor }, ...old].slice(0, MAX_HISTORY_STEPS));
    restore(previous);
  }

  function redo(): void {
    const next = future[0];
    if (!next) return;
    setFuture((old) => old.slice(1));
    setPast((old) => [...old, { value, cursor }].slice(-MAX_HISTORY_STEPS));
    restore(next);
  }

  function clearPrompt(): void {
    if (!value) return;
    pushHistory({ value, cursor }, false);
    onChange("");
    setCursor(0);
  }

  function insertSuggestion(picked: ElementTag): void {
    if (!query) return;
    const before = value.slice(0, query.start);
    const after = value.slice(cursor);
    const inserted = `@${picked.name} `;
    // Its own step, never coalesced: this is the edit native undo cannot
    // reach, and it is the reason this history exists.
    pushHistory({ value, cursor }, false);
    onChange(`${before}${inserted}${after}`);
    const nextCursor = before.length + inserted.length;
    setCursor(nextCursor);
    setActiveSuggestion(0);
    // The caret move has to land AFTER React commits the new `value` prop
    // back into the (controlled) textarea — setting selectionRange
    // synchronously here would be racing the DOM write React is about to
    // do and lose.
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestion((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestion((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertSuggestion(suggestions[activeSuggestion] ?? suggestions[0]!);
    }
  }

  // mousedown + preventDefault, not onClick: a click fires after the
  // browser has already moved focus (and fired the textarea's onBlur),
  // which would have already collapsed `query` to null and hidden this
  // list out from under the click. Preventing the default on mousedown
  // stops that focus shift from happening at all, so the textarea never
  // blurs and the insert lands against the query that was on screen when
  // the operator clicked it.
  function handleSuggestionMouseDown(
    e: ReactMouseEvent<HTMLButtonElement>,
    picked: ElementTag,
  ): void {
    e.preventDefault();
    insertSuggestion(picked);
  }

  return (
    // NOT min-h-0 on either wrapper — see ugc-column.tsx's prompt <section>
    // for why: this editor's own min-h-40 textarea is the real floor, and
    // min-h-0 here would let these wrappers shrink past it and overflow
    // their own box instead of the outer column scrolling to fit it.
    <div className="relative flex flex-1 flex-col">
      <div className="relative flex flex-1 flex-col">
        {/* The mirror. aria-hidden: it exists purely to paint highlights and
            catch hover on a tag — the accessible content is the textarea
            below, whose value already contains the same "@name" text. */}
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className={cn(
            MIRROR_BOX,
            // inset-0, not inset-x-0 + top-0: the mirror gets the textarea's
            // box exactly, bottom edge included, so it cannot extend the
            // column's scroll area past what is actually on screen.
            // overflow-hidden clips it to that box; scrollTop below is what
            // keeps the highlights on their lines.
            "pointer-events-none absolute inset-0 overflow-hidden border-transparent text-transparent",
            boxClassName,
          )}
        >
          {renderMirror(segments, query?.start ?? null, markerRef, setPreview)}
          {/* A trailing space keeps the mirror's box exactly as tall as the
              textarea's when the value ends in a newline — without it a
              final blank line collapses to zero height on this side only. */}
          {value.endsWith("\n") ? " " : null}
        </div>

        <textarea
          ref={textareaRef}
          id={id}
          name={name}
          value={value}
          onChange={(e) => {
            // A jump of more than one character is a paste, a cut, or a
            // selection replaced — each worth its own step, however quickly it
            // followed the last keystroke.
            const typed = Math.abs(e.target.value.length - value.length) <= 1;
            pushHistory({ value, cursor }, typed);
            onChange(e.target.value);
            syncCursorFrom(e.target);
          }}
          onKeyUp={(e) => syncCursorFrom(e.currentTarget)}
          // The mirror has no scrollbar of its own — it is pointer-events-none
          // and clipped — so this is the only thing that moves it. Without it
          // every highlight stays pinned to the first screenful while the text
          // beneath it scrolls away.
          onMouseMove={(e) => {
            const next = previewAtPoint(mirrorRef.current, e.clientX, e.clientY);
            setPreview((current) => (current?.index === next?.index ? current : next));
          }}
          onMouseLeave={() => setPreview(null)}
          onScroll={(e) => {
            setPreview(null);
            if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
            if (showSuggestions) setScrollTick((t) => t + 1);
          }}
          onClick={(e) => {
            // A caret moved by hand ends the run: what is typed next belongs
            // somewhere else in the text and is its own step.
            endTypingRun();
            syncCursorFrom(e.currentTarget);
          }}
          onFocus={(e) => {
            setFocused(true);
            syncCursorFrom(e.currentTarget);
          }}
          onBlur={() => {
            endTypingRun();
            setFocused(false);
          }}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          placeholder={placeholder}
          rows={10}
          className={cn(
            MIRROR_BOX,
            // h-full, not field-sizing-content: the field now fills a flex
            // section rather than growing with its own text. The mirror above
            // is unaffected — it is absolutely positioned at top-0 with the
            // same width, padding and font, so the two agree on where every
            // line falls regardless of how tall the box itself is.
            "relative min-h-40 flex-1 resize-none border-input bg-transparent text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            textareaClassName,
            boxClassName,
          )}
        />
        {preview && previewTag && typeof document !== "undefined"
          ? createPortal(
              <TagPreviewCard
                name={previewTag.name}
                element={previewTag.element}
                rect={preview.rect}
              />,
              document.body,
            )
          : null}
      </div>

      {/* Keep editing controls outside the text and its highlight mirror. */}
      <div className="flex shrink-0 items-center justify-end gap-1 pt-1" role="group" aria-label="Edit history">
        {charCount !== undefined && maxChars !== undefined ? (
          <span
            data-testid="prompt-counter"
            className={cn(
              "mr-auto text-[10px] tabular-nums text-muted-foreground",
              charCount > maxChars && "font-medium text-destructive",
            )}
          >
            {charCount.toLocaleString()} / {maxChars.toLocaleString()}
          </span>
        ) : null}
        <button
          type="button"
          onClick={undo}
          disabled={controlsDisabled || past.length === 0}
          aria-label="Undo the last edit"
          title="Undo"
          className={HISTORY_BUTTON}
        >
          <Undo2Icon aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={controlsDisabled || future.length === 0}
          aria-label="Redo the edit that was undone"
          title="Redo"
          className={HISTORY_BUTTON}
        >
          <Redo2Icon aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={clearPrompt}
          disabled={controlsDisabled || !value}
          aria-label="Clear"
          title="Clear the prompt"
          className={HISTORY_BUTTON}
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {showSuggestions ? (
        <ul
          role="listbox"
          aria-label="Saved references"
          // Anchored under the tag being typed, not under the whole field,
          // and only as wide as MENU_WIDTH so it reads as attached to that
          // one word. Until the layout effect has measured, it is rendered
          // off-screen rather than at 0,0 — the marker cannot be measured
          // before it is in the DOM, and a menu that flashes in the top-left
          // corner first is worse than one that appears a frame later.
          style={{
            width: MENU_WIDTH,
            maxHeight: MENU_MAX_HEIGHT,
            top: anchor ? anchor.top : -9999,
            left: anchor ? anchor.left : -9999,
          }}
          className="absolute z-20 overflow-y-auto rounded-md border bg-popover p-1 text-xs shadow-md"
        >
          {suggestions.map((el, i) => (
            <li key={el.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeSuggestion}
                onMouseDown={(e) => handleSuggestionMouseDown(e, el)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left hover:bg-accent",
                  i === activeSuggestion && "bg-accent",
                )}
              >
                {/* A VOICE OR A VIDEO HAS NO THUMBNAIL HERE. Two more places
                    painted an MP3 into an <img> — this row and the hover
                    tooltip below — and both showed the browser's
                    broken-image glyph beside a perfectly good reference; a
                    video (0093) would fall into the same trap, and for the
                    same reason NOT rendered as a real <video> here — this
                    row is a small hover target inside a dropdown that
                    repaints on every keystroke, and fetching bytes for one
                    on each match would be a video download per letter
                    typed. Keyed off assetKind, which comes from assets.kind,
                    not off category, which a human can edit. */}
                {el.assetKind === "audio" ? (
                  <span
                    className="grid size-6 shrink-0 place-items-center rounded-sm border bg-muted/60"
                    aria-hidden="true"
                  >
                    <MusicIcon className="size-3.5 text-muted-foreground" />
                  </span>
                ) : el.assetKind === "video_ref" ? (
                  <span
                    className="grid size-6 shrink-0 place-items-center rounded-sm border bg-muted/60"
                    aria-hidden="true"
                  >
                    <VideoIcon className="size-3.5 text-muted-foreground" />
                  </span>
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={el.previewUrl}
                    alt=""
                    className="size-6 shrink-0 rounded-sm border object-cover"
                  />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-popover-foreground">@{el.name}</span>
                  <span className="truncate text-muted-foreground">{el.category}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Which tag's card is open, and where that tag sits on screen. */
interface TagPreviewAt {
  index: number;
  rect: DOMRect;
}

/**
 * The tag under a point, if any. The mirror's tag spans are hit-tested by
 * their own boxes (getClientRects: a tag can wrap onto two lines) rather than
 * by the pointer, which only ever reaches the textarea above them.
 */
function previewAtPoint(mirror: HTMLElement | null, x: number, y: number): TagPreviewAt | null {
  if (!mirror) return null;
  for (const span of mirror.querySelectorAll<HTMLElement>("[data-tag-index]")) {
    for (const rect of span.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { index: Number(span.dataset.tagIndex), rect };
      }
    }
  }
  return null;
}

/**
 * One "@name" token in the mirror layer: the highlight only. Its card renders
 * in a portal (TagPreviewCard); inside the mirror it was clipped by the
 * mirror's overflow-hidden.
 */
function TagSpan({
  index,
  name,
  element,
  onPreview,
}: {
  index: number;
  name: string;
  element: ElementTag | undefined;
  onPreview: (preview: TagPreviewAt | null) => void;
}): JSX.Element {
  const known = element !== undefined;
  return (
    <span
      tabIndex={0}
      data-tag-index={index}
      onFocus={(e) => onPreview({ index, rect: e.currentTarget.getBoundingClientRect() })}
      onBlur={() => onPreview(null)}
      aria-label={
        known
          ? `Reference: ${name}`
          : `Unknown reference: ${name} — this will render with nothing behind it`
      }
      className={cn(
        "relative rounded-[3px] pointer-events-auto outline-none",
        // BOLD WITHOUT font-weight, and the distinction is the whole point.
        //
        // The glyphs an operator reads belong to the TEXTAREA; this mirror
        // paints highlights in transparent text on top of it. A textarea
        // renders all of its text at one weight, so there is no way to embolden
        // one token in it — and `font-bold` here would widen this layer's boxes
        // while the textarea underneath kept its own, which is exactly the
        // misalignment that took three passes to get rid of.
        //
        // So the tag paints its own glyphs instead: same family, same weight,
        // same metrics, thickened by a shadow of itself. Nothing reflows,
        // because nothing about the layout changed — only the ink.
        "text-foreground [text-shadow:0_0_0.4px_currentColor,0_0_0.4px_currentColor]",
        known
          ? "bg-primary/25 underline decoration-primary decoration-2 underline-offset-2"
          : "bg-destructive/25 underline decoration-destructive decoration-wavy underline-offset-2",
      )}
    >
      @{name}
    </span>
  );
}

/** Room the card needs above a tag before it flips below it instead. */
const PREVIEW_CARD_ROOM_PX = 220;

/**
 * A tag's card, fixed to the viewport beside the tag. Mounted only while
 * showing, so a video element's player downloads nothing until it is looked
 * at.
 */
function TagPreviewCard({
  name,
  element,
  rect,
}: {
  name: string;
  element: ElementTag | undefined;
  rect: DOMRect;
}): JSX.Element {
  const above = rect.top > PREVIEW_CARD_ROOM_PX;
  return (
    <span
      role="tooltip"
      style={{
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 216)),
        top: above ? rect.top - 6 : rect.bottom + 6,
        transform: above ? "translateY(-100%)" : undefined,
      }}
      className="pointer-events-none fixed z-50 flex w-52 flex-col gap-1.5 rounded-md border border-border bg-popover p-2 text-[11px] leading-relaxed text-popover-foreground shadow-md"
    >
      {element ? (
        <>
          {element.assetKind === "audio" ? (
            <span
              className="grid h-20 w-full place-items-center rounded-sm border bg-muted/50"
              aria-hidden="true"
            >
              <MusicIcon className="size-7 text-muted-foreground" strokeWidth={1.5} />
            </span>
          ) : element.assetKind === "video_ref" ? (
            // Muted and looping, so it needs no control: the card is
            // pointer-events-none and nothing in it could be clicked.
            <video
              src={element.previewUrl}
              autoPlay
              muted
              loop
              playsInline
              aria-hidden="true"
              className="h-28 w-full rounded-sm border bg-black object-contain"
            />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={element.previewUrl}
              alt=""
              className="h-20 w-full rounded-sm border object-cover"
            />
          )}
          <span className="font-medium">
            @{element.name}{" "}
            <span className="font-normal text-muted-foreground">· {element.category}</span>
          </span>
          {element.description ? (
            <span className="text-muted-foreground">{element.description}</span>
          ) : null}
        </>
      ) : (
        <span className="font-medium text-destructive">
          No saved reference named &quot;@{name}&quot;. This will render with nothing behind it —
          same cost, no reference.
        </span>
      )}
    </span>
  );
}
