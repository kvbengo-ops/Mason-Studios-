import type { JSX } from "react";
import { cn } from "@/lib/utils";

// Five slots, matching the theme's --chart-1..5 tokens exactly (see
// config/themes/studio-light.css / studio.css) — reusing those instead of
// inventing a separate avatar palette means every colour here already has a
// documented, checked contrast value in both themes, and a future theme swap
// (a new NEXT_PUBLIC_THEME) recolours avatars along with everything else
// that reads --chart-N, with nothing to update in this file.
//
// Written out as full, literal class strings (not `bg-chart-${n}` built at
// runtime) because Tailwind's build only generates CSS for class names it
// can find as complete strings in the source — a template-interpolated
// class name would work in dev (arbitrary values aren't at play here) but
// silently produce no rule at all in the production build, since none of
// "bg-chart-1".."bg-chart-5" would ever appear verbatim for the scanner to
// pick up.
const CHART_SLOT_CLASSES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const;

/**
 * Deterministically maps an arbitrary string to one of the five --chart-N
 * slots. A simple additive hash (not crypto-grade, doesn't need to be) —
 * the only requirement is "the same input always lands on the same slot",
 * which any stable char-code sum satisfies. `>>> 0` keeps the accumulator
 * unsigned so the final `%` can't go negative on a long email.
 */
function hashToChartSlotClass(value: string): (typeof CHART_SLOT_CLASSES)[number] {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  // Non-null assertion, not `?? CHART_SLOT_CLASSES[0]`: `%` against the
  // array's own (non-zero, const-known) length can only ever produce an
  // in-range index, so a fallback here would just hide a real bug (the
  // array shrinking to empty) behind a silently-wrong colour instead of a
  // type error surfacing it.
  return CHART_SLOT_CLASSES[hash % CHART_SLOT_CLASSES.length]!;
}

/**
 * "john_tester@gmail.com" -> "JT": splits the local part (before `@`) on
 * non-letter runs (`.`, `_`, `-`, digits) and takes the first letter of the
 * first two resulting words, uppercased. A local part with only one word
 * ("darwin@...") falls back to that word's first one or two letters, so a
 * single-word email still gets two initials where it can rather than
 * reading as a lone, oddly small dot. Non-letter/empty input (no `@`, or
 * nothing before it) returns "" — the caller decides what a blank means.
 */
export function getInitials(email: string | null | undefined): string {
  if (!email) return "";
  const local = email.split("@")[0] ?? "";
  const words = local.split(/[^a-zA-Z]+/).filter(Boolean);
  if (words.length === 0) return "";
  const [first, second] = words;
  if (words.length === 1) return first!.slice(0, 2).toUpperCase();
  return (first!.charAt(0) + second!.charAt(0)).toUpperCase();
}

/**
 * Small round avatar for scanning a list by owner, not a replacement for the
 * email text next to it (see projects/page.tsx's Owner cell). Deliberately
 * initials-only, never a real uploaded photo: avatar_storage_key lives
 * behind a signed URL (lib/storage.ts) that no list query here selects, so
 * showing a real image would mean a new column plus a signed-URL call per
 * row — out of scope for a table-density pass.
 */
export function InitialsAvatar({
  email,
  className,
}: {
  email: string | null | undefined;
  className?: string;
}): JSX.Element | null {
  const initials = getInitials(email);
  // No broken circle for a missing/unusable email: an avatar with nothing to
  // hash and nothing to show is worse than no avatar, since a blank coloured
  // dot would still look like initials failed to load rather than "there is
  // no owner email".
  if (!initials) return null;

  const slotClass = hashToChartSlotClass(email as string);

  return (
    <span
      aria-hidden="true"
      className={cn(
        // text-background, not a hardcoded white/black: every --chart-N in
        // both studio-light.css and studio.css was checked against --background
        // at >=4.5:1 (that's the exact pairing each theme file's own header
        // comment documents under "chart-1..5 all >=4.5:1 against
        // background") — reusing --background as the *text* colour on top
        // of a solid --chart-N fill lands on that same, already-verified
        // contrast pair instead of introducing a new one that would need
        // separately checking per theme.
        "flex size-6 shrink-0 items-center justify-center rounded-full text-background text-[10px] font-semibold tabular-nums",
        slotClass,
        className,
      )}
    >
      {initials}
    </span>
  );
}
