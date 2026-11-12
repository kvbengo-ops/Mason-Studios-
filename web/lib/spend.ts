// Spend caps are enforced in USD; credits are only the display unit.
// Role daily/weekly defaults come from env; the optional global daily/weekly
// cap is configurable in app_settings. Per-account hourly overrides live on profiles.
// Spend periods reset at 05:00 Asia/Manila; hourly caps use a rolling hour.
// ---------------------------------------------------------------------------
// The timezone question — day and week boundaries are Asia/Manila,
// deliberately, not UTC
// ---------------------------------------------------------------------------
// getDailySpend/getGlobalDailySpend used to bound "today" at UTC midnight.
// The team is in the Philippines (UTC+8, no DST — the offset has been fixed
// since 1978, so this needs no timezone database, just a constant). A UTC
// day boundary resets at 08:00 Manila time — the middle of a working
// morning. Two concrete failures that caused, both worth naming instead of
// leaving implicit:
//
//   - An editor who hits their daily cap at 4pm Manila is unblocked again
//     at 8am Manila the next calendar day by UTC's clock, not at midnight
//     as "daily" would suggest to anyone reading the product, not the
//     server's clock.
//   - A "today" figure spans parts of TWO working days (roughly 8am-
//     midnight Manila is "yesterday" in UTC, midnight-8am Manila is "today"
//     in UTC) — an editor checking the sidebar at 9am Manila sees a figure
//     that reset an hour ago for reasons that have nothing to do with their
//     actual workday.
//
// Every spend-day boundary in this file is now 05:00 Asia/Manila, computed
// with a fixed +8h offset (manilaDateParts / manilaFiveAmUtcIso below) —
// deliberately not `Intl.DateTimeFormat` with a timeZone option or a tz
// database dependency, because Manila's offset never changes; a fixed
// arithmetic shift is the simplest correct implementation for a zone with
// no DST, and anything more general would be solving a problem this team
// doesn't have. Migration 0136's SQL boundary functions mirror these
// calculations so /users' admin read and cap enforcement agree.
//
// ---------------------------------------------------------------------------
// The week question — calendar week (Monday 05:00 reset), not a rolling 7 days
// ---------------------------------------------------------------------------
// Two shapes were on the table:
//
//   - Calendar week: resets every Monday 05:00 Manila. Predictable ("your
//     allowance is back Monday"), easy to explain to an editor without
//     doing arithmetic, and matches how a periodic allocation is usually
//     described ("$5/week") — nobody reads "$5/week" as "$5 available in
//     any trailing 7-day span, recomputed continuously."
//   - Rolling 7 days: no cliff (spend is always measured against the
//     trailing week), but an editor's remaining allowance changes every
//     day even with zero new spend, purely because old spend ages out of
//     the window — a number that moves without the editor doing anything
//     is a much harder thing to reason about ("why did my remaining
//     allowance go up? I didn't do anything") than a number that's fixed
//     until a known reset point.
//
// The user's own framing — "good for 1 week allocation" — reads as a
// periodic grant, not a continuously-evaluated trailing window: an
// allocation is something you get and then have for the period, not
// something recalculated every day against a moving 7-day lookback.
// Calendar week wins on both that reading and on the predictability
// argument above; the daily burst guard (see the file-level ceiling list
// above) is what actually prevents the "sudden Monday" cliff from feeling
// abusable — nobody can spend the whole week's allowance in the last hour
// before it resets, because the daily guard caps any single day at a
// fraction of the weekly figure by design (see DAILY_CAP_USD/WEEKLY_CAP_USD's
// defaults below: $5/day, $10/week — two days at the daily guard's ceiling
// already exhausts the whole weekly allowance, leaving five more days in
// the week where the daily guard alone blocks any further render).
//
// Calendar week = Monday 05:00 Manila through the following Monday 05:00
// Manila, computed by startOfManilaWeekIso below. Mirrored in SQL by
// migration 0138's manila_spend_week_start function.
//
// ---------------------------------------------------------------------------
// `assertCapNotExceeded` / `assertWeeklyCapNotExceeded` /
// `assertGlobalCapNotExceeded` are pure functions so the cap arithmetic
// (under / at / over) is unit-testable without a live database — mirroring
// how lib/recompile-guard.ts pulls pure checks out of the "use server"
// actions that call them.

import { cache } from "react";
import { getSpendTotalUsd, getUserSpendUsd, getUserActiveGrantsUsd } from "@/lib/db-aggregates";
import { isDev } from "@/lib/mode";
import { createAdminClient } from "@/lib/supabase/server";
import { guardResult, type ActionResult } from "@/lib/action-result";
import { getKieAccountBalanceUsd } from "@/lib/kie-balance";
import { getBytePlusBalanceUsd } from "@/lib/byteplus-balance";
import { estimateCost } from "@/lib/estimate";
import { isAudioEnabled, mergeRenderSettings } from "@/lib/models";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ProfileRole } from "@/types/db";

/**
 * Parses a *_CAP_USD env var into a non-negative dollar ceiling, or throws.
 * Role cap env values go through this — never a bare `Number(...)`.
 *
 * Bare `Number()` has two silent-failure modes a dollar cap can't afford:
 *   - `Number("$20")` (a stray currency symbol, a copy-pasted "$20/day",
 *     any non-numeric junk) is `NaN`. `projected > NaN` is always `false`,
 *     so assertCapNotExceeded/assertGlobalCapNotExceeded never throw again —
 *     the cap silently stops existing while every caller still believes
 *     it's enforced. This is the worse of the two failure modes: it fails
 *     OPEN.
 *   - `Number("")` (an env var declared but left blank) is `0`, which fails
 *     CLOSED — every render gets refused with no indication why the "$0
 *     cap" was never a deliberate choice.
 * Both look, from the caller's side, like ordinary numbers. Nothing about
 * `if (projected > capUsd)` can tell "0 because someone typed 0" apart from
 * "0 because the string was empty" — so the only place that distinction can
 * still be made is right here, at parse time, before the bad value becomes
 * indistinguishable from a good one.
 *
 * Throws instead of falling back to a conservative default on purpose. A
 * fallback has the exact same blind spot as the bug it would replace: a
 * substituted value is indistinguishable from a deliberately-configured one
 * to everyone downstream, so a silently-substituted "safe" cap would still
 * let a render.yaml typo ship as if nothing were wrong — just with a
 * different wrong number instead of NaN. The whole point of this fix is
 * that a broken cap must be IMPOSSIBLE to mistake for a working one.
 *
 * Throwing at module load — not returning an ActionResult at the point an
 * editor clicks Render (see lib/action-result.ts) — because a malformed cap
 * is a deploy-time configuration error, not a request-time one: the editor
 * hitting "Render" has no way to fix render.yaml, so handing them a
 * returned error message would just be a more polite way of leaving the
 * cap broken in production until someone reads server logs. This module is
 * imported only by actions/enqueue.ts and the render page (every render
 * entry point, and nothing else) — so the blast radius of throwing here is
 * exactly "rendering is unavailable until the env var is fixed," not the
 * whole app going down. That is the correct failure mode for a spend
 * ceiling: refuse to serve renders at all rather than serve them unmetered.
 */
export function parseCapEnvUsd(
  envVarName: string,
  rawValue: string | undefined,
  defaultUsd: number,
): number {
  if (rawValue === undefined) return defaultUsd;
  // Reject blank/whitespace-only explicitly, before Number() gets a chance
  // to turn it into a too-plausible-looking 0 — see the failure-mode list
  // above.
  if (rawValue.trim() === "") {
    throw new Error(
      `${envVarName} is set but empty. A spend cap must be a non-negative dollar amount ` +
        `(e.g. "20"), not a blank string — fix it in render.yaml (or the environment) and ` +
        "redeploy. Refusing to start with an unparseable spend cap: a cap that silently fails " +
        "open or closed is worse than the app refusing to boot.",
    );
  }
  const parsedUsd = Number(rawValue);
  if (!Number.isFinite(parsedUsd) || parsedUsd < 0) {
    throw new Error(
      `${envVarName}=${JSON.stringify(rawValue)} is not a valid non-negative dollar amount. ` +
        'Fix it in render.yaml (or the environment) — e.g. "20", not "$20" — and redeploy. ' +
        "Refusing to start with an unparseable spend cap: a cap that silently fails open (NaN " +
        "makes every over-cap comparison false) or closed (a negative number makes every " +
        "comparison true) is worse than the app refusing to boot.",
    );
  }
  return parsedUsd;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// THE REGULAR-EDITOR DEFAULT IS ZERO, AND THAT IS THE POINT.
//
// 0001_init.sql gives every new profile `role = 'editor'`, so this pair is
// what an account gets the moment it is created — before anyone has looked
// at it, decided anything about it, or knows it exists. At $10/week that
// meant a stranger who completed signup could immediately spend real vendor
// money, and the only thing standing between them and the budget was
// global cap, which is a team-wide backstop, not an access
// decision.
//
// Zero inverts the default: a new account can sign in, look around, compile
// scripts and build frames, and can render nothing until an admin decides
// what it may spend. Spending becomes something granted, not something
// assumed, which is what "the admin sets the threshold" has to mean if it
// means anything.
//
// Nothing else has to change for this to work, which is the argument for it
// being a number rather than a feature:
//
//   - assertWeeklyCapNotExceeded refuses at a cap of 0 by the same
//     arithmetic it uses at any other figure. No zero branch anywhere.
//   - getEffectiveWeeklyCapUsd adds active allowance_grants ON TOP of this,
//     so an admin approving a request for 200 cr gives exactly 200 cr — the
//     grant IS the allowance for a zero-default account, and the existing
//     request -> approve workflow is already the way to hand one out.
//   - weekly_cap_override_usd still overrides it per account (/users), for
//     an admin who wants a standing allowance instead of a grant.
//   - weeklyCapOverrideError has accepted 0 since it was written ("Zero is
//     deliberate: it lets an admin pause new paid renders for one account").
//     Zero was always a legitimate allowance; it just was not the default.
//
// TRUSTED_* and ADMIN_* below keep real figures: both are roles an admin has
// to deliberately promote an account INTO, and that promotion is the access
// decision this zero exists to force. Making them zero too would mean an
// admin grants trust and then has to separately grant the ability to use it.
//
// A team that wants the old behaviour sets DAILY_CAP_USD/WEEKLY_CAP_USD in
// render.yaml — these are only what an UNSET var means.
// ---------------------------------------------------------------------------
export const DAILY_CAP_USD = parseCapEnvUsd("DAILY_CAP_USD", process.env.DAILY_CAP_USD, 0);
export const WEEKLY_CAP_USD = parseCapEnvUsd("WEEKLY_CAP_USD", process.env.WEEKLY_CAP_USD, 0);

export const TRUSTED_DAILY_CAP_USD = parseCapEnvUsd(
  "TRUSTED_DAILY_CAP_USD",
  process.env.TRUSTED_DAILY_CAP_USD,
  10,
);
export const TRUSTED_WEEKLY_CAP_USD = parseCapEnvUsd(
  "TRUSTED_WEEKLY_CAP_USD",
  process.env.TRUSTED_WEEKLY_CAP_USD,
  25,
);

// Admins run cross-account spend checks and batch fixes (0002_rls.sql's
// is_admin() read access), so they need real headroom above the per-editor
// ceilings above, not a scaled copy of one of them — "admin keeps its
// current higher ceiling" (the proposal's own words) means
// ADMIN_DAILY_CAP_USD's default is UNCHANGED by this rewrite (still 100).
export const ADMIN_DAILY_CAP_USD = parseCapEnvUsd(
  "ADMIN_DAILY_CAP_USD",
  process.env.ADMIN_DAILY_CAP_USD,
  100,
);
// No number for this was specified by the proposal — admins didn't have a
// weekly figure before this feature at all. Defaults to 7x
// ADMIN_DAILY_CAP_USD rather than a fresh literal: that keeps the weekly
// figure from ever being the practical binding constraint for an admin by
// default (unlike the editor tiers, where the weekly allowance IS meant to
// bind before the daily guard does — see the file header), which matches
// "admin keeps its higher ceiling" for the window this feature adds without
// anyone having chosen a specific admin weekly number yet.
export const ADMIN_WEEKLY_CAP_USD = parseCapEnvUsd(
  "ADMIN_WEEKLY_CAP_USD",
  process.env.ADMIN_WEEKLY_CAP_USD,
  7 * ADMIN_DAILY_CAP_USD,
);

// Fresh app_settings value. Admins can change its amount, window, or enabled state.
export const DEFAULT_GLOBAL_SPEND_CAP_USD = 100;

// Hybrid Editor and AI Animator (0131) each have their own caps (owner, 2026-11-09), set
// relative to the team-wide global cap rather than to the editor tiers: an unset var means
// the global cap's own default for daily and 7x it for weekly, so in practice the global
// cap (and any per-account override or grant) is what binds. Set these in render.yaml to
// give either role a tighter ceiling of its own.
export const HYBRID_EDITOR_DAILY_CAP_USD = parseCapEnvUsd(
  "HYBRID_EDITOR_DAILY_CAP_USD",
  process.env.HYBRID_EDITOR_DAILY_CAP_USD,
  DEFAULT_GLOBAL_SPEND_CAP_USD,
);
export const HYBRID_EDITOR_WEEKLY_CAP_USD = parseCapEnvUsd(
  "HYBRID_EDITOR_WEEKLY_CAP_USD",
  process.env.HYBRID_EDITOR_WEEKLY_CAP_USD,
  7 * DEFAULT_GLOBAL_SPEND_CAP_USD,
);
export const AI_ANIMATOR_DAILY_CAP_USD = parseCapEnvUsd(
  "AI_ANIMATOR_DAILY_CAP_USD",
  process.env.AI_ANIMATOR_DAILY_CAP_USD,
  DEFAULT_GLOBAL_SPEND_CAP_USD,
);
export const AI_ANIMATOR_WEEKLY_CAP_USD = parseCapEnvUsd(
  "AI_ANIMATOR_WEEKLY_CAP_USD",
  process.env.AI_ANIMATOR_WEEKLY_CAP_USD,
  7 * DEFAULT_GLOBAL_SPEND_CAP_USD,
);

/**
 * The one place a role turns into its DEFAULT daily ceiling — used only as
 * the fallback inside resolveAccountCaps below (and directly by tests /
 * anywhere that genuinely wants "what would this role get with no
 * override"). Real callers that have an account in hand should reach for
 * resolveAccountCaps, not this, so a per-account override actually takes
 * effect.
 */
export function dailyCapForRole(role: ProfileRole): number {
  switch (role) {
    case "admin":
      return ADMIN_DAILY_CAP_USD;
    case "trusted_editor":
      return TRUSTED_DAILY_CAP_USD;
    case "hybrid_editor":
      return HYBRID_EDITOR_DAILY_CAP_USD;
    case "ai_animator":
      return AI_ANIMATOR_DAILY_CAP_USD;
    case "editor":
      return DAILY_CAP_USD;
  }
}

/** weeklyCapForRole's daily twin — see dailyCapForRole's doc comment. */
export function weeklyCapForRole(role: ProfileRole): number {
  switch (role) {
    case "admin":
      return ADMIN_WEEKLY_CAP_USD;
    case "trusted_editor":
      return TRUSTED_WEEKLY_CAP_USD;
    case "hybrid_editor":
      return HYBRID_EDITOR_WEEKLY_CAP_USD;
    case "ai_animator":
      return AI_ANIMATOR_WEEKLY_CAP_USD;
    case "editor":
      return WEEKLY_CAP_USD;
  }
}

/**
 * The subset of a `profiles` row resolveAccountCaps needs — every real
 * caller already has a full profile row (requireUser/requireProject/
 * requireScene all `select("*")`), so this is satisfied by just passing
 * `profile` through, never a reason to fetch anything extra.
 */
export interface AccountCapProfile {
  role: ProfileRole;
  daily_cap_override_usd: number | null;
  weekly_cap_override_usd: number | null;
  hourly_cap_override_usd?: number | null;
  /** profiles.global_cap_exempt (0133): the team-wide cap never blocks this account. */
  global_cap_exempt?: boolean | null;
  /** profiles.daily_cap_enabled (0134): null follows the installation setting. */
  daily_cap_enabled?: boolean | null;
}

/**
 * Whether the daily burst guard applies to this account: its own switch (0134)
 * if an admin set one, otherwise the installation setting.
 */
export function dailyCapAppliesTo(
  profile: AccountCapProfile,
  installationEnabled: boolean,
): boolean {
  return profile.daily_cap_enabled ?? installationEnabled;
}

/**
 * Whether the team-wide cap can block this account. An admin can exempt one
 * account (0133); its spend still counts toward the team total either way.
 */
export function globalCapAppliesTo(profile: AccountCapProfile): boolean {
  return profile.global_cap_exempt !== true;
}

export type GlobalSpendCapPeriod = "daily" | "weekly";

export interface GlobalSpendCapSettings {
  enabled: boolean;
  capUsd: number;
  period: GlobalSpendCapPeriod;
}

const DEFAULT_GLOBAL_SPEND_CAP_SETTINGS: GlobalSpendCapSettings = {
  enabled: true,
  capUsd: DEFAULT_GLOBAL_SPEND_CAP_USD,
  period: "daily",
};

export interface AccountCaps {
  dailyCapUsd: number;
  weeklyCapUsd: number;
}

/**
 * THE one place an account's actual caps are resolved: its own override
 * (profiles.daily_cap_override_usd / weekly_cap_override_usd,
 * 0031_account_allowances.sql) if an admin has set one, else its role's
 * default. Every real call site in this codebase — actions/enqueue.ts's
 * five render paths, the eight other paid call sites via
 * assertWithinSpendCaps, the render page's UI figures, the sidebar — goes
 * through this rather than capForRole/dailyCapForRole/weeklyCapForRole
 * directly, so "what can this account spend" never drifts between the
 * number a page quotes and the number a Server Action enforces.
 */
export function resolveAccountCaps(profile: AccountCapProfile): AccountCaps {
  const weeklyCapUsd = profile.weekly_cap_override_usd ?? weeklyCapForRole(profile.role);

  // A ROLE-DEFAULT daily of 0 means "no daily guard configured", NOT "this
  // account may spend nothing today" — and the difference is the whole
  // reason this branch exists.
  //
  // DAILY_CAP_USD's default is 0 (see its own comment above: a new account
  // spends nothing until an admin acts). The WEEKLY figure is what carries
  // that intent — it is the real allocation, and it is what a grant raises.
  // The daily figure is a burst guard on top of it. Reading an unconfigured
  // 0 as a hard daily ceiling means an account with a perfectly good weekly
  // allowance — $25 by override, or a fresh grant an admin just approved —
  // is refused every render the moment the installation turns the daily
  // guard on, and NOTHING can fix it: getEffectiveWeeklyCapUsd folds grants
  // into the weekly ceiling only, by design, so no grant can lift a daily
  // figure. A supported, documented toggle would freeze the whole team.
  //
  // So an unconfigured daily guard falls back to the weekly allowance,
  // which the clamp below then makes exactly equal to it — a guard that
  // never binds tighter than the budget it guards, i.e. no guard at all,
  // which is the honest meaning of "nobody has set one".
  //
  // An EXPLICIT override of 0 is left alone and still means zero. That is a
  // deliberate admin action with its own documented purpose — see
  // dailyCapOverrideError: "a zero DAILY figure is the narrower pause of the
  // two — it stops today's renders without touching the week's allowance".
  // `??` is load-bearing here rather than `||`: it distinguishes "no
  // override" (null) from "an override of 0", which is the entire
  // distinction this comment is about.
  const roleDailyCapUsd = dailyCapForRole(profile.role);
  const dailyCapUsd =
    profile.daily_cap_override_usd ?? (roleDailyCapUsd === 0 ? weeklyCapUsd : roleDailyCapUsd);

  return {
    // THE DAILY GUARD IS NEVER LOOSER THAN THE ALLOWANCE IT GUARDS.
    //
    // A daily figure at or above the weekly one cannot ever fire:
    // assertWithinSpendCaps checks global -> weekly -> hourly -> daily, so the weekly
    // allowance refuses first and the "burst guard" is inert by
    // construction. It is not a second budget — see this file's header:
    // "a guard against front-loading it, not a second independent budget".
    // Storing 1,000 cr/day against 1 cr/week is expressible, meaningless,
    // and until now was rendered to admins on /users as though it meant
    // something.
    //
    // Clamped HERE, not validated at the write, deliberately. This function
    // is the one place caps resolve — enforcement, /users, /allowances, the
    // account menu and the render page all come through it — so one min()
    // makes the incoherent pair unobservable everywhere at once. A write-
    // time check could not: daily_cap_override_usd has been settable by
    // hand-written SQL since 0031_account_allowances.sql (it had no UI at
    // all until setDailyCapOverride), and two admins editing the two
    // columns in separate tabs can each write a value that is valid against
    // the other's stale figure. Clamping on read has no such race, and
    // costs nothing: it never changes what is ENFORCED, only what is
    // claimed, because the weekly ceiling was already the binding one in
    // exactly the cases this touches.
    dailyCapUsd: Math.min(dailyCapUsd, weeklyCapUsd),
    weeklyCapUsd,
  };
}

/**
 * Throws when `spentTodayUsd + estimatedUsd` would exceed `capUsd`. Landing
 * exactly on the cap is allowed (`projected === capUsd` does not throw) —
 * only going over does.
 *
 * This is the PER-ACCOUNT DAILY BURST GUARD (`spentTodayUsd` comes from
 * getDailySpend(userId)) — see assertWeeklyCapNotExceeded for the weekly
 * allowance twin and assertGlobalCapNotExceeded for the team-wide one. The
 * message deliberately says "your"/"you" throughout AND names this a
 * "daily burst guard", not just "your daily cap": an editor who reads this
 * needs to know the remedy is "wait until tomorrow" (the guard resets at
 * Manila reset), which is a different, narrower problem than "you're out
 * of allowance for the week" (assertWeeklyCapNotExceeded) or "the team is
 * out" (assertGlobalCapNotExceeded) — see this file's header for why all
 * three have to stay legible from the message text alone.
 */
export function assertCapNotExceeded(
  spentTodayUsd: number,
  estimatedUsd: number,
  capUsd: number,
): void {
  const projectedUsd = spentTodayUsd + estimatedUsd;
  if (projectedUsd > capUsd) {
    throw new Error(
      `This render would bring your spend today to $${projectedUsd.toFixed(2)}, over your ` +
        `$${capUsd.toFixed(2)} daily burst guard ($${spentTodayUsd.toFixed(2)} already spent ` +
        `today, this render is estimated at $${estimatedUsd.toFixed(2)}). You've hit today's ` +
        "burst guard — wait until 5:00 AM Manila time, or ask an admin to raise your daily allowance. " +
        "Refusing to enqueue.",
    );
  }
}

/**
 * assertCapNotExceeded's weekly twin — the same landing-exactly-on-the-cap-
 * is-fine arithmetic, checked against `spentThisWeekUsd` (getWeeklySpend)
 * and an account's resolved weekly allowance instead of its daily burst
 * guard.
 *
 * This is the check that represents the REAL periodic allocation the
 * proposal describes (see this file's header) — an editor who trips this
 * is out of allowance until the calendar week resets (Monday 05:00 Manila),
 * not until tomorrow, so the message says "Monday" explicitly rather than
 * the daily guard's "tomorrow": conflating the two would send someone to
 * wait one day for an allowance that isn't actually coming back for up to
 * six.
 */
export function assertWeeklyCapNotExceeded(
  spentThisWeekUsd: number,
  estimatedUsd: number,
  capUsd: number,
): void {
  const projectedUsd = spentThisWeekUsd + estimatedUsd;
  if (projectedUsd > capUsd) {
    // "You've used this week's allowance — wait until Monday" is FALSE for
    // an account that has no allowance at all, and it is the first thing a
    // new account ever hears from this system. Both halves mislead: they
    // have not used anything, and Monday will not change a thing, because a
    // weekly window resetting to zero still leaves zero. It sends someone to
    // wait out a cap that was never going to lift, when the actual next step
    // is to ask a person.
    //
    // Reachable by design, not by accident: the regular-editor default is 0
    // (see DAILY_CAP_USD/WEEKLY_CAP_USD above), so every account meets this
    // branch — not the one below — until an admin grants it something.
    if (capUsd <= 0) {
      throw new Error(
        "You don't have a weekly allowance yet, so this render can't be queued " +
          `(it's estimated at $${estimatedUsd.toFixed(2)}). Ask an admin to set one for your ` +
          "account, or request an allowance from the account menu. Refusing to enqueue.",
      );
    }
    throw new Error(
      `This render would bring your spend this week to $${projectedUsd.toFixed(2)}, over your ` +
        `$${capUsd.toFixed(2)} weekly allowance ($${spentThisWeekUsd.toFixed(2)} already spent ` +
        `this week, this render is estimated at $${estimatedUsd.toFixed(2)}). You've used this ` +
        "week's allowance — wait until 5:00 AM Monday Manila time, or ask an admin to raise your weekly allowance. " +
        "Refusing to enqueue.",
    );
  }
}

/**
 * Throws when `globalSpentUsd + estimatedUsd` would exceed `capUsd` —
 * the same landing-exactly-on-the-cap-is-fine arithmetic as
 * assertCapNotExceeded, checked against the TEAM's total
 * getGlobalSpend's selected window and global cap instead of one
 * account's.
 *
 * A deliberately separate function rather than a `scope` parameter bolted
 * onto assertCapNotExceeded: the two guards fail for unrelated reasons that
 * an editor needs to be able to tell apart from the message alone —
 * "you personally are over budget" vs. "the team has used up today's
 * shared budget, unrelated to your own usage" are different problems with
 * different remedies, and an editor who gets the wrong one will file the
 * wrong complaint (or worse, wait for their own cap to reset when it was
 * never theirs to wait out). A shared template with a scope flag threaded
 * through it is exactly the kind of "same shape, different meaning" collapse
 * that quietly produces the wrong message the day someone edits one string
 * and not the other; separate functions can't drift that way.
 */
export function assertGlobalCapNotExceeded(
  globalSpentUsd: number,
  estimatedUsd: number,
  capUsd: number,
  period: GlobalSpendCapPeriod = "daily",
): void {
  const projectedUsd = globalSpentUsd + estimatedUsd;
  if (projectedUsd > capUsd) {
    const periodLabel = period === "weekly" ? "this week" : "today";
    const resetLabel =
      period === "weekly" ? "5:00 AM Monday Manila time" : "5:00 AM Manila time tomorrow";
    throw new Error(
      `This render would bring the WHOLE TEAM's spend ${periodLabel} to $${projectedUsd.toFixed(2)}, over ` +
        `the $${capUsd.toFixed(2)} global ${period} cap ($${globalSpentUsd.toFixed(2)} already ` +
        `spent by everyone ${periodLabel}, this render is estimated at $${estimatedUsd.toFixed(2)}). The team ` +
        `has hit the ${period} limit — this is not about your own usage. Wait until ${resetLabel}, ` +
        "or ask an admin to raise the global cap. Refusing to enqueue.",
    );
  }
}

export function assertHourlyCapNotExceeded(
  hourlySpentUsd: number,
  estimatedUsd: number,
  capUsd: number,
): void {
  const projectedUsd = hourlySpentUsd + estimatedUsd;
  if (projectedUsd > capUsd) {
    throw new Error(
      `This render would bring your spend in the last hour to $${projectedUsd.toFixed(2)}, over ` +
        `your $${capUsd.toFixed(2)} hourly cap ($${hourlySpentUsd.toFixed(2)} already used). ` +
        "Wait for earlier spend to age out, or ask an admin to raise your hourly cap. Refusing to enqueue.",
    );
  }
}

export function assertTokenMonthlyCapNotExceeded(
  monthlySpentUsd: number,
  estimatedUsd: number,
  capUsd: number,
): void {
  const projectedUsd = monthlySpentUsd + estimatedUsd;
  if (projectedUsd > capUsd) {
    throw new Error(
      `This render would bring this API token's spend this month to $${projectedUsd.toFixed(2)}, over ` +
        `its $${capUsd.toFixed(2)} monthly cap ($${monthlySpentUsd.toFixed(2)} already used this month, ` +
        `this render is estimated at $${estimatedUsd.toFixed(2)}). Raise or clear the token's monthly cap ` +
        "in API Tokens settings. Refusing to enqueue.",
    );
  }
}

/**
 * Refuses when kie.ai's real dollar balance (lib/kie-balance.ts) cannot
 * cover `estimatedUsd`. This is the fourth spend-cap check — global/weekly/
 * daily above all bound what THIS APP is willing to let someone spend, none
 * of them has ever known what the vendor itself has left, and every spend
 * cap in this app sits ABOVE the real vendor balance today. Without this
 * check, an account that runs dry mid-day surfaces to an editor as an
 * unexplained scene failure — the internal caps all still say "fine" right
 * up until the vendor itself refuses the submission.
 *
 * Named for the era when fal and kie were both live and this function had
 * to be told which vendor's balance to check (assertVendorBalanceCovers
 * Estimate, a `vendor` parameter, lib/vendor-routing.ts's resolveVendor
 * deciding which one). fal is decommissioned; kie is the only vendor left
 * to ask about, so there is nothing left to route.
 *
 * Same pure-throwing shape as assertCapNotExceeded/assertWeeklyCapNotExceeded/
 * assertGlobalCapNotExceeded above, and run through guardResult by
 * assertWithinSpendCaps the same way — but the balance-gate STEP as a whole
 * is checked FIRST, ahead of global/weekly/daily, not after them as the
 * "fourth" ordinal might suggest: if kie cannot fund this render, that is
 * true independent of and prior to whether any per-account or team cap has
 * room, and it is the more informative fact to hand back. Telling someone
 * "you're over your weekly allowance" when the actual problem is "the
 * account has no money at all" sends them to wait out a cap that was never
 * the real blocker.
 *
 * The message is deliberately written for an EDITOR, who cannot fund the
 * vendor account themselves: no raw vendor error, no balance figure they
 * could do nothing with beyond feeling alarmed by it — just what happened
 * and who can act on it. Whether admins get to see the real number is
 * handled elsewhere (the /spend page, next to the other money figures
 * admins already look at) — never inside this refusal, which can be
 * triggered by any role.
 *
 * NOTE — this is still just the pre-flight snapshot lib/spend.ts's other
 * later checks already are: a point-in-time read with nothing reserving the
 * estimate between this check and the caller's own write (same CONCURRENCY
 * HOLE as every other cap here). The worker's own handling of kie's actual
 * insufficient-balance refusal at submission time
 * (worker/internal/kie/client.go, worker/internal/loop/dispatch.go) is the
 * real backstop for whatever slips past this snapshot — this check exists
 * to make the COMMON case an informative refusal instead of a mystery
 * failure, not to make the race impossible.
 */
export function assertKieBalanceCoversEstimate(balanceUsd: number, estimatedUsd: number): void {
  if (balanceUsd < estimatedUsd) {
    throw new Error(
      "Rendering is temporarily unavailable — the kie.ai account needs additional funding. " +
        "Ask an admin to fund the account, then try again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Asia/Manila day and calendar-week boundaries — see this file's header for
// why. Manila is a fixed UTC+8 offset with no DST, so this needs only
// arithmetic, not a timezone database.
// ---------------------------------------------------------------------------
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const RESET_HOUR_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Manila-local calendar date (and day-of-week) an instant falls on.
 * Shifting `instant` by the fixed +8h offset and reading its UTC fields
 * back out is the standard trick for a fixed-offset zone: the shifted
 * Date's UTC year/month/day/weekday ARE the target zone's local
 * year/month/day/weekday, with no timezone-aware formatting needed.
 */
function manilaDateParts(instant: Date): {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday, 1 = Monday, ..., matching Date.prototype.getUTCDay(). */
  weekday: number;
} {
  const shifted = new Date(instant.getTime() + MANILA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/** The UTC instant of Manila midnight on the given Manila-local date. */
function manilaMidnightUtcIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day) - MANILA_OFFSET_MS).toISOString();
}

/** The UTC instant of 05:00 Manila on the given Manila-local date. */
function manilaFiveAmUtcIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day) + RESET_HOUR_MS - MANILA_OFFSET_MS).toISOString();
}

function manilaResetDateParts(instant: Date): ReturnType<typeof manilaDateParts> {
  return manilaDateParts(new Date(instant.getTime() - RESET_HOUR_MS));
}

/**
 * Start of the current Manila day, as a UTC ISO timestamp. Exported (not
 * just used internally) so the day-boundary arithmetic itself is
 * unit-testable against known instants without a live database — see
 * spend.test.ts.
 */
export function startOfManilaDayIso(now: Date = new Date()): string {
  const { year, month, day } = manilaResetDateParts(now);
  return manilaFiveAmUtcIso(year, month, day);
}

/**
 * Start of the current Manila calendar week (Monday 05:00 Manila), as a UTC
 * ISO timestamp. Exported for the same testability reason as
 * startOfManilaDayIso above.
 */
export function startOfManilaWeekIso(now: Date = new Date()): string {
  const { year, month, day, weekday } = manilaResetDateParts(now);
  // getUTCDay(): 0=Sun, 1=Mon, ..., 6=Sat. Days since the most recent Monday:
  // Mon->0, Tue->1, ..., Sat->5, Sun->6.
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(Date.UTC(year, month, day) - daysSinceMonday * DAY_MS);
  return manilaFiveAmUtcIso(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
}

/**
 * Start of the current Manila calendar month (1st of month 00:00 Manila), as a
 * UTC ISO timestamp. Used by per-token monthly cap enforcement.
 */
export function startOfManilaMonthIso(now: Date = new Date()): string {
  const { year, month } = manilaDateParts(now);
  return manilaMidnightUtcIso(year, month, 1);
}

export function startOfRollingHourIso(now: Date = new Date()): string {
  return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
}

/**
 * End of the current Manila calendar week — the following Monday 05:00
 * Manila — as a UTC ISO timestamp. startOfManilaWeekIso's twin, exactly one
 * week later (`+ 7 * DAY_MS` on the same UTC instant, not a second call to
 * manilaDateParts — the week boundary is a fixed 7*24h span in this
 * fixed-offset zone, so there is nothing DST could shift here to justify
 * recomputing from scratch).
 *
 * This is the default `expires_at` for a new allowance grant
 * (web/actions/allowance.ts's decideAllowanceRequest) — a grant lasts
 * exactly as long as the weekly allowance window it tops up unless an admin
 * explicitly extends it. See 0032_allowance_requests.sql's header for why a
 * grant without an expiry would silently outlive the week it was meant for.
 */
export function endOfManilaWeekIso(now: Date = new Date()): string {
  return new Date(new Date(startOfManilaWeekIso(now)).getTime() + 7 * DAY_MS).toISOString();
}

/**
 * Next 05:00 Manila reset. The default `expires_at` of an approved allowance request
 * (owner, 2026-11-11): a grant is for TODAY, raising both the daily and the weekly
 * ceiling until the next 05:00 reset. What it paid for still counts as this week's spend.
 */
export function endOfManilaDayIso(now: Date = new Date()): string {
  return new Date(new Date(startOfManilaDayIso(now)).getTime() + DAY_MS).toISOString();
}

/**
 * The daily ceiling with active grants on top: a grant raises the daily figure by the
 * same amount it raises the weekly one (effectiveWeeklyCapUsd - caps.weeklyCapUsd), and
 * the daily figure is still never looser than the weekly one it guards.
 */
export function effectiveDailyCapUsd(caps: AccountCaps, effectiveWeeklyCapUsd: number): number {
  const grantsUsd = Math.max(0, effectiveWeeklyCapUsd - caps.weeklyCapUsd);
  return Math.min(caps.dailyCapUsd + grantsUsd, effectiveWeeklyCapUsd);
}

/**
 * Sums `runs.cost_usd` for every run belonging to a project owned by
 * `userId`, created since the start of the current Manila day, via
 * `user_spend_usd` (0031_account_allowances.sql) — aggregated in SQL, not
 * fetched and reduced in application code (see that migration's header for
 * why the old fetch-and-reduce version of this function stopped being
 * tolerable once a second window needed the same query). Uses the admin
 * client because this is a cross-user-owned-row aggregate query that RLS
 * has no policy for — callers must already have run `requireUser` /
 * `requireProject` before reaching this.
 *
 * `user_spend_usd` joins `runs -> projects` directly on `runs.project_id`
 * (0030_runs_project_id.sql), the same join RLS's runs_select policy uses,
 * so this counts every paid call site's runs (character reference,
 * composite, per-scene and full-script compiles, every render) the same way
 * RLS itself attributes them.
 */
export async function getDailySpend(userId: string): Promise<number> {
  const admin = createAdminClient();
  return getUserSpendUsd(admin, userId, startOfManilaDayIso(), new Date().toISOString());
}

/**
 * getDailySpend's weekly twin: sums the same account's runs since the start
 * of the current Manila calendar week (Monday 05:00 Manila) instead of the
 * current Manila day. Backs the weekly allowance check
 * (assertWeeklyCapNotExceeded) — see this file's header for why the window
 * is a calendar week, not a rolling 7 days.
 */
export async function getWeeklySpend(userId: string): Promise<number> {
  const admin = createAdminClient();
  return getUserSpendUsd(admin, userId, startOfManilaWeekIso(), new Date().toISOString());
}

/**
 * Sum of `amount_usd` for every one of this account's `allowance_grants`
 * (0032_allowance_requests.sql) that has not yet expired as of `atIso` — via
 * `user_active_grants_usd`, the grants twin of `user_spend_usd` above (same
 * shape, same security posture; see that migration's header). Admin client,
 * same reasoning as getDailySpend/getWeeklySpend: this is a cross-user-owned-
 * row aggregate every non-admin caller (an editor checking their own
 * headroom) has no RLS policy granting them directly, and every real caller
 * here has already cleared requireUser/requireProject/requireScene.
 *
 * A grant NEVER raises the daily burst guard — see getEffectiveWeeklyCapUsd
 * below, the only place this is folded into a cap. Callers that need the
 * account's plain daily figure keep calling dailyCapForRole/resolveAccountCaps
 * directly, untouched by this function.
 */
export async function getActiveGrantsUsd(
  userId: string,
  atIso: string = new Date().toISOString(),
): Promise<number> {
  const admin = createAdminClient();
  return getUserActiveGrantsUsd(admin, userId, atIso);
}

/** getActiveGrantsUsd's own doc comment; this is its per-grant detail twin. */
export interface ActiveGrantsSummary {
  /** Sum of amount_usd across every unexpired grant. NOT necessarily the same read as getActiveGrantsUsd's RPC-computed sum — see getActiveGrantsSummary's own doc comment for why callers that need the CAP figure to match enforcement should keep deriving it from getEffectiveWeeklyCapUsd instead of this field. */
  totalUsd: number;
  count: number;
  /** The soonest expires_at among unexpired grants, or null when there are none — "which grant changes the number next". */
  earliestExpiresAt: string | null;
  /**
   * The three-way split of totalUsd by WHERE each active row came from
   * (0087_pass_allowance.sql). They sum back to it:
   * `grantedInUsd + receivedUsd − passedOutUsd === totalUsd`.
   *
   * Split on `transfer_peer_id`, which is null on every grant an approver
   * issued and non-null on both halves of a pass. It exists because the
   * three read completely differently to the person looking at them — an
   * admin decided to give you this, a colleague handed you that, and you
   * gave this other bit away — while the CAP arithmetic cannot tell them
   * apart and must not try. No cap figure anywhere is derived from these
   * fields.
   */
  grantedInUsd: number;
  /** Active +rows received from a peer. Positive. */
  receivedUsd: number;
  /** Active −rows passed away, reported POSITIVE — the amount that LEFT. Every display of it is a "−" line, so the sign lives in the label, not in the number. */
  passedOutUsd: number;
}

/**
 * getActiveGrantsUsd's display-detail twin: the actual unexpired
 * allowance_grants rows for one account (amount + expiry), not just their
 * sum, so a caller can show "which grant, expiring when" (Part 2 of the
 * task that added this: "+$5.00 grant (expires Sun)") rather than a bare
 * total. A plain filtered select, not a SQL aggregate function like
 * user_active_grants_usd — this is scoped to ONE account's own grants,
 * which in practice never number more than a handful (an admin manually
 * approves each one), the same per-account-bounded shape app/(app)/profile/
 * page.tsx already queries this exact table with directly. This is NOT the
 * max_rows = 1000 risk lib/db-aggregates.ts's team-wide/all-accounts sums
 * exist to avoid — that risk is about summing across every account without
 * a LIMIT, not about one account's own small row count.
 *
 * Callers needing the DOLLAR FIGURE that has to agree with enforcement
 * (getEffectiveWeeklyCapUsd, assertWeeklyCapNotExceeded) should keep
 * deriving it the way getAccountBudgetSnapshot below does — as
 * effectiveWeeklyCapUsd minus the plain role/override cap, not from this
 * function's own totalUsd — so the breakdown UI's arithmetic is guaranteed
 * to sum to the exact figure enforcement already computed, not a second,
 * independently-fetched number that happens to usually agree. This
 * function exists only for the two fields that number can't give you:
 * how many grants, and when the soonest one expires.
 */
export async function getActiveGrantsSummary(
  userId: string,
  atIso: string = new Date().toISOString(),
): Promise<ActiveGrantsSummary> {
  const admin = createAdminClient();
  // transfer_peer_id rides along on the SAME select (0087_pass_allowance.sql)
  // — one more column on a query already being made, not a second round trip
  // and not a new SQL function. It is what separates a grant an approver
  // issued from either half of a pass; see ActiveGrantsSummary's own doc
  // comment for why that distinction is display-only. Stated HERE rather than
  // inside the builder chain below: lib/revoked-grants-drift.test.ts reads
  // that chain up to its first semicolon, and a comment carrying one truncates
  // the window it checks.
  const { data, error } = await admin
    .from("allowance_grants")
    .select("amount_usd, expires_at, transfer_peer_id")
    .eq("user_id", userId)
    .gt("expires_at", atIso)
    // Same "active" predicate user_active_grants_usd enforces in SQL
    // (0075_revoke_allowance_grants.sql): unexpired AND not revoked. Stated
    // by hand here because this is a row select, not that aggregate — which
    // is exactly why lib/revoked-grants-drift.test.ts names this call site.
    .is("revoked_at", null)
    .order("expires_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load active allowance grants for user ${userId}: ${error.message}`);
  }

  const rows = data ?? [];
  // One pass over rows this function already had in hand. `count` still
  // counts every active row, passes included: it answers "is there a grant
  // line to draw at all", and a received pass is a line.
  let grantedInUsd = 0;
  let receivedUsd = 0;
  let passedOutUsd = 0;
  for (const row of rows) {
    if (row.transfer_peer_id === null) {
      grantedInUsd += row.amount_usd;
    } else if (row.amount_usd < 0) {
      // Reported POSITIVE — see passedOutUsd's doc comment. The row itself
      // stays negative, which is what makes the cap arithmetic work without
      // any of the six grant aggregates learning about passes.
      passedOutUsd -= row.amount_usd;
    } else {
      receivedUsd += row.amount_usd;
    }
  }

  return {
    totalUsd: rows.reduce((sum, row) => sum + row.amount_usd, 0),
    count: rows.length,
    earliestExpiresAt: rows[0]?.expires_at ?? null,
    grantedInUsd,
    receivedUsd,
    passedOutUsd,
  };
}

/**
 * The account's EFFECTIVE weekly allowance: resolveAccountCaps(profile).
 * weeklyCapUsd (role default or admin override) plus the sum of its
 * currently-unexpired allowance_grants. This is the number
 * assertWeeklyCapNotExceeded and getRemainingWeeklyBudget actually check
 * spend against — see decision 1 in the allowance-request workflow (a grant
 * raises the WEEKLY allowance only, never the daily burst guard, which is
 * why there is no equivalent "effective daily cap" function here).
 */
export async function getEffectiveWeeklyCapUsd(
  userId: string,
  profile: AccountCapProfile,
): Promise<number> {
  const caps = resolveAccountCaps(profile);
  const activeGrantsUsd = await getActiveGrantsUsd(userId);
  return caps.weeklyCapUsd + activeGrantsUsd;
}

/**
 * Legacy daily-only report total. Current enforcement uses getGlobalSpend
 * for the selected daily or weekly window.
 *
 * Aggregates in SQL — via spend_total_usd(from_ts, to_ts), a
 * `sum(cost_usd) ... group by` Postgres function added by
 * supabase/migrations/0026_cost_aggregates.sql and called here through
 * web/lib/db-aggregates.ts's getSpendTotalUsd — rather than pulling
 * matching rows and reducing them in JS. That's deliberate, not a style
 * preference: an audit found /spend (app/(app)/spend/page.tsx) already
 * silently under-reporting past Supabase's 1000-row `max_rows` response
 * ceiling (supabase/config.toml) by doing exactly that — pull rows,
 * `.reduce()` in JS — which quietly truncates once a day's run count passes
 * 1000 rather than erroring. A per-user total staying under 1000 rows/day is
 * plausible; a TEAM total across every account hitting it is not a
 * hypothetical this function can risk. SUM()/GROUP BY in Postgres has no
 * equivalent row cap, so there is nothing to silently cross.
 *
 * Uses the admin client, not a caller's session client — deliberately, and
 * unlike how /spend itself calls getSpendTotalUsd. /spend is reachable only
 * by an admin, whose own RLS-visible rows already cover everyone else's
 * (0002_rls.sql's is_admin() policies), so its regular session client
 * returns the true total. Every spend path in actions/enqueue.ts is called
 * by ANY account, not just admins — calling spend_total_usd (SECURITY
 * INVOKER) through a non-admin's session client would apply that account's
 * own RLS and silently return only THEIR OWN spend, collapsing the global
 * check into a duplicate of the per-account one. The admin client's service
 * role has BYPASSRLS, so this always returns the true cross-account total
 * regardless of who triggered the call — the same reason getDailySpend
 * above uses the admin client for its own (RLS-unpolicied) aggregate.
 */
/**
 * The installation's daily-guard default (app_settings, 0077).
 *
 * Reads through the admin client for the same reason getDailySpend does: the
 * callers are every account, not just admins, and this must return the real
 * value regardless of who triggered the render. The row is a single
 * primary-key lookup on a one-row table, and every caller fires it alongside
 * reads it was already making, so it costs no extra round trip of latency.
 *
 * Fails CLOSED to `false` — the guard OFF — on a read failure, and that
 * direction is deliberate. The weekly allowance and enabled global cap are
 * both still enforced whatever this returns, so a failed read cannot let
 * spend past the ceilings that bound it; the worst case is a burst guard not
 * applying for the length of an outage. The other direction would refuse
 * renders that every real ceiling permits, which is an outage of the product
 * to protect a limit that is not the one holding the line.
 */
// cache(): one app_settings read per request. A page renders the sidebar, the
// budget snapshot and the spend checks, and each used to read this row again.
export const getUserDailyCapEnabled = cache(async (): Promise<boolean> => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("app_settings")
    .select("user_daily_cap_enabled")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("getUserDailyCapEnabled: app_settings unreadable, daily guard off", error);
    return false;
  }
  return data?.user_daily_cap_enabled ?? false;
});

// cache(): same reason as getUserDailyCapEnabled above.
export const getGlobalSpendCapSettings = cache(async (): Promise<GlobalSpendCapSettings> => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("app_settings")
    .select("global_spend_cap_enabled, global_spend_cap_usd, global_spend_cap_period")
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.error("getGlobalSpendCapSettings: using the conservative default", error);
    return DEFAULT_GLOBAL_SPEND_CAP_SETTINGS;
  }
  return {
    enabled: data.global_spend_cap_enabled ?? DEFAULT_GLOBAL_SPEND_CAP_SETTINGS.enabled,
    capUsd: data.global_spend_cap_usd ?? DEFAULT_GLOBAL_SPEND_CAP_SETTINGS.capUsd,
    period: data.global_spend_cap_period ?? DEFAULT_GLOBAL_SPEND_CAP_SETTINGS.period,
  };
});

export async function getGlobalSpend(
  settings: GlobalSpendCapSettings,
  now: Date = new Date(),
): Promise<number> {
  const admin = createAdminClient();
  const start = settings.period === "weekly" ? startOfManilaWeekIso(now) : startOfManilaDayIso(now);
  return getSpendTotalUsd(admin, start, now.toISOString());
}

export async function getGlobalSpendSnapshot(
  now: Date = new Date(),
): Promise<{ settings: GlobalSpendCapSettings; spentUsd: number }> {
  const settings = await getGlobalSpendCapSettings();
  return { settings, spentUsd: await getGlobalSpend(settings, now) };
}

/** Legacy daily-only total used by historical reports; enforcement uses getGlobalSpend. */
export async function getGlobalDailySpend(): Promise<number> {
  const admin = createAdminClient();
  return getSpendTotalUsd(admin, startOfManilaDayIso(), new Date().toISOString());
}

export async function getHourlySpend(userId: string, now: Date = new Date()): Promise<number> {
  const admin = createAdminClient();
  return getUserSpendUsd(admin, userId, startOfRollingHourIso(now), now.toISOString());
}

/** Scene statuses whose cost is committed but not yet in `runs`. */
const IN_FLIGHT_STATUSES = ["queued", "rendering"] as const;

/** Estimated spend already committed to renders that have not landed yet. */
export interface InFlightSpend {
  /** Every account's in-flight estimate, for the selected global window. */
  globalUsd: number;
  /** Per owning account, for weekly, hourly, and daily caps. */
  byUserUsd: Map<string, number>;
  /** Per API token, for monthly token caps. */
  byTokenUsd: Map<string, number>;
}

/**
 * What the spend caps above cannot see: renders already paid for in all but
 * name.
 *
 * `runs` rows are written by the worker's MarkDone/MarkFailed at COMPLETION,
 * not at submit — so from the moment a scene flips to 'queued' until it
 * finishes, its cost is invisible to every spend cap in this file. That window is
 * the length of a render: an editor measured four minutes for one Seedance
 * Mini scene. Two operators confirming inside it both read a total that is
 * missing the other's work, both project under the cap, and both proceed.
 *
 * This is why the CONCURRENCY HOLE note below is only half right. It offers
 * a `select ... for update` in the same transaction as the enqueue write as
 * an alternative to reserving budget, and those are not equivalent: a lock
 * serialises an instant and does nothing about four minutes. Only counting
 * the in-flight work closes the gap that actually loses money.
 *
 * No reservations table, because the state already exists. A scene in
 * 'queued' or 'rendering' IS the reservation, which avoids the failure mode
 * a real reservations table has: rows orphaned by a crashed enqueue, eating
 * budget until something reaps them. Here a scene leaves the in-flight set
 * by finishing, and MarkDone inserts the `runs` row and flips the status in
 * ONE transaction (see its doc comment) — so there is no instant where a
 * render is counted twice or not at all.
 *
 * Estimated, not actual, because the actual is not knowable until kie
 * answers. For a ceiling that means erring toward refusing early, which is
 * the right direction for a guard whose failure mode is an overspend.
 *
 * Paged for the same reason every unbounded admin read in this codebase is:
 * PostgREST caps a response at max_rows (1000) and returns the first page
 * with no error, and a silently short read here reports less in-flight
 * spend than there is — an undercount on the exact figure that exists to
 * prevent an overspend.
 */
export async function getInFlightSpend(): Promise<InFlightSpend> {
  const admin = createAdminClient();
  const audioEnabled = isAudioEnabled();
  const byUserUsd = new Map<string, number>();
  const byTokenUsd = new Map<string, number>();
  let globalUsd = 0;

  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from("scenes")
      .select(
        "duration_s, is_talking_head, render_settings_override, api_token_id, estimated_cost_usd, projects!inner(user_id, render_settings), scene_references(kind, assets(duration_s))",
      )
      .in("status", [...IN_FLIGHT_STATUSES])
      // Only this MODE's own rows. Without it, a developer's mocked test
      // renders sit in 'queued'/'rendering' on the shared table and count
      // against the production team's headroom — the caps would start
      // refusing real work because of renders that cost nothing and will
      // never bill. It is the same partition ClaimQueuedScenes,
      // CountRendering and StaleRendering apply on the worker side; this is
      // the web half of it, and it was missed because the money it protects
      // is the cap's, not a vendor's.
      //
      // The direction of the error if this is ever wrong: counting a dev row
      // OVERSTATES in-flight spend, which refuses a render that would have
      // fit. Annoying, not expensive — the opposite mistake, missing a real
      // row, is the one that lets a cap be breached, and that cannot happen
      // here because a production reader asks for dev=false and every
      // production row has it.
      .eq("dev", isDev())
      // A stable order is not optional under .range(). Postgres gives no
      // row order for LIMIT/OFFSET without ORDER BY, and this reads the set
      // that is BY DEFINITION mutating — scenes leaving 'rendering' is the
      // whole reason the function exists. A concurrent update moves a tuple
      // between the offset=0 and offset=1000 reads, so a scene lands on
      // both pages (overcounts, refusing a render that fits) or on neither
      // (undercounts, which is the failure this function was written to
      // stop). `id` is the tiebreaker for the same reason projects/page.tsx
      // uses one. Latent while the queue is short enough for a single page,
      // and live exactly when there is a backlog — which is when the cap
      // matters most.
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`Failed to read in-flight spend: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      const project = row.projects as unknown as {
        user_id: string;
        render_settings: unknown;
      } | null;
      if (!project) continue;

      const refsRaw = (
        row as unknown as {
          scene_references?:
            | {
                kind: string;
                assets: { duration_s: number | null } | { duration_s: number | null }[] | null;
              }[]
            | null;
        }
      ).scene_references;
      const videoReferenceDurationsS = Array.isArray(refsRaw)
        ? refsRaw
            .filter((r) => r.kind === "video")
            .map((r) => {
              const asset = Array.isArray(r.assets) ? r.assets[0] : r.assets;
              return asset?.duration_s ?? null;
            })
        : undefined;

      // The scene's own override wins over the project's blob (0045): a
      // scene an earlier retry pinned to another model renders — and bills
      // — on that model, so pricing it at the project's would misstate
      // exactly the scenes that already cost the most.
      const settings = mergeRenderSettings(project.render_settings, row.render_settings_override);
      const computedUsd = estimateCost(
        {
          character: "",
          scenes: [
            {
              script_line: "",
              video_prompt: "",
              is_talking_head: row.is_talking_head,
              duration_s: row.duration_s,
              ...(videoReferenceDurationsS && videoReferenceDurationsS.length > 0
                ? { videoReferenceDurationsS }
                : {}),
            },
          ],
        },
        audioEnabled,
        settings,
      ).totalUsd;

      const recordedEst = (row as { estimated_cost_usd?: number | null }).estimated_cost_usd;
      const sceneUsd =
        typeof recordedEst === "number" && Number.isFinite(recordedEst) && recordedEst > 0
          ? Math.max(recordedEst, computedUsd)
          : computedUsd;

      globalUsd += sceneUsd;
      byUserUsd.set(project.user_id, (byUserUsd.get(project.user_id) ?? 0) + sceneUsd);
      const tokenId = (row as { api_token_id?: string | null }).api_token_id;
      if (tokenId) {
        byTokenUsd.set(tokenId, (byTokenUsd.get(tokenId) ?? 0) + sceneUsd);
      }
    }
    if (rows.length < PAGE) break;
  }

  return { globalUsd, byUserUsd, byTokenUsd };
}

/**
 * getInFlightSpend, degraded to zero on a read failure instead of throwing.
 *
 * The fail-soft direction is the same trade assertWithinSpendCaps was
 * already making inline before this was extracted: a throw here would refuse
 * every render in the account (or blank the sidebar) on a transient read
 * failure, trading an occasional overspend for a total outage of the thing
 * the caps exist to let people do. Degrading to the pre-existing behaviour —
 * caps that see only landed `runs` rows — is strictly no worse than what
 * shipped before holds existed, and the error is logged, not swallowed.
 *
 * Extracted because ENFORCEMENT and DISPLAY have to agree on this figure.
 * assertWithinSpendCaps counted in-flight renders against every cap and every figure an
 * operator is shown did not, so the sidebar read "$3.00 left" while the very
 * next enqueue refused — the "gate that shows no warning and then refuses
 * the click" failure this codebase already refuses to accept elsewhere
 * (lib/enqueue-guard.ts's findUnrenderableDurations header). One function,
 * three callers: this file's own cap check and budget snapshot, and
 * lib/sidebar-budget.ts.
 */
export async function getInFlightSpendSafe(): Promise<InFlightSpend> {
  try {
    return await getInFlightSpend();
  } catch (error) {
    console.error("getInFlightSpendSafe: in-flight spend unavailable, holds not counted", error);
    return { globalUsd: 0, byUserUsd: new Map(), byTokenUsd: new Map() };
  }
}

// CONCURRENCY HOLE — narrowed, not closed. getInFlightSpend above now folds
// committed-but-unrecorded renders into all spend checks, which removes the
// minutes-long window this note was originally written about. What is left
// is the millisecond one: two callers can still both read before either
// one's scene reaches 'queued'. A lock or a single transaction around the
// check and that write is what would close the remainder, and unlike the
// original suggestion below it would now be worth having, because it would
// be closing the whole gap rather than a sliver of it.
//
// getGlobalDailySpend, getDailySpend, and getWeeklySpend all return a
// point-in-time snapshot with nothing holding a lock or reserving budget
// between the read and the `scenes.status = 'queued'` write that follows
// it, several lines later, in actions/enqueue.ts. Two editors who press
// Confirm within the same window can both call getGlobalDailySpend (or
// both read the same account's getDailySpend/getWeeklySpend, for a
// shared-account race) before either one's render has written anything
// back — both see the same total, both compute a projected total under the
// cap, both pass, and both proceed. The actual post-write total can then
// exceed the cap by up to the sum of every request that raced through this
// window. This is an ordinary check-then-act race, not a bug specific to
// the arithmetic above — the arithmetic is correct for the total it was
// given, the total is just stale by the time the write lands.
//
// A real fix needs the check and the reservation to be one atomic step, not
// two Next.js round trips with a gap between them: e.g. a
// `spend_reservations` row (or a running-total row read with `SELECT ...
// FOR UPDATE`) written inside the SAME transaction as the
// `scenes.status = 'queued'` update, so Postgres itself serializes
// concurrent attempts instead of two application-level reads racing each
// other. That's a schema change and a rework of enqueue's write path from
// "check, then write" to "reserve and write, atomically" — real scope,
// intentionally left for a follow-up rather than folded in here silently.
//
// What this change DOES do about it: narrows the exposure from "no ceiling
// at all" (before either the daily or weekly guard existed — any number of
// concurrent renders sail through unbounded) to "can overshoot by the size
// of whatever requests happen to race each other within one read-to-write
// window." For a small team whose renders are mostly minutes apart, not
// milliseconds, that is a large practical reduction even though it is not
// a complete fix — worth stating precisely rather than either overclaiming
// the caps are airtight or leaving the gap undocumented for the next
// person to rediscover.

/**
 * resolveAccountCaps(profile).dailyCapUsd minus what the account has
 * already spent today. Can be negative.
 *
 * Takes the whole `profile`, not just `role`, so a per-account override
 * actually applies here too — every caller (render/page.tsx,
 * enqueue.ts) already went through requireProject / requireScene to get
 * here, which fetched the full profile row (overrides included) as part of
 * the ownership check. Re-fetching it here would be a second read of a row
 * the caller is already holding, on a page that's already doing one
 * Supabase round trip per render.
 */
export async function getRemainingBudget(
  userId: string,
  profile: AccountCapProfile,
): Promise<number> {
  const [spent, effectiveWeeklyCapUsd] = await Promise.all([
    getDailySpend(userId),
    getEffectiveWeeklyCapUsd(userId, profile),
  ]);
  return effectiveDailyCapUsd(resolveAccountCaps(profile), effectiveWeeklyCapUsd) - spent;
}

/**
 * getRemainingBudget's weekly twin: getEffectiveWeeklyCapUsd(profile) —
 * the role/override weekly cap PLUS this account's active allowance_grants,
 * not the bare role/override figure alone — minus what the account has
 * already spent this Manila calendar week. Can be negative.
 */
export async function getRemainingWeeklyBudget(
  userId: string,
  profile: AccountCapProfile,
): Promise<number> {
  const [spent, effectiveWeeklyCapUsd] = await Promise.all([
    getWeeklySpend(userId),
    getEffectiveWeeklyCapUsd(userId, profile),
  ]);
  return effectiveWeeklyCapUsd - spent;
}

/** Which of the four spend ceilings — if any — is currently exhausted. `null` means every ceiling still has headroom. */
export type BindingSpendCap = "global" | "weekly" | "hourly" | "daily" | null;

/**
 * Pure decision of which cap is binding right now, given the three
 * remaining-budget figures, in the same global -> weekly -> hourly -> daily priority
 * assertWithinSpendCaps enforces below. A remaining figure of exactly 0
 * counts as exhausted — matches assertCapNotExceeded's own "landing exactly
 * on the cap is allowed, going past it is not": an account sitting AT its
 * cap has no headroom for a NEXT render even though it hasn't gone over.
 *
 * Answers "which refusal message do I show" — the sidebar's message-priority
 * ordering (used, correctly, in the daily/weekly/global BudgetLine display
 * order this file's own callers follow). It does NOT answer "would a grant
 * actually help" — see grantWouldUnblock below for that question, which
 * needs stricter logic (weekly exhausted AND nothing else is) than "which of
 * these four wins priority" gives you. Reusing this function for the
 * "Request more" affordance was the bug: when weekly AND daily are both
 * exhausted (the normal state at the shipped $5/day, $10/week defaults —
 * two full days exhausts the week), this correctly returns "weekly" for
 * message-priority purposes, but that is not the same fact as "requesting
 * more would unblock this account".
 *
 * Pure and DB-free on purpose — the same testability reason
 * assertCapNotExceeded/assertWeeklyCapNotExceeded/assertGlobalCapNotExceeded
 * already are.
 */
export function bindingSpendCap(remaining: {
  globalRemainingUsd: number;
  weeklyRemainingUsd: number;
  dailyRemainingUsd: number;
  hourlyRemainingUsd?: number | null;
  dailyCapEnabled?: boolean;
}): BindingSpendCap {
  if (remaining.globalRemainingUsd <= 0) return "global";
  if (remaining.weeklyRemainingUsd <= 0) return "weekly";
  if (remaining.hourlyRemainingUsd != null && remaining.hourlyRemainingUsd <= 0) return "hourly";
  if (remaining.dailyCapEnabled !== false && remaining.dailyRemainingUsd <= 0) return "daily";
  return null;
}

/**
 * Pure decision of whether an allowance GRANT would actually unblock this
 * account right now — a different question from bindingSpendCap above, and
 * deliberately not answered by reusing that function's result. bindingSpendCap
 * answers "which refusal message do I show" (global -> weekly -> hourly -> daily
 * priority, so it returns exactly one of the four even when more than one
 * is exhausted). The sidebar's "Request more" affordance needs a stricter
 * answer: a grant only ever raises the WEEKLY figure
 * (getEffectiveWeeklyCapUsd), so it only helps when weekly is the ONLY thing
 * binding — if the daily burst guard or the global team cap is ALSO
 * exhausted, granting more weekly allowance changes nothing observable, and
 * offering the link is a bait-and-switch: the editor requests, an admin
 * grants, and they're still refused.
 *
 * With the shipped defaults ($5/day, $10/week), two full days of spend
 * already exhausts the week, so "weekly AND daily both exhausted" is the
 * NORMAL way an editor arrives here, not an edge case — bindingSpendCap
 * alone (which would report "weekly" in exactly that state, correctly, for
 * its own message-priority job) cannot be reused for this without
 * reproducing the bug this function exists to fix.
 */
export function grantWouldUnblock(remaining: {
  globalRemainingUsd: number;
  weeklyRemainingUsd: number;
  dailyRemainingUsd: number;
  hourlyRemainingUsd?: number | null;
  dailyCapEnabled?: boolean;
}): boolean {
  // A grant raises the daily AND the weekly ceiling (effectiveDailyCapUsd), so it helps
  // when either is what binds — never the hourly cap or the team's global one.
  const dailyExhausted = remaining.dailyCapEnabled !== false && remaining.dailyRemainingUsd <= 0;
  return (
    (remaining.weeklyRemainingUsd <= 0 || dailyExhausted) &&
    (remaining.hourlyRemainingUsd == null || remaining.hourlyRemainingUsd > 0) &&
    remaining.globalRemainingUsd > 0
  );
}

/**
 * Which explanation the sidebar's "Request more" dialog should show — that
 * dialog is now rendered UNCONDITIONALLY (see components/sidebar-
 * budget.tsx's header: gating the control itself on grantWouldUnblock was
 * the bug, not the underlying rule), so this only decides which of four
 * honest messages it shows, never whether it shows at all.
 *
 *   - "normal"   — the daily or weekly allowance is exhausted and nothing a
 *                  grant cannot lift is (grantWouldUnblock's condition). The
 *                  ordinary request flow.
 *   - "headroom" — nothing is exhausted yet. Still worth allowing — an
 *                  admin can grant ahead of a big render — but the dialog
 *                  has to say so plainly instead of implying they're stuck.
 *   - "blocked-global" / "blocked-hourly" — the team's global cap or the
 *     account's rolling-hour cap is refusing renders. A grant raises only the
 *     daily and weekly ceilings (effectiveDailyCapUsd), so the dialog says
 *     plainly that it won't unblock them right now.
 */
export type AllowanceDialogState = "normal" | "headroom" | "blocked-global" | "blocked-hourly";

export function allowanceDialogState(remaining: {
  globalRemainingUsd: number;
  weeklyRemainingUsd: number;
  dailyRemainingUsd: number;
  hourlyRemainingUsd?: number | null;
  dailyCapEnabled?: boolean;
  globalCapPeriod?: GlobalSpendCapPeriod;
}): AllowanceDialogState {
  const dailyExhausted = remaining.dailyCapEnabled !== false && remaining.dailyRemainingUsd <= 0;
  const globalExhausted = remaining.globalRemainingUsd <= 0;
  const hourlyExhausted = remaining.hourlyRemainingUsd != null && remaining.hourlyRemainingUsd <= 0;
  if (globalExhausted) return "blocked-global";
  if (hourlyExhausted) return "blocked-hourly";
  return remaining.weeklyRemainingUsd <= 0 || dailyExhausted ? "normal" : "headroom";
}

/**
 * The full four-cap picture for one account, in one read: everything
 * lib/sidebar-budget.ts and the render page (render/page.tsx) both need,
 * factored out so the two read one source of truth instead of two
 * independent assemblies that can drift. render/page.tsx used to pull only
 * getRemainingBudget's DAILY figure and hand that single number to
 * RenderGate/SceneRerenderDialog/RenderProgress — so a granted weekly
 * allowance never showed up there, and the client-side "can I afford this"
 * check disabled Confirm using the daily figure while the server enforced
 * global -> weekly -> hourly -> daily. This is the one place that reads all four so
 * neither caller can reintroduce that divergence by construction.
 *
 * Does NOT read allowance_requests (the pending-request row) — that's a
 * sidebar-only UI concern with no render-page equivalent, so
 * lib/sidebar-budget.ts still queries it separately, alongside this.
 *
 * Deliberately does not catch its own failures — see this function's two
 * callers for why that has to differ by caller, not be decided here:
 * lib/sidebar-budget.ts wraps this in its existing fail-soft try/catch
 * (via its await import() indirection) because the sidebar has no gate to
 * protect and a plain "—" is a fine failure for a glance-only readout.
 * render/page.tsx has no such fallback available to it: RenderGate and
 * RenderProgress ARE the spend gate, so degrading a failed read there to
 * "no limit" would let a render past every cap this file exists to
 * enforce — that caller lets this throw straight through to Next's error
 * boundary instead, same as any other failed data read on that page.
 */
export interface AccountBudgetSnapshot {
  /** app_settings.user_daily_cap_enabled. False means the daily figures below are informational only. */
  dailyCapEnabled: boolean;
  /** effectiveDailyCapUsd (daily cap plus active grants) minus today's spend. Can be negative. */
  dailyRemainingUsd: number;
  dailyCapUsd: number;
  /** Today's spend (getDailySpend) — the "used" half of the daily breakdown (Part 2 of the task that added this field: dailyCapUsd - dailyUsedUsd === dailyRemainingUsd, by construction). */
  dailyUsedUsd: number;
  /** getEffectiveWeeklyCapUsd(profile) minus this week's spend. Can be negative. */
  weeklyRemainingUsd: number;
  weeklyCapUsd: number;
  /** This week's spend (getWeeklySpend) — the "used" half of the weekly breakdown. */
  weeklyUsedUsd: number;
  /** resolveAccountCaps(profile).weeklyCapUsd — the plain role/override figure, BEFORE active grants are added. weeklyCapUsd above is this PLUS weeklyGrantUsd; a display that shows both separately (Part 2's "$10.00 allowance / +$5.00 grant" breakdown) needs this base figure, not just the already-summed total. */
  weeklyBaseCapUsd: number;
  /**
   * weeklyCapUsd - weeklyBaseCapUsd, i.e. the sum of active grants folded
   * into this account's effective weekly allowance right now. Derived from
   * the SAME effectiveWeeklyCapUsd read that produces weeklyRemainingUsd
   * (below), not from a second, independently-fetched grants total — so
   * weeklyBaseCapUsd + weeklyGrantUsd - weeklyUsedUsd is GUARANTEED to equal
   * weeklyRemainingUsd, the exact figure assertWeeklyCapNotExceeded enforces
   * against. getActiveGrantsSummary (below) is a separate read used only for
   * weeklyGrantCount/weeklyGrantEarliestExpiresAt — the two per-grant DETAILS
   * this dollar figure can't give you — never for this number itself.
   */
  weeklyGrantUsd: number;
  /** How many unexpired allowance_grants rows make up weeklyGrantUsd. 0 means "no grant line" for a Part 2 breakdown display. */
  weeklyGrantCount: number;
  /** The soonest expires_at among this account's unexpired grants, or null when weeklyGrantCount is 0. */
  weeklyGrantEarliestExpiresAt: string | null;
  /**
   * weeklyGrantUsd, split by where each active row came from
   * (0087_pass_allowance.sql) — `grantedInUsd + receivedUsd − passedOutUsd`
   * equals it. From getActiveGrantsSummary's read, alongside the count and
   * earliest expiry, and DISPLAY-ONLY like both of those: weeklyGrantUsd
   * itself stays derived from effectiveWeeklyCapUsd so the breakdown is
   * guaranteed to sum to the figure enforcement actually uses.
   *
   * The reason they exist at all is that weeklyGrantUsd GOES NEGATIVE for a
   * net sender — correct arithmetic, and unreadable as one line. "−$2.00
   * grant" is not what happened; "$5.00 grant / −$7.00 passed" is.
   */
  grantedInUsd: number;
  /** Active credits received from a peer's pass. Positive. */
  receivedUsd: number;
  /** Active credits passed away, reported POSITIVE — every display of it is a "−" line, so the sign lives in the label. */
  passedOutUsd: number;
  /**
   * This account's renders that are 'queued' or 'rendering' right now,
   * priced at estimate — money HELD, not yet billed (getInFlightSpend).
   *
   * Subtracted from both dailyRemainingUsd and weeklyRemainingUsd above,
   * because it is subtracted from both by assertWithinSpendCaps: the moment
   * an operator presses Generate the estimate stops being available to
   * spend again, and a figure that still offered it would be describing a
   * balance the very next enqueue refuses.
   *
   * Kept SEPARATE from dailyUsedUsd/weeklyUsedUsd rather than folded into
   * them — those are billed `runs` rows, and a held estimate is neither
   * spent nor available. A display showing the arithmetic (the sidebar's
   * "allowance - used = left" breakdown) needs the third line to add up;
   * one that shows only "left" can ignore this field entirely.
   *
   * Counts against today AND this week at once, which is not double-billing:
   * the same in-flight render will land in both windows when it does.
   */
  heldUsd: number;
  hourlyRemainingUsd: number | null;
  hourlyCapUsd: number | null;
  hourlyUsedUsd: number;
  globalCapEnabled: boolean;
  globalCapPeriod: GlobalSpendCapPeriod;
  /** Team spend remaining under the selected global window; Infinity when the cap is disabled. */
  globalRemainingUsd: number;
  globalCapUsd: number;
  /** bindingSpendCap's answer for these four figures — which cap, if any, is exhausted right now. */
  bindingCap: BindingSpendCap;
  /** grantWouldUnblock's answer for these four figures. */
  grantWouldUnblock: boolean;
}

export async function getAccountBudgetSnapshot(
  userId: string,
  profile: AccountCapProfile,
): Promise<AccountBudgetSnapshot> {
  const caps = resolveAccountCaps(profile);
  const dailyCapEnabled = dailyCapAppliesTo(profile, await getUserDailyCapEnabled());

  // Five independent reads, fired together — same reasoning as lib/
  // sidebar-budget.ts's own comment on its (now-replaced) inline version of
  // this: none of these five depends on another's result. grantsSummary is
  // read only for its per-grant DETAIL (count, earliest expiry) — see
  // weeklyGrantUsd's own doc comment for why the dollar figure itself is
  // derived from effectiveWeeklyCapUsd instead of grantsSummary.totalUsd.
  const [
    dailySpentUsd,
    effectiveWeeklyCapUsd,
    weeklySpentUsd,
    globalSpend,
    hourlySpentUsd,
    grantsSummary,
    inFlight,
  ] = await Promise.all([
    getDailySpend(userId),
    getEffectiveWeeklyCapUsd(userId, profile),
    getWeeklySpend(userId),
    getGlobalSpendSnapshot(),
    profile.hourly_cap_override_usd == null ? Promise.resolve(0) : getHourlySpend(userId),
    getActiveGrantsSummary(userId),
    getInFlightSpendSafe(),
  ]);

  // The same subtraction assertWithinSpendCaps makes — see heldUsd's doc
  // comment. Without it every figure on this snapshot (the sidebar's "left",
  // the render gate's headroom, the confirm dialog's overage warning) quotes
  // budget the next enqueue will refuse.
  const heldUsd = inFlight.byUserUsd.get(userId) ?? 0;
  const dailyCapUsd = effectiveDailyCapUsd(caps, effectiveWeeklyCapUsd);
  const dailyRemainingUsd = dailyCapUsd - dailySpentUsd - heldUsd;
  const weeklyRemainingUsd = effectiveWeeklyCapUsd - weeklySpentUsd - heldUsd;
  const globalRemainingUsd =
    globalSpend.settings.enabled && globalCapAppliesTo(profile)
      ? globalSpend.settings.capUsd - globalSpend.spentUsd - inFlight.globalUsd
      : Number.POSITIVE_INFINITY;
  const hourlyCapUsd = profile.hourly_cap_override_usd ?? null;
  const hourlyRemainingUsd = hourlyCapUsd === null ? null : hourlyCapUsd - hourlySpentUsd - heldUsd;
  const remaining = {
    globalRemainingUsd,
    weeklyRemainingUsd,
    dailyRemainingUsd,
    hourlyRemainingUsd,
    dailyCapEnabled,
    globalCapPeriod: globalSpend.settings.period,
  };

  return {
    dailyCapEnabled,
    dailyRemainingUsd,
    dailyCapUsd,
    dailyUsedUsd: dailySpentUsd,
    weeklyRemainingUsd,
    weeklyCapUsd: effectiveWeeklyCapUsd,
    weeklyUsedUsd: weeklySpentUsd,
    weeklyBaseCapUsd: caps.weeklyCapUsd,
    weeklyGrantUsd: effectiveWeeklyCapUsd - caps.weeklyCapUsd,
    weeklyGrantCount: grantsSummary.count,
    weeklyGrantEarliestExpiresAt: grantsSummary.earliestExpiresAt,
    grantedInUsd: grantsSummary.grantedInUsd,
    receivedUsd: grantsSummary.receivedUsd,
    passedOutUsd: grantsSummary.passedOutUsd,
    heldUsd,
    hourlyRemainingUsd,
    hourlyCapUsd,
    hourlyUsedUsd: hourlySpentUsd,
    globalCapEnabled: globalSpend.settings.enabled && globalCapAppliesTo(profile),
    globalCapPeriod: globalSpend.settings.period,
    globalRemainingUsd,
    globalCapUsd: globalSpend.settings.capUsd,
    bindingCap: bindingSpendCap(remaining),
    grantWouldUnblock: grantWouldUnblock(remaining),
  };
}

// There used to be a combined assertWithinDailyCap(userId, estimatedUsd)
// helper here that called getDailySpend then assertCapNotExceeded in one
// throw. actions/enqueue.ts now calls the pieces separately: getDailySpend's
// failure is a genuine Postgres error (stays thrown, redacted in production
// on purpose), while assertCapNotExceeded's is an operator-actionable guard
// that has to be returned as data instead — see lib/action-result.ts for why
// a single combined throw couldn't tell those two apart.

/**
 * The five video-render paths in actions/enqueue.ts (enqueueRender,
 * enqueueTestScene, retryScene, retryAllFailed, rerenderScene) and the
 * eight other paid call sites (actions/frames.ts, actions/character.ts,
 * actions/character-library.ts, actions/compile.ts, actions/brief.ts) all
 * call this one helper instead of re-typing the four-check sequence below.
 * It stays an ordinary async function that PROPAGATES
 * getKieAccountBalanceUsd/getDailySpend/getWeeklySpend/getGlobalDailySpend's
 * genuine failures by simply not catching them, and only wraps the four
 * assert calls in guardResult — so a database error still surfaces to the
 * caller as a thrown, redacted #441, and only a real cap refusal comes back
 * as `{ error }`. Callers still `await` this and must
 * `if (result) return result;` exactly as if they'd inlined the checks
 * themselves.
 *
 * Order is fixed here: vendor balance, global cap, weekly allowance, hourly override,
 * then the optional daily guard. Each later check only runs if the earlier ones pass.
 * Same CONCURRENCY HOLE as every other cap check in this file (see the
 * comment above getRemainingBudget/getWeeklySpend): a point-in-time read
 * with nothing reserving the estimate between this check and the caller's
 * own write. Every one of the thirteen call sites this backs adds one more
 * instance of that window — see each call site's own comment for why that
 * is being stated plainly rather than silently widened.
 */
export async function getTokenMonthlySpend(
  tokenId: string,
  now: Date = new Date(),
): Promise<number> {
  const admin = createAdminClient();
  const monthStart = startOfManilaMonthIso(now);
  const { data, error } = await admin
    .from("runs")
    .select("cost_usd")
    .eq("api_token_id", tokenId)
    .not("cost_usd", "is", null)
    .gte("created_at", monthStart)
    .lt("created_at", now.toISOString());

  if (error) {
    throw new Error(`Failed to read token monthly spend for ${tokenId}: ${error.message}`);
  }
  return (data ?? []).reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
}

export async function assertWithinSpendCaps(
  userId: string,
  profile: AccountCapProfile,
  estimatedUsd: number,
  options?: {
    apiTokenId?: string | null;
    tokenMonthlyCapUsd?: number | null;
  },
): Promise<ActionResult> {
  const mockedRender = isDev();

  if (!Number.isFinite(estimatedUsd)) {
    return {
      error:
        "This clip cannot be priced, so it was not queued — nobody has been billed for this " +
        "model at this resolution yet, and rendering it would spend an unknown amount. This is " +
        "a configuration gap, not a problem with your account or the balance. Pick another " +
        "model, or ask an admin to price this one.",
    };
  }

  if (!mockedRender && estimatedUsd > 0) {
    // Not awaited and not a gate: re-reading BytePlus here (cached 60s) is what lets
    // its low-balance alert (lib/balance-alert.ts) see renders, not only admin pages.
    void getBytePlusBalanceUsd();
    const balanceUsd = await getKieAccountBalanceUsd();
    if (balanceUsd !== null) {
      const balanceResult = guardResult(() =>
        assertKieBalanceCoversEstimate(balanceUsd, estimatedUsd),
      );
      if (balanceResult) return balanceResult;
    }
  }

  const inFlight = await getInFlightSpendSafe();
  const inFlightForUserUsd = inFlight.byUserUsd.get(userId) ?? 0;

  const globalSpend = await getGlobalSpendSnapshot();
  if (globalSpend.settings.enabled && globalCapAppliesTo(profile)) {
    const globalCapResult = guardResult(() =>
      assertGlobalCapNotExceeded(
        globalSpend.spentUsd + inFlight.globalUsd,
        estimatedUsd,
        globalSpend.settings.capUsd,
        globalSpend.settings.period,
      ),
    );
    if (globalCapResult) return globalCapResult;
  }

  const caps = resolveAccountCaps(profile);

  const [spentThisWeekUsd, effectiveWeeklyCapUsd] = await Promise.all([
    getWeeklySpend(userId),
    getEffectiveWeeklyCapUsd(userId, profile),
  ]);
  const weeklyCapResult = guardResult(() =>
    assertWeeklyCapNotExceeded(
      spentThisWeekUsd + inFlightForUserUsd,
      estimatedUsd,
      effectiveWeeklyCapUsd,
    ),
  );
  if (weeklyCapResult) return weeklyCapResult;

  if (options?.apiTokenId && options.tokenMonthlyCapUsd != null) {
    const tokenId = options.apiTokenId;
    const tokenCapUsd = options.tokenMonthlyCapUsd;
    const spentTokenMonthUsd = await getTokenMonthlySpend(tokenId);
    const inFlightForTokenUsd = inFlight.byTokenUsd.get(tokenId) ?? 0;
    const tokenCapResult = guardResult(() =>
      assertTokenMonthlyCapNotExceeded(
        spentTokenMonthUsd + inFlightForTokenUsd,
        estimatedUsd,
        tokenCapUsd,
      ),
    );
    if (tokenCapResult) return tokenCapResult;
  }

  const hourlyCapUsd = profile.hourly_cap_override_usd ?? null;
  if (hourlyCapUsd !== null) {
    const hourlySpentUsd = await getHourlySpend(userId);
    const hourlyCapResult = guardResult(() =>
      assertHourlyCapNotExceeded(hourlySpentUsd + inFlightForUserUsd, estimatedUsd, hourlyCapUsd),
    );
    if (hourlyCapResult) return hourlyCapResult;
  }

  // Read here rather than at the top because the weekly check above refuses
  // first in every case that matters, so an account already over its weekly
  // allowance never pays for this lookup at all.
  if (!dailyCapAppliesTo(profile, await getUserDailyCapEnabled())) return undefined;

  const spentTodayUsd = (await getDailySpend(userId)) + inFlightForUserUsd;
  return guardResult(() =>
    assertCapNotExceeded(
      spentTodayUsd,
      estimatedUsd,
      effectiveDailyCapUsd(caps, effectiveWeeklyCapUsd),
    ),
  );
}

export type QueueScenesOutcome =
  | { outcome: "queued" }
  | { outcome: "fenced" }
  | {
      outcome: "blocked";
      blockedBy:
        "unpriceable" | "kie_balance" | "global" | "weekly" | "token_monthly" | "hourly" | "daily";
      error: string;
      code: "spend_cap_exceeded";
    };

/**
 * Single-transaction spend-cap check and scene status='queued' transition.
 *
 * Acquires `pg_advisory_xact_lock(hashtext('spend-cap:global'))` followed by
 * `pg_advisory_xact_lock(hashtext('spend-cap:owner:' || userId))` inside
 * `public.queue_scenes_if_within_caps` (`0127_api_tokens.sql`), re-computes
 * settled + in-flight spend across global, weekly, token monthly, hourly, and
 * daily ceilings, and transitions the target scenes to `status = 'queued'`
 * in the same PostgreSQL transaction.
 */
export async function queueScenesIfWithinCaps(params: {
  admin?: SupabaseClient<Database>;
  projectId: string;
  userId: string;
  profile: AccountCapProfile;
  sceneIds: string[];
  estimatesUsd: number[];
  override?: unknown;
  apiTokenId?: string | null;
  prepareToken?: string | null;
  now?: Date;
}): Promise<QueueScenesOutcome> {
  const { projectId, userId, profile, sceneIds, estimatesUsd } = params;
  if (sceneIds.length === 0 || sceneIds.length !== estimatesUsd.length) {
    throw new Error(
      "queueScenesIfWithinCaps requires non-empty matching sceneIds and estimatesUsd",
    );
  }

  for (const est of estimatesUsd) {
    if (!Number.isFinite(est) || est <= 0) {
      return {
        outcome: "blocked",
        blockedBy: "unpriceable",
        code: "spend_cap_exceeded",
        error:
          "This clip cannot be priced, so it was not queued — nobody has been billed for this " +
          "model at this resolution yet, and rendering it would spend an unknown amount. This is " +
          "a configuration gap, not a problem with your account or the balance. Pick another " +
          "model, or ask an admin to price this one.",
      };
    }
  }

  const totalEstimateUsd = estimatesUsd.reduce((sum, v) => sum + v, 0);

  if (!isDev() && totalEstimateUsd > 0) {
    // Not awaited and not a gate: re-reading BytePlus here (cached 60s) is what lets
    // its low-balance alert (lib/balance-alert.ts) see renders, not only admin pages.
    void getBytePlusBalanceUsd();
    const balanceUsd = await getKieAccountBalanceUsd();
    if (balanceUsd !== null) {
      const balanceResult = guardResult(() =>
        assertKieBalanceCoversEstimate(balanceUsd, totalEstimateUsd),
      );
      if (balanceResult) {
        return {
          outcome: "blocked",
          blockedBy: "kie_balance",
          code: "spend_cap_exceeded",
          error: balanceResult.error,
        };
      }
    }
  }

  const admin = params.admin ?? createAdminClient();
  const now = params.now ?? new Date();
  const caps = resolveAccountCaps(profile);
  const [effectiveWeeklyCapUsd, dailyCapEnabled, globalSpendCap] = await Promise.all([
    getEffectiveWeeklyCapUsd(userId, profile),
    getUserDailyCapEnabled(),
    getGlobalSpendCapSettings(),
  ]);

  const { data, error } = await admin.rpc("queue_scenes_if_within_caps", {
    p_project_id: projectId,
    p_scene_ids: sceneIds,
    p_expected_user_id: userId,
    p_scene_estimates_usd: estimatesUsd,
    p_dev: isDev(),
    p_override: params.override ?? null,
    p_day_start_ts: startOfManilaDayIso(now),
    p_week_start_ts: startOfManilaWeekIso(now),
    p_month_start_ts: startOfManilaMonthIso(now),
    // Rolling hour: the SQL reads NULL as now - 1 hour. PostgREST still needs the key.
    p_hour_start_ts: null,
    p_now_ts: now.toISOString(),
    p_global_cap_usd: globalSpendCap.capUsd,
    p_global_cap_enabled: globalSpendCap.enabled && globalCapAppliesTo(profile),
    p_global_cap_period: globalSpendCap.period,
    p_weekly_cap_usd: effectiveWeeklyCapUsd,
    p_daily_cap_usd: effectiveDailyCapUsd(caps, effectiveWeeklyCapUsd),
    p_daily_cap_enabled: dailyCapAppliesTo(profile, dailyCapEnabled),
    p_hourly_cap_usd: profile.hourly_cap_override_usd ?? null,
    p_api_token_id: params.apiTokenId ?? null,
    p_prepare_token: params.prepareToken ?? null,
  });

  if (error) {
    throw new Error(`Failed to queue scenes within spend caps: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error("queue_scenes_if_within_caps returned no row");
  }

  if (row.outcome === "queued") {
    return { outcome: "queued" };
  }
  if (row.outcome === "fenced") {
    return { outcome: "fenced" };
  }

  const spentUsd = Number(row.spent_usd ?? 0);
  const capUsd = Number(row.cap_usd ?? 0);
  const blockedBy = row.blocked_by ?? "weekly";

  let message = "Spend cap exceeded. Refusing to enqueue.";
  if (blockedBy === "global") {
    message =
      guardResult(() =>
        assertGlobalCapNotExceeded(spentUsd, totalEstimateUsd, capUsd, globalSpendCap.period),
      )?.error ?? message;
  } else if (blockedBy === "weekly") {
    message =
      guardResult(() => assertWeeklyCapNotExceeded(spentUsd, totalEstimateUsd, capUsd))?.error ??
      message;
  } else if (blockedBy === "token_monthly") {
    message =
      guardResult(() => assertTokenMonthlyCapNotExceeded(spentUsd, totalEstimateUsd, capUsd))
        ?.error ?? message;
  } else if (blockedBy === "hourly") {
    message =
      guardResult(() => assertHourlyCapNotExceeded(spentUsd, totalEstimateUsd, capUsd))?.error ??
      message;
  } else if (blockedBy === "daily") {
    message =
      guardResult(() => assertCapNotExceeded(spentUsd, totalEstimateUsd, capUsd))?.error ?? message;
  }

  return {
    outcome: "blocked",
    blockedBy,
    code: "spend_cap_exceeded",
    error: message,
  };
}

(
  assertWithinSpendCaps as typeof assertWithinSpendCaps & {
    queueScenes?: typeof queueScenesIfWithinCaps;
  }
).queueScenes = queueScenesIfWithinCaps;

// ---------------------------------------------------------------------------
// The Image Generator's ceilings (0083_image_generator.sql).
// ---------------------------------------------------------------------------

/**
 * The numbers public.reserve_image_attempt needs, resolved here because SQL
 * cannot read them.
 *
 * A Postgres function has no access to WEEKLY_CAP_USD and friends — they are
 * env vars (0035_outstanding_allowance.sql states this plainly), and role
 * defaults, per-account overrides and active grants all live in app logic. So
 * the ceilings are resolved here and PASSED IN, the same shape
 * sidebar_budget_snapshot already uses.
 */
export interface ImageAttemptCeilings {
  dayStartIso: string;
  weekStartIso: string;
  nowIso: string;
  globalDailyCapUsd: number;
  globalCapEnabled: boolean;
  globalCapPeriod: GlobalSpendCapPeriod;
  hourlyCapUsd: number | null;
  weeklyCapUsd: number;
  dailyCapUsd: number;
  dailyCapEnabled: boolean;
}

/**
 * Resolves every ceiling for one image reservation.
 *
 * This does NOT compare anything and does NOT call assertWithinSpendCaps —
 * reserve_image_attempt does the comparing, under its locks, in the same
 * transaction that writes the reservation. Calling both would count the
 * request's own estimate twice and refuse at half the real headroom.
 *
 * WHY THE CAPS COME BACK REDUCED BY IN-FLIGHT SPEND. The RPC measures spend
 * with user_spend_usd / spend_total_usd, which read `runs` and the deleted-
 * project archive. Neither can see a render that has been COMMITTED but has
 * not written its run row yet — that is exactly what getInFlightSpend exists
 * to cover, and assertWithinSpendCaps folds it into every one of its three
 * checks. If this path ignored it, an account with a video render mid-flight
 * could generate images that every other paid path in the app would have
 * refused: not a race, a standing hole.
 *
 * Since the ceilings are the only things this function controls, in-flight is
 * carried by lowering them rather than by inflating a spend figure the RPC
 * computes for itself. Same arithmetic, same answer, and the RPC stays the one
 * place the comparison happens.
 *
 * Fail-soft on an in-flight read failure, deliberately and for the same reason
 * assertWithinSpendCaps is: throwing here would refuse every image in the
 * account on a transient read error, trading an occasional overspend for an
 * outage of the thing the caps exist to permit. Degrading leaves us exactly
 * where we were before in-flight accounting existed, and the error is logged.
 */
export async function resolveImageAttemptCeilings(
  userId: string,
  profile: AccountCapProfile,
  now: Date = new Date(),
): Promise<ImageAttemptCeilings> {
  let inFlight: InFlightSpend = { globalUsd: 0, byUserUsd: new Map(), byTokenUsd: new Map() };
  try {
    inFlight = await getInFlightSpend();
  } catch (error) {
    console.error(
      "resolveImageAttemptCeilings: in-flight spend unavailable, ceilings degraded",
      error,
    );
  }
  const inFlightForUserUsd = inFlight.byUserUsd.get(userId) ?? 0;

  const caps = resolveAccountCaps(profile);
  // getEffectiveWeeklyCapUsd, not caps.weeklyCapUsd — folds in this account's
  // active allowance_grants, which raise the daily ceiling by the same amount.
  const [effectiveWeeklyCapUsd, dailyCapEnabled, globalSpendCap] = await Promise.all([
    getEffectiveWeeklyCapUsd(userId, profile),
    getUserDailyCapEnabled(),
    getGlobalSpendCapSettings(),
  ]);

  // Clamped at zero: a negative ceiling would be compared as a number and
  // refuse with a nonsensical figure. Zero already refuses everything, which
  // is the correct behaviour for an account whose in-flight work has already
  // consumed its allowance.
  const reduce = (cap: number, byUsd: number) => Math.max(0, cap - byUsd);

  return {
    dayStartIso: startOfManilaDayIso(now),
    weekStartIso: startOfManilaWeekIso(now),
    nowIso: now.toISOString(),
    globalDailyCapUsd: reduce(globalSpendCap.capUsd, inFlight.globalUsd),
    globalCapEnabled: globalSpendCap.enabled && globalCapAppliesTo(profile),
    globalCapPeriod: globalSpendCap.period,
    hourlyCapUsd:
      profile.hourly_cap_override_usd == null
        ? null
        : reduce(profile.hourly_cap_override_usd, inFlightForUserUsd),
    weeklyCapUsd: reduce(effectiveWeeklyCapUsd, inFlightForUserUsd),
    dailyCapUsd: reduce(effectiveDailyCapUsd(caps, effectiveWeeklyCapUsd), inFlightForUserUsd),
    dailyCapEnabled: dailyCapAppliesTo(profile, dailyCapEnabled),
  };
}
