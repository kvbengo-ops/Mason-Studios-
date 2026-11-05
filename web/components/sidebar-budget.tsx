// Budget readout presentation — a glance, not a report. Used inside the
// avatar menu (web/components/account-menu.tsx), which owns composing these
// into the pending-request/request-more branch and the two allowance
// dialogs (moved there because Radix's DropdownMenu unmounts its Content —
// and anything nested inside it — the instant the menu closes on item
// selection; see request-allowance-dialog.tsx's header). This file keeps
// only the pure, non-interactive presentation pieces so account-menu.tsx
// isn't reimplementing the meter math or its colour rules — moved from the
// old sidebar footer verbatim, not re-derived.
import { useState } from "react";
import type { JSX } from "react";
import { ChevronRight, CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import { budgetPressure, budgetTier, selectBindingMeter } from "@/lib/budget-tier";
import type { BudgetPressure, MeterWindow } from "@/lib/budget-tier";
import { formatAllowanceAmount, remainingForDisplayUsd } from "@/lib/format-usd";
import type { AllowanceDisplayUnit } from "@/lib/format-usd";
import { weekdayFormatter } from "@/lib/datetime";
import { DotMeter } from "@/components/dot-meter";

/** "Sun", "Mon", … — for the breakdown's "(expires Sun)" line (Part 2). Short form: this is a dropdown, not a dashboard. */

// Three steps (lib/budget-tier.ts's budgetTier), not the old two: "critical"
// keeps the app's one existing budget-refusal colour (text-destructive, the
// same token render-confirm-dialog.tsx and render-gate.tsx switch to once a
// render would go over), but "warning" now gets its own token — --warning
// (config/themes/*.css) — rather than reusing text-destructive unweighted
// the way the old middle tier did. Two different signals need two different
// colours, not the same colour at two volumes: --warning is deliberately
// NOT this theme's accent (--primary, the gold "New project" button) either
// — see config/themes/studio-light.css's own comment on why a status colour and the
// action colour can't share a hue here.
export function budgetClassName(remainingUsd: number, capUsd: number): string {
  const tier = budgetTier(remainingUsd, capUsd);
  if (tier === "critical") return "font-semibold text-destructive";
  if (tier === "warning") return "text-warning";
  return "text-sidebar-foreground";
}

/** cr | $ — which unit every figure in the menu is shown in. */
function UnitToggle({
  unit,
  onChange,
}: {
  unit: AllowanceDisplayUnit;
  onChange: (unit: AllowanceDisplayUnit) => void;
}): JSX.Element {
  return (
    <div className="flex rounded-md bg-sidebar-border/60 p-0.5 text-[10px] font-medium leading-none">
      {(
        [
          ["credits", "cr"],
          ["usd", "$"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={unit === value}
          aria-label={value === "usd" ? "Show in dollars" : "Show in credits"}
          onClick={() => onChange(value)}
          className={cn(
            "rounded px-1.5 py-1 transition-colors",
            unit === value
              ? "bg-sidebar-primary text-sidebar-primary-foreground"
              : "text-muted-foreground hover:text-sidebar-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The one full meter: "the cap that will stop the user first"
 * (lib/budget-tier.ts's selectBindingMeter — see that file for why this is
 * not the same question as lib/spend.ts's bindingSpendCap). Colour appears
 * ONLY at the warning/critical steps — the healthy fill is a muted neutral
 * (bg-sidebar-accent-foreground/30, not bg-sidebar-primary/gold), because
 * gold here is already spent as this app's one action colour (the "New
 * project" button, config/themes/studio-light.css's own comment on why a status
 * colour and the action colour can't share a hue) and a meter that's
 * loudest when full — the state with the least information — is the bug
 * this rebuild exists to fix.
 *
 * `capUsd <= 0` is NOT "nothing to show" — it is the most important thing
 * this component ever has to say. The regular-editor role default is 0 (see
 * lib/spend.ts), so it is what every new account sees, and rendering null
 * left them with a blank space where their allowance should be: no number,
 * no bar, no explanation, and no hint that the Request more control below is
 * the thing they need. "You have no allowance yet" and "your allowance
 * failed to load" looked identical, which is the worst possible pair to
 * confuse.
 *
 * The meter itself still cannot draw — there is no denominator, and
 * budgetTier rightly treats that as not-a-ratio — so the zero state is a
 * sentence instead of a bar.
 */
export function BudgetMeter({
  window: w,
  displayUnit = "usd",
  onDisplayUnitChange,
  grantBreakdown,
}: {
  window: MeterWindow;
  displayUnit?: AllowanceDisplayUnit;
  /** Given, the card shows a cr | $ switch. */
  onDisplayUnitChange?: (unit: AllowanceDisplayUnit) => void;
  /** Weekly grant components from the server snapshot; passed-out is positive. */
  grantBreakdown?: { grantedInUsd: number; receivedUsd: number; passedOutUsd: number };
}): JSX.Element | null {
  const { remainingUsd, capUsd, period, allowanceUsd, usedUsd, heldUsd, grantUsd, grantExpiresAt } =
    w;
  const [open, setOpen] = useState(true);
  const incomingUsd = grantBreakdown
    ? grantBreakdown.grantedInUsd + grantBreakdown.receivedUsd
    : (grantUsd ?? 0);
  const grantLabel = grantBreakdown?.receivedUsd
    ? grantBreakdown.grantedInUsd
      ? "grant (including received passes)"
      : "grant (received)"
    : "grant";
  if (capUsd <= 0 && !grantBreakdown?.passedOutUsd) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs capitalize text-muted-foreground">{period}</span>
          {onDisplayUnitChange ? (
            <UnitToggle unit={displayUnit} onChange={onDisplayUnitChange} />
          ) : null}
        </div>
        <span className="text-sm tabular-nums text-destructive">
          {formatAllowanceAmount(0, displayUnit)}
        </span>
        <span className="text-xs text-muted-foreground">
          No allowance yet — ask an admin to grant one.
        </span>
      </div>
    );
  }
  const tier = budgetTier(remainingUsd, capUsd);
  // usedUsd is optional on MeterWindow (falls back to the plain "$X of $Y
  // left" line when absent) — pressure has nothing to measure without it,
  // so it's "normal" (no note) rather than guessed from remaining/cap,
  // which would silently disagree with budgetPressure's own (used, cap)
  // contract the moment a grant is in play.
  const pressure = usedUsd !== undefined ? budgetPressure(usedUsd, capUsd) : "normal";
  // Clamped to [0, 1]: remainingUsd can go negative (over cap) or, in
  // principle, exceed capUsd (a grant raised the effective cap after this
  // ratio's own cap figure was read) — neither should over/under-fill the
  // track.
  const ratio = capUsd > 0 ? Math.min(Math.max(remainingUsd / capUsd, 0), 1) : 0;
  const fillClassName =
    tier === "critical"
      ? "bg-destructive"
      : tier === "warning"
        ? "bg-warning"
        : "bg-sidebar-primary";
  // Breakdown (Part 2 of the task that added this: show how "left" was
  // derived, not just the answer — an approved grant otherwise changes this
  // number with no visible cause) — only when the caller has the pieces to
  // show it. Falls back to the old single "$X of $Y left" line otherwise, so
  // this component still degrades gracefully for any future caller that
  // hasn't threaded allowanceUsd/usedUsd through.
  const hasBreakdown = allowanceUsd !== undefined && usedUsd !== undefined;
  const left = formatAllowanceAmount(Math.max(remainingUsd, 0), displayUnit);
  return (
    // The Credits card: "Credits (?)" and "N left >" over a dot meter, then the
    // arithmetic. The chevron folds the arithmetic away; open by default.
    <div className="flex flex-col gap-2.5 rounded-xl bg-sidebar-accent/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-sidebar-foreground">
          Credits
          <CircleHelp aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </span>
        {hasBreakdown ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={cn(
              "flex items-center gap-0.5 text-sm tabular-nums",
              budgetClassName(remainingUsd, capUsd),
            )}
          >
            <span>{left} left</span>
            <ChevronRight
              aria-hidden="true"
              className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
            />
          </button>
        ) : null}
      </div>
      {/* Dots, not a bar: part of a dot is shown, so the fraction is exact. */}
      <DotMeter
        ratio={ratio}
        count={24}
        litClassName={fillClassName}
        offClassName="bg-sidebar-border"
        label={`${Math.round(ratio * 100)}% of the ${period} allowance left`}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs capitalize text-muted-foreground">{period}</span>
        {onDisplayUnitChange ? (
          <UnitToggle unit={displayUnit} onChange={onDisplayUnitChange} />
        ) : null}
      </div>
      {hasBreakdown && open ? (
        <div className="flex flex-col text-xs tabular-nums text-muted-foreground">
          {allowanceUsd !== 0 ? (
            <span>{formatAllowanceAmount(allowanceUsd, displayUnit)} allowance</span>
          ) : null}
          {incomingUsd > 0 ? (
            <span>
              +{formatAllowanceAmount(incomingUsd, displayUnit)} {grantLabel}
              {grantExpiresAt
                ? ` (expires ${weekdayFormatter.format(new Date(grantExpiresAt))})`
                : ""}
            </span>
          ) : null}
          {grantBreakdown && grantBreakdown.passedOutUsd > 0 ? (
            <span>−{formatAllowanceAmount(grantBreakdown.passedOutUsd, displayUnit)} passed</span>
          ) : null}
          <span>-{formatAllowanceAmount(usedUsd, displayUnit)} used</span>
          {/* Held, not spent: the estimate for renders sitting in
              queued/rendering. Its own line rather than folded into "used"
              because the two are different promises — used is billed and
              gone, held comes back if the render never lands. Shown only
              when there is something in flight, so the ordinary breakdown
              is unchanged. */}
          {heldUsd !== undefined && heldUsd > 0 ? (
            <span>-{formatAllowanceAmount(heldUsd, displayUnit)} on hold (rendering)</span>
          ) : null}
        </div>
      ) : !hasBreakdown ? (
        <span className={cn("text-sm tabular-nums", budgetClassName(remainingUsd, capUsd))}>
          {formatAllowanceAmount(Math.max(remainingUsd, 0), displayUnit)} of{" "}
          {formatAllowanceAmount(capUsd, displayUnit)} left
        </span>
      ) : null}
      <PressureNote pressure={pressure} audience="own" />
    </div>
  );
}

/**
 * Shown when the fal account holds less than the allowance above says is
 * left — the case where this menu's headline figure is a promise the
 * account cannot keep.
 *
 * Separate from PressureNote rather than folded into it, because the two are
 * orthogonal: an editor can sit at "normal" allowance pressure, see a
 * comfortable number, and still have every render refused. Observed live —
 * the menu read "$3.06 left" against $1.56 in the account.
 *
 * Deliberately carries no dollar figure. The editor cannot act on the
 * balance, only on knowing their number overstates it; admins have the real
 * number on /spend. It also says what to do, because "renders may fail" with
 * no next step just moves the confusion.
 */
export function AccountFundsNote({ underfunded }: { underfunded: boolean }): JSX.Element | null {
  if (!underfunded) return null;
  return (
    <span className="text-[11px] text-warning">
      The shared account is low — renders may be refused before this allowance runs out. Ask an
      admin to add funds.
    </span>
  );
}

/**
 * The other window, once the binding one above has the meter: small text
 * only, no bar, no "of $cap" — "$5.00 left today" is enough for a figure
 * that (by construction — selectBindingMeter picked the OTHER one as
 * closer to stopping the user) is not the one about to refuse a render.
 * Still colour-coded by its own tier: a healthy weekly figure doesn't mean
 * an exhausted daily one should read as plain text, it only means daily
 * doesn't ALSO get a bar.
 */
export function BudgetSmallLine({
  window: w,
  displayUnit = "usd",
}: {
  window: MeterWindow;
  displayUnit?: AllowanceDisplayUnit;
}): JSX.Element {
  // Same "no usedUsd, no note" fallback as BudgetMeter above.
  const pressure = w.usedUsd !== undefined ? budgetPressure(w.usedUsd, w.capUsd) : "normal";
  return (
    <span className="truncate text-xs text-muted-foreground">
      <span className={cn("tabular-nums", budgetClassName(w.remainingUsd, w.capUsd))}>
        {formatAllowanceAmount(remainingForDisplayUsd(w.remainingUsd), displayUnit)}
      </span>{" "}
      left {w.period}
      {pressure !== "normal" ? (
        <>
          {" · "}
          <span className={pressure === "critical" ? "text-destructive" : "text-warning"}>
            {pressureLabel(pressure, "own")}
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * Sidebar copy for a non-"normal" BudgetPressure. Text, not colour, is the
 * signal here (colour is layered on top by the callers above/below) — see
 * components/status-icon.tsx's header on why colour alone is never enough
 * and why this repo has shipped that exact mistake before. `warning` reads
 * as information ("nothing is broken yet"); `critical` tells the reader
 * what to do about it, and that differs by audience: an editor's own line
 * points at the "Request more" control already in this menu, while the
 * team-wide line (admins only — see budgetPressure's own doc comment on why
 * a null cap is "normal") points out that it's the TEAM ceiling binding,
 * not their own account, since an admin's own caps can look perfectly
 * healthy while the shared one is the thing about to refuse everyone.
 */
export function pressureLabel(pressure: BudgetPressure, audience: "own" | "team"): string | null {
  if (pressure === "warning") {
    return audience === "team" ? "Team spend climbing" : "Nearing limit";
  }
  if (pressure === "critical") {
    return audience === "team"
      ? "Team ceiling binding, not your own"
      : "Over budget — request more";
  }
  return null;
}

/** Shared block-level rendering of `pressureLabel`, for callers (BudgetMeter, and the team line in account-menu.tsx) that want a standalone line rather than BudgetSmallLine's inline "· " suffix. Renders nothing at "normal" — same "no note when there's nothing to flag" rule every caller here follows. */
export function PressureNote({
  pressure,
  audience,
}: {
  pressure: BudgetPressure;
  audience: "own" | "team";
}): JSX.Element | null {
  const label = pressureLabel(pressure, audience);
  if (!label) return null;
  return (
    <span
      className={cn("text-[11px]", pressure === "critical" ? "text-destructive" : "text-warning")}
    >
      {label}
    </span>
  );
}

/** The one meter is whichever window will stop the user first; re-exported so account-menu.tsx doesn't need a second import line for it. */
export { selectBindingMeter, budgetPressure };
export type { MeterWindow, BudgetPressure };
