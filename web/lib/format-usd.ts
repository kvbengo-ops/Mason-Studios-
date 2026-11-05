// One place to turn a dollar amount into the string a person reads.
//
// Before this there were seven near-identical `Intl.NumberFormat` instances
// scattered across the pages that show money — projects, users, allowances,
// profile, the scene table, the cost badge, the reconcile card — plus an
// eighth call site that was not using `Intl` at all. Six of the seven were
// byte-for-byte equivalent (verified: `minimumFractionDigits: 2` alone and
// `min`+`max: 2` produce identical output for USD, because the currency's
// own default maximum is already 2), so they were duplication rather than
// deliberate variation.
//
// The eighth was the reason this file exists. `app/(app)/spend/page.tsx`
// formatted with a template literal and `toFixed(2)`, which does not group
// thousands: the spend page — the one screen whose entire job is showing a
// capped team what it has spent — rendered `$12345.68` where every other
// screen in the app rendered `$12,345.68`. That is not a style difference;
// at four or five figures it is genuinely harder to read, and it was on the
// page where misreading the number matters most.
//
// Deliberately NOT `server-only`: components/cost-badge.tsx and
// components/scene-table.tsx are Client Components and need this too.

/**
 * A dollar amount, always with cents and grouped thousands: `$12,345.68`.
 *
 * Rounds to cents, so sub-cent figures collapse — `$0.0398` reads as
 * `$0.04`. That is right for a total or a line item a person is being asked
 * to approve, and wrong for a per-unit vendor rate, which is what
 * formatUsdRate below is for.
 */
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsd(amountUsd: number): string {
  return usdFormatter.format(amountUsd);
}

/**
 * The display conversion used by kie and by the editor-facing allowance UI.
 * Persistence and spend-cap arithmetic stay in USD; conversion happens only
 * where a person reads or enters a value.
 */
export const USD_PER_CREDIT = 0.005;
export const CREDITS_PER_USD = 1 / USD_PER_CREDIT;

/**
 * A remaining-allowance figure as a PERSON should read it: never below zero.
 *
 * Every remaining figure in this app is a plain subtraction (cap - spent,
 * lib/spend.ts's getAccountBudgetSnapshot and lib/sidebar-budget.ts), and it
 * goes negative whenever a ceiling drops below what an account has already
 * spent — an admin lowering an override, a grant ending or expiring mid-week
 * after it had been drawn on, a bulk role change. Enforcement handles that
 * correctly and it heals itself at the Manila week reset, but "-1,000 cr
 * left" reads as a bug to the person looking at it, not as "you are out".
 *
 * Clamped at DISPLAY, never at the computation, and the distinction is
 * load-bearing: lib/render-budget.ts's budgetOverageUsd subtracts the real
 * remaining figure to tell an operator how far over a render is, so a
 * clamped input there would quietly understate the overage in the refusal
 * message. 0075_revoke_allowance_grants.sql's outstanding_allowance_usd
 * already takes the same position in SQL with its greatest(0, ...).
 *
 * NOT for a projection — components/render-confirm-dialog.tsx's "left after
 * this render" is meant to go negative and is coloured for it; that is the
 * number telling someone the render will be refused.
 */
export function remainingForDisplayUsd(amountUsd: number): number {
  return Math.max(amountUsd, 0);
}

export function estimatedGenerations(remainingUsd: number, costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) throw new Error("Generation cost must be positive");
  return Math.floor(remainingForDisplayUsd(remainingUsd) / costUsd);
}

export type AllowanceDisplayUnit = "usd" | "credits" | "dual";

const creditFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export function usdToCredits(amountUsd: number): number {
  return amountUsd * CREDITS_PER_USD;
}

export function creditsToUsd(credits: number): number {
  return credits * USD_PER_CREDIT;
}

/** A USD-backed amount shown in kie's credit unit: `6,000 cr`. */
export function formatCredits(amountUsd: number): string {
  return `${creditFormatter.format(Math.round(usdToCredits(amountUsd)))} cr`;
}

/** An admin-facing amount with kie credits first and its USD equivalent. */
export function formatDual(amountUsd: number): string {
  return `${formatCredits(amountUsd)} (${formatUsd(amountUsd)})`;
}

export function formatAllowanceAmount(
  amountUsd: number,
  displayUnit: AllowanceDisplayUnit,
): string {
  if (displayUnit === "credits") return formatCredits(amountUsd);
  if (displayUnit === "dual") return formatDual(amountUsd);
  return formatUsd(amountUsd);
}

/**
 * A per-unit vendor rate, to four decimal places: `$0.0398`.
 *
 * fal prices several endpoints below a cent per unit — nano-banana/edit
 * bills $0.0398 per image, whisper $0.0008 per compute second. Passing
 * those through formatUsd shows `$0.04` and `$0.00`, which turns a price
 * comparison into a row of identical-looking numbers and, for whisper,
 * displays a real charge as nothing at all. Used by the reconcile card,
 * where our declared rate is shown beside fal's.
 */
const usdRateFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatUsdRate(amountUsd: number): string {
  return usdRateFormatter.format(amountUsd);
}
