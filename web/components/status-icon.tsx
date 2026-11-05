import type { JSX, ReactNode } from "react";
import { Spinner } from "@/components/spinner";
import { Check, Circle, CircleX, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SceneStatus } from "@/types/db";

// Moved here from render-progress.tsx (repointed, not duplicated — that
// file now imports this instead of defining its own copy) since this
// component is the accessible-name source for every scene-status glyph;
// keeping the strings next to the thing that reads them avoids the two
// drifting apart.
export const STATUS_LABEL: Record<SceneStatus, string> = {
  draft: "Draft",
  frame_ready: "Frame ready",
  queued: "Queued",
  rendering: "Rendering",
  done: "Done",
  failed: "Failed",
};

// GitHub-Actions-style status glyph for render-progress.tsx's scene tiles —
// replaces the old "Rendering"/"Queued"/… word beside the tile with a
// shape, on the theory that a grid of a few dozen tiles reads faster as
// icons than as repeated text. Shape carries the meaning, not colour alone
// (a colour-blind viewer still gets four distinct outlines: filled dot,
// open arc, check, X) — colour is the reinforcement, not the signal.
//
// Every glyph is single-tone (`currentColor`, via each lucide icon's own
// `stroke="currentColor"` default, or `fill="currentColor"` for the two
// filled shapes below) rather than a filled badge with contrasting ink —
// that sidesteps needing a second "-foreground" contrast pair tuned per
// theme (the way --primary/--primary-foreground or --destructive/
// -foreground are) for a token that only ever back-fills a tiny icon, not
// a text surface.
const STATUS_ICON_CLASS: Record<SceneStatus, string> = {
  // Pre-render states: nothing is happening yet, so nothing should draw the
  // eye the way an in-flight or terminal glyph would. A quiet, unfilled
  // outline in the same muted tone the tile itself already uses
  // (STATUS_CLASS in render-progress.tsx) rather than removing the icon
  // outright — keeping every tile the same shape/size grid cell, icon or
  // not, is one less layout special-case than some tiles having an icon
  // and others a gap where one would be.
  draft: "text-muted-foreground",
  frame_ready: "text-muted-foreground",
  // --pending / --pending-strong, NOT --warning. Reusing --warning was tried
  // and REVERTED: that token is about ALARM, and queued is not alarming — it
  // is the ordinary first half of "queued -> rendering", and painting it the
  // same red as an overspend made a scene waiting its turn look like a scene
  // in trouble.
  //
  // These are a pair, and every theme now answers the same question in its
  // own file under config/themes/: pick one hue and give it two lightnesses,
  // the dimmer for waiting and the brighter for working, because these two
  // states ARE one journey and must never become two different hues. The light theme's
  // answer is an amber that sits between the colours it already has —
  // --primary (gold, 62% L) is too pale to read as a 2.5px stroke on white,
  // --accent-foreground (28% L) is brown rather than yellow — but that is
  // that theme's reasoning, not this component's; each palette records its own.
  //
  // Shape (filled dot vs. spinning arc) and the status word carry the actual
  // distinction here, as they always did.
  queued: "text-pending",
  rendering: "text-pending-strong",
  done: "text-success",
  failed: "text-destructive",
};

/**
 * StatusIcon's animation is a rotating 16px arc — no translation, scaling,
 * or parallax, the low end of what prefers-reduced-motion is meant to
 * suppress. It runs UNGUARDED, with no `motion-safe:` prefix, and that is
 * an explicit product decision rather than an oversight: do not "fix" it
 * by adding the guard back.
 *
 * The reasoning, so the trade is visible rather than assumed. A spinner is
 * not decoration here — it is the glyph that distinguishes "running" from
 * every other state, and the operator watching a render is watching to see
 * whether anything is still happening. A *static* LoaderCircle (an arc with
 * a gap, the resting frame of a spin) reads as a shape rather than as
 * activity, which is exactly the ambiguity this replaced: before this,
 * queued and rendering were told apart solely by whether dots bounced, so a
 * reduced-motion viewer got no in-flight signal at all and reported the UI
 * as broken.
 *
 * The elapsed-time readout that used to sit beside this glyph is gone
 * (render-progress.tsx no longer renders one per tile), but that does not
 * reopen the reduced-motion gap above: the visible STATUS_LABEL word this
 * component now renders next to the glyph (see below) is itself static,
 * motion-free text that already tells "queued" and "rendering" apart by
 * wording alone, on top of the shape difference (filled dot vs. open arc)
 * that was always there. The unguarded spin is what the product owner
 * asked for on top of that, and it never degrades to invisible or
 * unreadable — the failure mode that would make an unguarded animation
 * genuinely unsafe — because the glyph is legible whether it turns or not.
 */
/**
 * A filled disc with the glyph knocked out of it.
 *
 * Composed rather than styled: the obvious move is to hand lucide's
 * CircleCheck a `fill`, which fills the circle — and also fills the check
 * path inside it, since both are children of the same svg. The result is a
 * solid dot with the tick swallowed. The circle and the glyph have to be
 * separate elements to be separate colours.
 *
 * bg-current takes the status colour from the wrapper (--success,
 * --destructive), so this adds no new token; text-background is the surface
 * the whole app already sits on, which is what the ink inside a filled badge
 * has to be.
 */
function FilledBadge({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex items-center justify-center rounded-full bg-current", className)}
    >
      {children}
    </span>
  );
}

export function StatusIcon({
  status,
  className,
  showLabel = true,
  filled = false,
  icon: Icon,
}: {
  status: SceneStatus;
  className?: string;
  /**
   * Whether to draw the status word beside the glyph.
   *
   * True everywhere it has always been true — render-progress.tsx's tiles,
   * where the word is what tells a reduced-motion viewer "queued" from
   * "rendering" (see this component's doc comment above; do not remove that
   * signal there).
   *
   * False in components/project-rail.tsx, where every row already carries a
   * label of its own — "Done ✓ Character" reads the status twice and buries
   * the thing the operator is actually scanning for. The accessible name is
   * unaffected either way: it comes from aria-label below, never from this
   * span, which is aria-hidden precisely so it cannot compete with it.
   */
  showLabel?: boolean;
  /**
   * Draw the terminal states as a filled disc with the glyph knocked out,
   * the way GitHub Actions does, instead of this component's default
   * single-tone outline.
   *
   * The default stays an outline for the reason this file's header already
   * gives: a filled badge needs a second, contrast-tuned colour for the ink
   * inside it, and adding a --success-foreground / --destructive-foreground
   * pair for one tiny icon was not worth it. Here it is scoped to the one
   * caller that asked for it — components/project-rail.tsx — and the ink is
   * the surface token every filled control in this theme already sits on,
   * not a new one.
   */
  filled?: boolean;
  /**
   * Draw THIS glyph instead of the status shape, keeping the status colour
   * and — the part that matters — the status word as the accessible name.
   *
   * One caller: components/project-rail.tsx swaps the Render settings row's
   * tick for a gear while that is the screen you are on. Passing the icon in
   * rather than letting the rail render its own `<Settings />` beside a
   * hidden StatusIcon is what keeps the aria-label/role decision below the
   * single source of truth for every status glyph in the app — a hand-rolled
   * substitute would have had to re-derive both, and would have got the
   * role="status" vs role="img" split wrong the moment the row was running.
   *
   * Not a way to re-theme the four status shapes: everything else about the
   * component (colour, role, name) still comes from `status`, so an override
   * changes what the row LOOKS like, never what it says.
   */
  icon?: LucideIcon;
}): JSX.Element {
  const colorClass = STATUS_ICON_CLASS[status];
  const size = cn("h-4 w-4 shrink-0", className);
  const label = STATUS_LABEL[status];
  // "status" only for the two states that actually change without a page
  // reload (queued -> rendering -> terminal); the other four are static
  // once rendered, so role="img" (no implicit live-region semantics) is
  // the honest role for them — same split the previous icons-only version
  // used.
  const role = status === "rendering" || status === "queued" ? "status" : "img";

  // aria-label is the accessible name for both roles here — role="status"
  // and role="img" both compute their name from the author-supplied label
  // only, never from visible/hidden child content (see shimmer-text.tsx's
  // identical note). That's why the visible label span below is
  // aria-hidden rather than left exposed: with a real, visible word now
  // sitting next to the glyph, an un-hidden copy would be a *second*
  // source competing with aria-label for the same announcement — this repo
  // has shipped that exact duplicate before. One accessible name
  // (aria-label), one visible-but-silent label (aria-hidden), zero echoes.
  return (
    <span
      role={role}
      aria-label={label}
      className={cn("inline-flex items-center gap-1.5", colorClass)}
    >
      {showLabel ? <span aria-hidden="true">{label}</span> : null}
      {Icon ? (
        <Icon aria-hidden="true" className={size} />
      ) : status === "rendering" ? (
        <Spinner className={size} />
      ) : status === "queued" ? (
        // A smaller disc than the other glyphs, drawn inside an svg the same
        // 16px as the rest so the icon column stays aligned. Shrinking
        // lucide's Circle would shrink its box too and pull the row in;
        // scaling the drawn radius inside a full-size viewBox keeps the grid
        // and only changes what an operator sees. Waiting deserves less ink
        // than working. Stays an <svg> rather than a styled <span> because
        // every glyph in this file is one — the tiles query them as svg.
        <svg aria-hidden="true" viewBox="0 0 24 24" className={size}>
          <circle cx="12" cy="12" r="5" fill="currentColor" />
        </svg>
      ) : status === "done" ? (
        // ALWAYS FILLED, no longer gated on the `filled` prop.
        //
        // Done sits on top of a poster in the /ugc strip and the version
        // rail, and a 2px outline in --success against a photograph is a
        // shape you have to look for. The solid disc is the one glyph here
        // that has to survive an arbitrary image behind it, because it is the
        // only one that appears once a clip exists.
        //
        // It is also what GitHub Actions draws for success, which is the
        // vocabulary this whole set was built from — the outline was the
        // compromise, not the intent. See `filled` below for the contrast
        // reasoning; nothing about it changes, the ink is still the surface
        // token every filled control in this theme already sits on.
        //
        // FAILED IS DELIBERATELY NOT CHANGED HERE. A solid red disc is a
        // louder decision than a solid green one and nobody asked for it; it
        // stays on the prop, so project-rail keeps the matched pair it opted
        // into and everywhere else keeps a quiet X.
        <FilledBadge className={size}>
          <Check className="size-2.5 text-background" strokeWidth={3.5} />
        </FilledBadge>
      ) : status === "failed" ? (
        filled ? (
          <FilledBadge className={size}>
            <X className="size-2.5 text-background" strokeWidth={3.5} />
          </FilledBadge>
        ) : (
          <CircleX aria-hidden="true" className={size} />
        )
      ) : (
        <Circle aria-hidden="true" className={size} />
      )}
    </span>
  );
}
