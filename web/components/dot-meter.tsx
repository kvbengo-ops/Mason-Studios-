import type { JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * A row of dots that reads as a gauge: `ratio` (0 to 1) of the row is lit.
 *
 * Used wherever the allowance is shown — the Create header card and the account
 * menu's weekly meter — so the same fraction looks the same everywhere. A dot is
 * lit in proportion to how much of it the ratio covers, so the row is accurate
 * to a fraction of a dot, not rounded to the nearest whole one: 14.6 of 20 dots
 * is fourteen lit and a fifteenth sixty percent lit. A ratio above zero always
 * lights something, so a nearly-empty allowance never looks empty.
 *
 * A grid, so the dots scale to the width they are given and never overflow.
 */
export function DotMeter({
  ratio,
  count = 20,
  litClassName = "bg-primary",
  offClassName = "bg-muted-foreground/25",
  label,
  className,
}: {
  ratio: number;
  count?: number;
  litClassName?: string;
  offClassName?: string;
  /** Read out by screen readers, e.g. "70% of the week's allowance left". */
  label?: string;
  className?: string;
}): JSX.Element {
  const clamped = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
  const lit = clamped * count;
  return (
    <span
      role="img"
      aria-label={label ?? `${Math.round(clamped * 100)}% left`}
      className={cn("grid gap-[3px]", className)}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: count }, (_, index) => {
        // How much of THIS dot the ratio covers; a sliver is shown as a sliver.
        const fill = Math.min(Math.max(lit - index, 0), 1);
        return (
          <span
            key={index}
            data-fill={Number(fill.toFixed(2))}
            className={cn("relative aspect-square w-full overflow-hidden rounded-full", offClassName)}
          >
            {fill > 0 ? (
              <span
                className={cn("absolute inset-0 rounded-full", litClassName)}
                style={{ opacity: fill }}
              />
            ) : null}
          </span>
        );
      })}
    </span>
  );
}
