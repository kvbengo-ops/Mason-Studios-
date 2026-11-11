import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import {
  ADMIN_DAILY_CAP_USD,
  ADMIN_WEEKLY_CAP_USD,
  DAILY_CAP_USD,
  DEFAULT_GLOBAL_SPEND_CAP_USD,
  TRUSTED_DAILY_CAP_USD,
  TRUSTED_WEEKLY_CAP_USD,
  WEEKLY_CAP_USD,
  assertCapNotExceeded,
  assertKieBalanceCoversEstimate,
  assertGlobalCapNotExceeded,
  assertHourlyCapNotExceeded,
  assertWeeklyCapNotExceeded,
  allowanceDialogState,
  bindingSpendCap,
  dailyCapForRole,
  effectiveDailyCapUsd,
  endOfManilaDayIso,
  endOfManilaWeekIso,
  grantWouldUnblock,
  parseCapEnvUsd,
  resolveAccountCaps,
  startOfManilaDayIso,
  startOfManilaWeekIso,
  weeklyCapForRole,
  AI_ANIMATOR_DAILY_CAP_USD,
  AI_ANIMATOR_WEEKLY_CAP_USD,
  HYBRID_EDITOR_DAILY_CAP_USD,
  HYBRID_EDITOR_WEEKLY_CAP_USD,
} from "./spend";

// MODE=production for the whole file: assertWithinSpendCaps' balance-gate
// step (and everything downstream of it) is skipped outright in
// development (lib/mode.ts's isDev()), and MODE resolves to "development"
// by default when unset — which it is in this test run, since render.yaml's
// MODE=production only applies to the deployed process, never to `vitest
// run`. Without this, every test below that exercises the balance gate
// (or anything past it) would silently take the mocked-render short-circuit
// instead of the real code path it's named for. Individual tests are free
// to vi.stubEnv("MODE", ...) their own value if a case specifically needs
// development's behaviour.
beforeEach(() => {
  vi.stubEnv("MODE", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// This is the parser that stands between a render.yaml/env-var string and
// every dollar-cap constant below — see its doc comment in spend.ts for the
// two silent-failure modes of bare `Number()` it exists to close off
// (NaN from "$20", 0 from ""). Deliberately tested with `toThrow`, not
// `toBe`: a `toBe`/`toEqual` comparison against a NaN-producing bug can
// still pass, because vitest's `toBe` uses `Object.is` semantics, under
// which `Object.is(NaN, NaN)` is `true` — `expect(NaN).toBe(NaN)` passes.
// That is exactly how an environment cap silently going NaN can stay green
// under the one test that used to touch it.
// Asserting a throw sidesteps the trap entirely: there is no NaN value for a
// throwing call to coincidentally compare equal to.
describe("parseCapEnvUsd", () => {
  it("throws on a value with a stray currency symbol (the render.yaml typo this exists for)", () => {
    expect(() => parseCapEnvUsd("WEEKLY_CAP_USD", "$20", 100)).toThrow(/WEEKLY_CAP_USD/);
  });

  it("throws on an empty string rather than silently parsing to a 0 cap that blocks everything", () => {
    expect(() => parseCapEnvUsd("WEEKLY_CAP_USD", "", 100)).toThrow(/empty/i);
  });

  it("throws on a non-numeric string", () => {
    expect(() => parseCapEnvUsd("WEEKLY_CAP_USD", "abc", 100)).toThrow(/valid non-negative/i);
  });

  it("throws on a negative cap — a negative dollar ceiling is nonsense", () => {
    expect(() => parseCapEnvUsd("WEEKLY_CAP_USD", "-5", 100)).toThrow(/valid non-negative/i);
  });

  it("parses a valid numeric string to its number", () => {
    expect(parseCapEnvUsd("WEEKLY_CAP_USD", "42.5", 100)).toBe(42.5);
  });

  it("allows an explicit 0 — a deliberate 'block everything' cap is not the same bug as an empty string", () => {
    expect(parseCapEnvUsd("WEEKLY_CAP_USD", "0", 100)).toBe(0);
  });

  it("falls back to the given default when the env var is unset entirely", () => {
    expect(parseCapEnvUsd("WEEKLY_CAP_USD", undefined, 100)).toBe(100);
  });

  it("never produces NaN — every rejected input throws instead of returning a number", () => {
    for (const bad of ["$20", "", "abc", "-5", "NaN", "Infinity"]) {
      expect(() => parseCapEnvUsd("WEEKLY_CAP_USD", bad, 100)).toThrow();
    }
  });
});

describe("dailyCapForRole / weeklyCapForRole", () => {
  it("gives editors the editor daily/weekly defaults", () => {
    expect(dailyCapForRole("editor")).toBe(DAILY_CAP_USD);
    expect(weeklyCapForRole("editor")).toBe(WEEKLY_CAP_USD);
  });

  it("gives trusted editors their own, higher daily/weekly defaults", () => {
    expect(dailyCapForRole("trusted_editor")).toBe(TRUSTED_DAILY_CAP_USD);
    expect(weeklyCapForRole("trusted_editor")).toBe(TRUSTED_WEEKLY_CAP_USD);
  });

  it("gives admins the admin daily/weekly defaults", () => {
    expect(dailyCapForRole("admin")).toBe(ADMIN_DAILY_CAP_USD);
    expect(weeklyCapForRole("admin")).toBe(ADMIN_WEEKLY_CAP_USD);
  });

  it("gives Hybrid Editors and AI Animators their own caps, defaulting to the global cap's default", () => {
    expect(dailyCapForRole("hybrid_editor")).toBe(HYBRID_EDITOR_DAILY_CAP_USD);
    expect(weeklyCapForRole("hybrid_editor")).toBe(HYBRID_EDITOR_WEEKLY_CAP_USD);
    expect(dailyCapForRole("ai_animator")).toBe(AI_ANIMATOR_DAILY_CAP_USD);
    expect(weeklyCapForRole("ai_animator")).toBe(AI_ANIMATOR_WEEKLY_CAP_USD);
    // Unset env: the global cap's own default, 7x for the week.
    expect(HYBRID_EDITOR_DAILY_CAP_USD).toBe(DEFAULT_GLOBAL_SPEND_CAP_USD);
    expect(AI_ANIMATOR_WEEKLY_CAP_USD).toBe(7 * DEFAULT_GLOBAL_SPEND_CAP_USD);
  });

  // The proposal's own ordering: trusted_editor sits strictly between
  // editor and admin on both windows, not equal to either.
  it("orders the three tiers strictly: editor < trusted_editor < admin", () => {
    expect(dailyCapForRole("editor")).toBeLessThan(dailyCapForRole("trusted_editor"));
    expect(dailyCapForRole("trusted_editor")).toBeLessThan(dailyCapForRole("admin"));
    expect(weeklyCapForRole("editor")).toBeLessThan(weeklyCapForRole("trusted_editor"));
    expect(weeklyCapForRole("trusted_editor")).toBeLessThan(weeklyCapForRole("admin"));
  });
});

describe("resolveAccountCaps", () => {
  it("falls back to the role default when neither override column is set (every account before this feature)", () => {
    expect(
      resolveAccountCaps({
        role: "editor",
        daily_cap_override_usd: null,
        weekly_cap_override_usd: null,
      }),
    ).toEqual({ dailyCapUsd: DAILY_CAP_USD, weeklyCapUsd: WEEKLY_CAP_USD });
  });

  it("uses the per-account override when an admin has set one, regardless of role default", () => {
    expect(
      resolveAccountCaps({
        role: "editor",
        daily_cap_override_usd: 50,
        weekly_cap_override_usd: 150,
      }),
    ).toEqual({ dailyCapUsd: 50, weeklyCapUsd: 150 });
  });

  // The pair is not two independent numbers: the daily figure is a burst
  // guard UNDER the weekly allowance, and assertWithinSpendCaps checks
  // weekly before daily — so a daily cap at or above the weekly one can
  // never fire. Clamping here is what stops /users rendering "1,000 cr/day"
  // beside a 1 cr week as though the account could ever spend it.
  it("never reports a daily guard looser than the weekly allowance it guards", () => {
    expect(
      resolveAccountCaps({
        role: "editor",
        daily_cap_override_usd: 200,
        weekly_cap_override_usd: 5,
      }),
    ).toEqual({ dailyCapUsd: 5, weeklyCapUsd: 5 });
  });

  // The clamp must not touch the ordinary case, which is the whole point of
  // a burst guard: a small daily figure under a larger weekly one.
  it("leaves a daily guard that is genuinely under the weekly allowance alone", () => {
    expect(
      resolveAccountCaps({
        role: "editor",
        daily_cap_override_usd: 2,
        weekly_cap_override_usd: 40,
      }),
    ).toEqual({ dailyCapUsd: 2, weeklyCapUsd: 40 });
  });

  // Role defaults are not exempt. An admin who drops one account's weekly
  // override below its ROLE's daily default creates the same incoherence
  // without ever touching the daily column.
  // Uses the TRUSTED tier deliberately. This used to be an editor, whose
  // daily role default was $5 and so sat above the $1 weekly override — the
  // clamp had something to bite on. The editor defaults are 0 now (a new
  // account spends nothing until an admin says so), and 0 is already below
  // any override, so an editor can no longer demonstrate this rule at all.
  // The trusted tier still carries real figures and does.
  it("clamps a role-default daily against a lowered weekly override", () => {
    const caps = resolveAccountCaps({
      role: "trusted_editor",
      daily_cap_override_usd: null,
      weekly_cap_override_usd: 1,
    });
    expect(caps).toEqual({ dailyCapUsd: 1, weeklyCapUsd: 1 });
  });

  // The zero default itself, stated once as a fact rather than left implied
  // by every other test that stopped working when it changed.
  it("gives a brand-new editor account nothing to spend until an admin acts", () => {
    expect(
      resolveAccountCaps({
        role: "editor",
        daily_cap_override_usd: null,
        weekly_cap_override_usd: null,
      }),
    ).toEqual({ dailyCapUsd: 0, weeklyCapUsd: 0 });
  });

  // The trap the zero default would otherwise set. Every editor in this
  // installation has weekly_cap_override_usd set and daily_cap_override_usd
  // null, so their daily figure comes from a role default that is now 0. Read
  // literally that is a hard 0/day ceiling on an account with a real weekly
  // allowance — and since grants raise the WEEKLY ceiling only, no grant
  // could ever lift it. Turning on the (supported, documented) daily guard
  // would have frozen every account with no way back.
  it("does not freeze an account with a real weekly allowance when the daily guard is unconfigured", () => {
    expect(
      resolveAccountCaps({
        role: "editor",
        daily_cap_override_usd: null,
        weekly_cap_override_usd: 25,
      }),
    ).toEqual({ dailyCapUsd: 25, weeklyCapUsd: 25 });
  });

  // ...while an admin who explicitly writes 0 still gets the narrow pause
  // dailyCapOverrideError documents: today's renders stop, the week's
  // allowance is untouched. null and 0 must not collapse into each other.
  it("still honours an EXPLICIT daily override of zero as a pause", () => {
    expect(
      resolveAccountCaps({
        role: "editor",
        daily_cap_override_usd: 0,
        weekly_cap_override_usd: 25,
      }),
    ).toEqual({ dailyCapUsd: 0, weeklyCapUsd: 25 });
  });

  it("resolves each window independently — a daily override with no weekly override still falls back for the weekly figure", () => {
    expect(
      resolveAccountCaps({
        role: "trusted_editor",
        daily_cap_override_usd: 1,
        weekly_cap_override_usd: null,
      }),
    ).toEqual({ dailyCapUsd: 1, weeklyCapUsd: TRUSTED_WEEKLY_CAP_USD });
  });

  it("treats an explicit 0 override as a deliberate value, not 'unset' (same contract as parseCapEnvUsd's own 0 case)", () => {
    expect(
      resolveAccountCaps({
        role: "editor",
        daily_cap_override_usd: 0,
        weekly_cap_override_usd: null,
      }).dailyCapUsd,
    ).toBe(0);
  });
});

describe("global spend cap defaults", () => {
  it("defaults to the value seeded in app_settings", () => {
    expect(DEFAULT_GLOBAL_SPEND_CAP_USD).toBe(100);
  });

  it("the global default and all role cap constants are finite numbers", () => {
    for (const capUsd of [
      DAILY_CAP_USD,
      WEEKLY_CAP_USD,
      TRUSTED_DAILY_CAP_USD,
      TRUSTED_WEEKLY_CAP_USD,
      ADMIN_DAILY_CAP_USD,
      ADMIN_WEEKLY_CAP_USD,
      DEFAULT_GLOBAL_SPEND_CAP_USD,
    ]) {
      expect(Number.isFinite(capUsd)).toBe(true);
    }
  });
});

// Pins the timezone decision explained in spend.ts's file header: day and
// week boundaries are Asia/Manila (fixed UTC+8, no DST), not UTC, and the
// week is a calendar week resetting Monday, not a rolling 7 days.
describe("startOfManilaDayIso", () => {
  it("computes the 05:00 Manila reset for an ordinary mid-day instant", () => {
    // 2024-03-10T07:00:00Z is 2024-03-10T15:00 in Manila (UTC+8).
    expect(startOfManilaDayIso(new Date("2024-03-10T07:00:00.000Z"))).toBe(
      "2024-03-09T21:00:00.000Z", // 2024-03-10T05:00 Manila
    );
  });

  it("does not flip to the next Manila day before 05:00", () => {
    // 2024-03-09T20:59:59.999Z is 2024-03-10T04:59:59.999 Manila, before reset.
    expect(startOfManilaDayIso(new Date("2024-03-09T20:59:59.999Z"))).toBe(
      "2024-03-08T21:00:00.000Z",
    );
  });

  it("flips to the next Manila day exactly at 05:00", () => {
    // 2024-03-09T21:00:00.000Z is exactly 2024-03-10T05:00 Manila.
    expect(startOfManilaDayIso(new Date("2024-03-09T21:00:00.000Z"))).toBe(
      "2024-03-09T21:00:00.000Z",
    );
  });

  // The whole point of this file's timezone decision: a UTC day boundary
  // would put 9am Manila in the middle of "yesterday" by UTC's clock.
  // Asia/Manila correctly puts it on the Manila day that started 9 hours
  // earlier, not 1 hour ago at UTC midnight.
  it("does not use a UTC day boundary", () => {
    // 2024-03-10T01:00:00Z is 2024-03-10T09:00 Manila — well into the
    // Manila reset period that started at 2024-03-09T21:00:00Z (UTC), not UTC
    // day that started at 2024-03-10T00:00:00Z.
    expect(startOfManilaDayIso(new Date("2024-03-10T01:00:00.000Z"))).toBe(
      "2024-03-09T21:00:00.000Z",
    );
  });
});

describe("startOfManilaWeekIso", () => {
  it("returns Monday 05:00 Manila for a mid-week instant", () => {
    // 2024-03-13 is a Wednesday. The most recent Monday is 2024-03-11;
    // Monday 05:00 Manila is 2024-03-10T21:00:00Z (UTC).
    expect(startOfManilaWeekIso(new Date("2024-03-13T05:00:00.000Z"))).toBe(
      "2024-03-10T21:00:00.000Z",
    );
  });

  it("does not roll over on Sunday — Sunday is still the end of the same calendar week", () => {
    // 2024-03-17 is a Sunday, still within the week that started Monday
    // 2024-03-11 — a rolling-7-days window would have already dropped most
    // of that Monday's spend by Sunday; a calendar week has not.
    expect(startOfManilaWeekIso(new Date("2024-03-17T10:00:00.000Z"))).toBe(
      "2024-03-10T21:00:00.000Z",
    );
  });

  it("rolls over to the new week exactly at Monday 05:00 Manila", () => {
    // 2024-03-17T21:00:00.000Z is exactly Monday 05:00 Manila.
    expect(startOfManilaWeekIso(new Date("2024-03-17T21:00:00.000Z"))).toBe(
      "2024-03-17T21:00:00.000Z",
    );
  });

  it("keeps Monday before 05:00 in the previous week", () => {
    expect(startOfManilaWeekIso(new Date("2024-03-17T20:59:59.999Z"))).toBe(
      "2024-03-10T21:00:00.000Z",
    );
  });

  it("an instant already in Monday's reset period returns that Monday's boundary", () => {
    // 2024-03-11 is itself a Monday.
    expect(startOfManilaWeekIso(new Date("2024-03-11T05:00:00.000Z"))).toBe(
      "2024-03-10T21:00:00.000Z",
    );
  });
});

describe("assertCapNotExceeded (daily burst guard)", () => {
  it("allows a render that lands well under the cap", () => {
    expect(() => assertCapNotExceeded(0.5, 1, 2)).not.toThrow();
  });

  it("allows a render that lands exactly at the cap", () => {
    expect(() => assertCapNotExceeded(1, 1, 2)).not.toThrow();
  });

  it("refuses a render that would go one cent over the cap", () => {
    expect(() => assertCapNotExceeded(1.01, 1, 2)).toThrow(/daily burst guard/i);
  });

  it("refuses a render when today's spend already exceeds the cap", () => {
    expect(() => assertCapNotExceeded(3, 1, 2)).toThrow(/daily burst guard/i);
  });

  it("allows a zero-cost estimate regardless of spend, as long as it doesn't push over", () => {
    expect(() => assertCapNotExceeded(2, 0, 2)).not.toThrow();
  });

  it("includes the projected total, cap, and estimate in the error message", () => {
    expect(() => assertCapNotExceeded(1.5, 1, 2)).toThrow(/2\.50/);
  });

  // The distinction the task exists to guarantee: an editor reading this
  // message must be able to tell "I'm over my daily burst guard" (wait
  // until tomorrow) from "I'm over my weekly allowance" (wait until
  // Monday) or "the team is over" (not about me at all) without knowing
  // which function threw it.
  it("names the failure as a personal, daily burst guard — remedy is 'tomorrow'", () => {
    expect(() => assertCapNotExceeded(1.5, 1, 2)).toThrow(/5:00 AM Manila time/i);
  });
});

describe("assertWeeklyCapNotExceeded — the never-had-one case", () => {
  // The first thing a new account hears from this system. "You've used this
  // week's allowance — wait until Monday" is false twice over for someone who
  // was never given one, and it sends them to wait out a cap that will still
  // be zero on Monday. Reachable by design: the editor default is 0.
  it("tells an account with no allowance to ask for one, not to wait until Monday", () => {
    expect(() => assertWeeklyCapNotExceeded(0, 0.44, 0)).toThrow(
      /don't have a weekly allowance yet/,
    );
    expect(() => assertWeeklyCapNotExceeded(0, 0.44, 0)).not.toThrow(/wait until Monday/);
    expect(() => assertWeeklyCapNotExceeded(0, 0.44, 0)).toThrow(/ask an admin/i);
  });

  it("keeps the ordinary exhausted-allowance message for an account that HAS one", () => {
    expect(() => assertWeeklyCapNotExceeded(9, 2, 10)).toThrow(/5:00 AM Monday Manila time/);
  });
});

describe("assertWeeklyCapNotExceeded (weekly allowance)", () => {
  it("allows a render that lands well under the weekly allowance", () => {
    expect(() => assertWeeklyCapNotExceeded(1, 1, 5)).not.toThrow();
  });

  it("allows a render that lands exactly at the weekly allowance", () => {
    expect(() => assertWeeklyCapNotExceeded(4, 1, 5)).not.toThrow();
  });

  it("refuses a render that would go one cent over the weekly allowance", () => {
    expect(() => assertWeeklyCapNotExceeded(4.5, 0.51, 5)).toThrow(/weekly allowance/i);
  });

  it("refuses a render when this week's spend already exceeds the allowance", () => {
    expect(() => assertWeeklyCapNotExceeded(6, 1, 5)).toThrow(/weekly allowance/i);
  });

  it("includes the projected total, cap, and estimate in the error message", () => {
    expect(() => assertWeeklyCapNotExceeded(4.5, 1, 5)).toThrow(/5\.50/);
  });

  // The distinction that matters: the remedy is "Monday," not "tomorrow" —
  // conflating the two would send someone to retry a request that keeps
  // failing for up to six more days.
  it("names the failure as the weekly allowance — remedy is 'Monday', not 'tomorrow'", () => {
    expect(() => assertWeeklyCapNotExceeded(4.5, 1, 5)).toThrow(/5:00 AM Monday Manila time/i);
  });
});

// Same arithmetic as assertCapNotExceeded's own suite above — this table is
// intentionally the mirror of that one, just against the team's total
// instead of one account's, to pin that the two guards agree on the
// boundary even though they're separate functions with separate messages.
describe("assertGlobalCapNotExceeded", () => {
  it("allows a render that lands well under the global cap", () => {
    expect(() => assertGlobalCapNotExceeded(10, 19.2, 100)).not.toThrow();
  });

  it("allows a render that lands exactly at the global cap", () => {
    expect(() => assertGlobalCapNotExceeded(80.8, 19.2, 100)).not.toThrow();
  });

  it("refuses a render that would go one cent over the global cap", () => {
    expect(() => assertGlobalCapNotExceeded(80.81, 19.2, 100)).toThrow(/global daily cap/i);
  });

  it("refuses a render when the team's spend already exceeds the global cap", () => {
    expect(() => assertGlobalCapNotExceeded(120, 19.2, 100)).toThrow(/global daily cap/i);
  });

  it("includes the projected total, cap, and estimate in the error message", () => {
    expect(() => assertGlobalCapNotExceeded(90, 19.2, 100)).toThrow(/109\.20/);
  });

  // The distinction the task exists to guarantee, from the other side: an
  // editor well under their OWN caps must still be told this is a
  // team-wide refusal, not mistake it for their personal limit.
  it("names the failure as the team's, not personal", () => {
    expect(() => assertGlobalCapNotExceeded(90, 19.2, 100)).toThrow(
      /team has hit the daily limit/i,
    );
  });

  it("uses the weekly window and Monday reset when selected", () => {
    expect(() => assertGlobalCapNotExceeded(90, 19.2, 100, "weekly")).toThrow(/global weekly cap/i);
    expect(() => assertGlobalCapNotExceeded(90, 19.2, 100, "weekly")).toThrow(/5:00 AM Monday Manila time/i);
  });
});

describe("assertHourlyCapNotExceeded", () => {
  it("allows spend within the rolling-hour cap and refuses spend over it", () => {
    expect(() => assertHourlyCapNotExceeded(4, 1, 5)).not.toThrow();
    expect(() => assertHourlyCapNotExceeded(4.01, 1, 5)).toThrow(/hourly cap/i);
  });
});

describe("assertKieBalanceCoversEstimate", () => {
  it("allows a render the balance can cover", () => {
    expect(() => assertKieBalanceCoversEstimate(31.17, 19.2)).not.toThrow();
  });

  it("allows a render that lands exactly at the balance", () => {
    expect(() => assertKieBalanceCoversEstimate(19.2, 19.2)).not.toThrow();
  });

  it("refuses a render the balance falls short of", () => {
    expect(() => assertKieBalanceCoversEstimate(5, 19.2)).toThrow();
  });

  // The whole point of part 1: the message is for an editor who cannot fund
  // the account — no raw vendor error, no balance figure they can't act on,
  // just what happened and who can fix it.
  it("names who can act on the refusal, and does not leak a balance figure", () => {
    expect(() => assertKieBalanceCoversEstimate(5, 19.2)).toThrow(/admin/i);
    try {
      assertKieBalanceCoversEstimate(5, 19.2);
      throw new Error("expected assertKieBalanceCoversEstimate to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/\$5\b/);
      expect(message).not.toMatch(/402/);
    }
  });

  it("names kie.ai as the account that needs funding", () => {
    try {
      assertKieBalanceCoversEstimate(0, 2.8);
      throw new Error("expected assertKieBalanceCoversEstimate to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/kie\.ai/);
    }
  });
});

describe("endOfManilaDayIso", () => {
  it("is the next 05:00 Manila reset", () => {
    // 2024-03-13 13:00 Manila -> 2024-03-14 05:00 Manila.
    expect(endOfManilaDayIso(new Date("2024-03-13T05:00:00.000Z"))).toBe(
      "2024-03-13T21:00:00.000Z",
    );
    // 23:30 Manila still ends at the next 05:00, not the one after.
    expect(endOfManilaDayIso(new Date("2024-03-13T15:30:00.000Z"))).toBe(
      "2024-03-13T21:00:00.000Z",
    );
  });
});

describe("effectiveDailyCapUsd", () => {
  it("adds active grants to the daily cap, never above the grant-inclusive weekly one", () => {
    const caps = { dailyCapUsd: 5, weeklyCapUsd: 25 };
    expect(effectiveDailyCapUsd(caps, 25)).toBe(5);
    expect(effectiveDailyCapUsd(caps, 35)).toBe(15);
    expect(effectiveDailyCapUsd({ dailyCapUsd: 25, weeklyCapUsd: 25 }, 30)).toBe(30);
  });
});

describe("endOfManilaWeekIso", () => {
  it("is exactly one week (168h) after startOfManilaWeekIso for the same instant", () => {
    const now = new Date("2024-03-13T05:00:00.000Z");
    const start = new Date(startOfManilaWeekIso(now)).getTime();
    const end = new Date(endOfManilaWeekIso(now)).getTime();
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("lands on the FOLLOWING Monday 05:00 Manila for a mid-week instant", () => {
    // Same fixture as startOfManilaWeekIso's own suite: 2024-03-13 is a
    // Wednesday in the week starting Monday 2024-03-11. The next Monday,
    // 2024-03-18 05:00 Manila is 2024-03-17T21:00:00Z (UTC).
    expect(endOfManilaWeekIso(new Date("2024-03-13T05:00:00.000Z"))).toBe(
      "2024-03-17T21:00:00.000Z",
    );
  });

  it("an instant exactly at this week's end returns the NEXT week's end, not the same instant twice", () => {
    // 2024-03-17T21:00:00.000Z is Monday 05:00 Manila — the start of
    // a new week, so its "end" is a further week out.
    expect(endOfManilaWeekIso(new Date("2024-03-17T21:00:00.000Z"))).toBe(
      "2024-03-24T21:00:00.000Z",
    );
  });
});

// Pure decision function backing the "Request more" allowance affordance
// (decision 2 of the allowance-request workflow) — see this function's own
// doc comment in spend.ts. No database involved: every case here is just
// three numbers in, one of four labels out.
describe("bindingSpendCap", () => {
  it("returns null when every cap still has headroom", () => {
    expect(
      bindingSpendCap({ globalRemainingUsd: 10, weeklyRemainingUsd: 5, dailyRemainingUsd: 2 }),
    ).toBeNull();
  });

  it("returns 'weekly' when only the weekly cap is exhausted — the one case that shows 'Request more'", () => {
    expect(
      bindingSpendCap({ globalRemainingUsd: 10, weeklyRemainingUsd: 0, dailyRemainingUsd: 2 }),
    ).toBe("weekly");
  });

  it("returns 'daily' when only the daily burst guard is exhausted — 'Request more' must NOT show here, since a weekly grant never touches the daily guard", () => {
    expect(
      bindingSpendCap({ globalRemainingUsd: 10, weeklyRemainingUsd: 5, dailyRemainingUsd: 0 }),
    ).toBe("daily");
  });

  it("returns 'global' when the team-wide cap is exhausted, even if this account's own caps still have headroom", () => {
    expect(
      bindingSpendCap({ globalRemainingUsd: 0, weeklyRemainingUsd: 5, dailyRemainingUsd: 2 }),
    ).toBe("global");
  });

  it("prioritises global over weekly over daily when more than one is exhausted at once — same order assertWithinSpendCaps checks in", () => {
    expect(
      bindingSpendCap({ globalRemainingUsd: 0, weeklyRemainingUsd: 0, dailyRemainingUsd: 0 }),
    ).toBe("global");
    expect(
      bindingSpendCap({ globalRemainingUsd: 10, weeklyRemainingUsd: 0, dailyRemainingUsd: 0 }),
    ).toBe("weekly");
  });

  it("treats landing exactly at 0 remaining as exhausted, not as headroom", () => {
    expect(
      bindingSpendCap({ globalRemainingUsd: 10, weeklyRemainingUsd: 0, dailyRemainingUsd: 2 }),
    ).toBe("weekly");
    // A negative remaining (already over, e.g. the CONCURRENCY HOLE this
    // file documents let two renders race past the same cap) is exhausted
    // too, not somehow "less exhausted" than exactly 0.
    expect(
      bindingSpendCap({ globalRemainingUsd: 10, weeklyRemainingUsd: -3, dailyRemainingUsd: 2 }),
    ).toBe("weekly");
  });
});

// grantWouldUnblock answers a DIFFERENT question than bindingSpendCap: not
// "which refusal message wins priority" but "would a grant actually change
// the outcome". The case that matters most here is the one bindingSpendCap
// gets right for ITS job and wrong for this one: weekly AND daily both
// exhausted at once, the normal state at the shipped $5/day, $10/week
// defaults (two days already exhausts the week).
describe("grantWouldUnblock", () => {
  it("is false when every cap still has headroom — there's nothing to unblock", () => {
    expect(
      grantWouldUnblock({ globalRemainingUsd: 10, weeklyRemainingUsd: 5, dailyRemainingUsd: 2 }),
    ).toBe(false);
  });

  it("is true when ONLY the weekly cap is exhausted — the one case a grant genuinely helps", () => {
    expect(
      grantWouldUnblock({ globalRemainingUsd: 10, weeklyRemainingUsd: 0, dailyRemainingUsd: 2 }),
    ).toBe(true);
  });

  it("is true when weekly AND daily are both exhausted — a grant raises both ceilings", () => {
    expect(
      grantWouldUnblock({ globalRemainingUsd: 10, weeklyRemainingUsd: 0, dailyRemainingUsd: 0 }),
    ).toBe(true);
  });

  it("is false when weekly AND global are both exhausted — a grant never touches the team-wide cap either", () => {
    expect(
      grantWouldUnblock({ globalRemainingUsd: 0, weeklyRemainingUsd: 0, dailyRemainingUsd: 2 }),
    ).toBe(false);
  });

  it("is true when only the daily guard is exhausted — a grant raises today's limit", () => {
    expect(
      grantWouldUnblock({ globalRemainingUsd: 10, weeklyRemainingUsd: 5, dailyRemainingUsd: 0 }),
    ).toBe(true);
  });

  it("is false when only the global cap is exhausted", () => {
    expect(
      grantWouldUnblock({ globalRemainingUsd: 0, weeklyRemainingUsd: 5, dailyRemainingUsd: 2 }),
    ).toBe(false);
  });

  it("treats a negative daily/global remaining (already over, not just at 0) as exhausted, same as bindingSpendCap's convention", () => {
    expect(
      grantWouldUnblock({ globalRemainingUsd: -1, weeklyRemainingUsd: 0, dailyRemainingUsd: 2 }),
    ).toBe(false);
    expect(
      grantWouldUnblock({ globalRemainingUsd: 10, weeklyRemainingUsd: 5, dailyRemainingUsd: -1 }),
    ).toBe(true);
  });
});

// The "Request more" dialog's three (well, five) honest states — the fix
// for the bug this whole task exists to close: the dialog used to be
// gated on grantWouldUnblock, so an editor with headroom everywhere never
// saw the control at all. These tests exist to constrain the actual
// three-way split described in the task ("weekly exhausted", "nothing
// exhausted", "daily/global blocking regardless of weekly"), not just
// mirror grantWouldUnblock's cases with a different label — each case
// below asserts a DIFFERENT dialog message would show, which a test that
// merely reimplemented the function under test could not distinguish.
describe("allowanceDialogState", () => {
  it('is "normal" when weekly is the ONLY thing exhausted — the ordinary request flow', () => {
    expect(
      allowanceDialogState({ globalRemainingUsd: 10, weeklyRemainingUsd: 0, dailyRemainingUsd: 2 }),
    ).toBe("normal");
  });

  it('is "headroom" when nothing is exhausted yet — the fresh-editor case this task exists to fix', () => {
    expect(
      allowanceDialogState({ globalRemainingUsd: 10, weeklyRemainingUsd: 5, dailyRemainingUsd: 2 }),
    ).toBe("headroom");
  });

  it("is 'normal' when the daily guard is exhausted — a grant raises today's limit", () => {
    expect(
      allowanceDialogState({ globalRemainingUsd: 10, weeklyRemainingUsd: 5, dailyRemainingUsd: 0 }),
    ).toBe("normal");
  });

  it('is "blocked-global" when the team cap is exhausted, even though weekly still has room', () => {
    expect(
      allowanceDialogState({ globalRemainingUsd: 0, weeklyRemainingUsd: 5, dailyRemainingUsd: 2 }),
    ).toBe("blocked-global");
  });

  it('is "normal" when weekly AND daily are both exhausted', () => {
    expect(
      allowanceDialogState({ globalRemainingUsd: 10, weeklyRemainingUsd: 0, dailyRemainingUsd: 0 }),
    ).toBe("normal");
  });

  it('is "blocked-global" when the daily guard AND the global cap are both exhausted', () => {
    expect(
      allowanceDialogState({ globalRemainingUsd: 0, weeklyRemainingUsd: 5, dailyRemainingUsd: 0 }),
    ).toBe("blocked-global");
  });

  it("treats a negative remaining (already over, not just at 0) as exhausted, same convention as bindingSpendCap/grantWouldUnblock", () => {
    expect(
      allowanceDialogState({
        globalRemainingUsd: 10,
        weeklyRemainingUsd: 5,
        dailyRemainingUsd: -1,
      }),
    ).toBe("normal");
  });
});

// getEffectiveWeeklyCapUsd / getRemainingWeeklyBudget / getRemainingBudget
// all call createAdminClient() internally (same as getDailySpend/
// getWeeklySpend/getGlobalDailySpend above them, none of which this file
// unit-tests either — see this file's own module comment: everything above
// this point is deliberately pure). Testing the grants-folding arithmetic
// itself, though, is exactly what the task this feature shipped for asks
// for ("the effective-weekly-cap arithmetic with and without grants" /
// "that a grant does not raise the daily cap") — so this one block mocks
// lib/supabase/server's createAdminClient, the one seam these three
// functions actually have, rather than leaving that arithmetic untested.
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

describe("getEffectiveWeeklyCapUsd / getRemainingWeeklyBudget / getRemainingBudget (grants folding)", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  // An account with an explicit, admin-set allowance — NOT the editor role
  // default, which is 0 (a new account spends nothing until an admin acts).
  // These tests are about the cap ARITHMETIC: global vs weekly vs daily
  // ordering, in-flight holds, the balance step. Leaning on whatever the
  // role default happened to be made them refuse everything the moment that
  // number legitimately changed, which said nothing about the arithmetic.
  // An explicit, admin-set allowance rather than the editor role default,
  // which is 0 — a new account spends nothing until an admin acts. These
  // tests are about how GRANTS FOLD INTO a cap, and at a base of 0 that
  // arithmetic degenerates ("base + grant" becomes "grant") and would stop
  // catching a sign error. The figures are local so the block no longer
  // depends on what any role default happens to be.
  const EDITOR_WEEKLY_USD = 10;
  const EDITOR_DAILY_USD = 5;
  const editorProfile = {
    role: "editor" as const,
    daily_cap_override_usd: EDITOR_DAILY_USD,
    weekly_cap_override_usd: EDITOR_WEEKLY_USD,
  };

  /** Fakes createAdminClient().rpc(fnName, ...) with one canned value per RPC function name. */
  async function mockAdminRpc(responses: Record<string, number>): Promise<void> {
    const { createAdminClient } = await import("@/lib/supabase/server");
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: vi.fn((fnName: string) =>
        Promise.resolve({ data: responses[fnName] ?? 0, error: null }),
      ),
    } as unknown as SupabaseClient<Database>);
  }

  it("with no active grants, the effective weekly cap equals the plain role/override figure", async () => {
    await mockAdminRpc({ user_active_grants_usd: 0 });
    const { getEffectiveWeeklyCapUsd } = await import("./spend");

    expect(await getEffectiveWeeklyCapUsd("u1", editorProfile)).toBe(EDITOR_WEEKLY_USD);
  });

  it("with active grants, the effective weekly cap is the role/override figure PLUS the sum of unexpired grants", async () => {
    await mockAdminRpc({ user_active_grants_usd: 7 });
    const { getEffectiveWeeklyCapUsd } = await import("./spend");

    expect(await getEffectiveWeeklyCapUsd("u1", editorProfile)).toBe(EDITOR_WEEKLY_USD + 7);
  });

  // THE test for credit passing (0087_pass_allowance.sql). If one assertion
  // from that feature's enforcement half survives, it is this one.
  //
  // A pass writes two allowance_grants rows: +X to the recipient and −X to
  // the sender. Nothing in this file, in the four SQL grant aggregates, or
  // in the two row selects was taught what a pass is — they all still just
  // SUM amount_usd over a user's active grants. The entire design rests on
  // that sum being smaller for a sender, and on the cap check downstream
  // enforcing against the smaller figure rather than clamping it back up.
  //
  // If either half of this test fails, a sender can pass headroom away and
  // keep spending it, and the feature has invented money.
  it("a NEGATIVE grant row (the sender's half of a pass) LOWERS the effective weekly cap", async () => {
    await mockAdminRpc({ user_active_grants_usd: -4 });
    const { getEffectiveWeeklyCapUsd } = await import("./spend");

    expect(await getEffectiveWeeklyCapUsd("u1", editorProfile)).toBe(EDITOR_WEEKLY_USD - 4);
  });

  it("assertWeeklyCapNotExceeded refuses against the LOWERED cap a passed-out amount leaves behind", async () => {
    await mockAdminRpc({ user_active_grants_usd: -4 });
    const { getEffectiveWeeklyCapUsd } = await import("./spend");
    const effectiveCapUsd = await getEffectiveWeeklyCapUsd("u1", editorProfile);

    // $5 spent, $2 more asked for. Under the account's own $10 allowance
    // that is fine; after passing $4 away it is not, and the ceiling this
    // refuses against has to be the $6 that is actually left.
    expect(effectiveCapUsd).toBe(6);
    expect(() => assertWeeklyCapNotExceeded(5, 2, effectiveCapUsd)).toThrow(/weekly allowance/i);
    expect(() => assertWeeklyCapNotExceeded(5, 1, effectiveCapUsd)).not.toThrow();
    // The same spend and estimate against the UNPASSED cap is allowed —
    // proof the refusal above comes from the pass, not from the fixture
    // being over its cap to begin with.
    expect(() => assertWeeklyCapNotExceeded(5, 2, EDITOR_WEEKLY_USD)).not.toThrow();
  });

  it("getRemainingWeeklyBudget nets this week's spend against the GRANT-INCLUSIVE cap, not the bare one", async () => {
    await mockAdminRpc({ user_spend_usd: 8, user_active_grants_usd: 5 });
    const { getRemainingWeeklyBudget } = await import("./spend");

    expect(await getRemainingWeeklyBudget("u1", editorProfile)).toBe(EDITOR_WEEKLY_USD + 5 - 8);
  });

  it("getRemainingBudget (the DAILY figure) includes active grants — a grant raises today's limit too", async () => {
    await mockAdminRpc({ user_spend_usd: 3, user_active_grants_usd: 5 });
    const { getRemainingBudget } = await import("./spend");

    expect(await getRemainingBudget("u1", editorProfile)).toBe(
      Math.min(EDITOR_DAILY_USD + 5, EDITOR_WEEKLY_USD + 5) - 3,
    );
  });
});

// ---------------------------------------------------------------------------
// assertWithinSpendCaps — the kie balance check's skip/refuse/pass behavior
// ---------------------------------------------------------------------------
//
// Only lib/kie-balance is mocked wholesale — db-aggregates is left real and
// driven through the SAME createAdminClient().rpc seam the grants block
// above already established (spend_total_usd / user_spend_usd /
// user_active_grants_usd are all thin `.rpc(...)` wrappers — see
// db-aggregates.ts). Mocking db-aggregates itself here too would have
// silently broken the grants block's tests earlier in this file (a vi.mock
// factory is hoisted file-wide, not scoped to one describe), which is
// exactly the kind of cross-block seam this comment exists to warn the next
// editor away from re-introducing.
//
// estimatedUsd is kept small ($3) and every RPC response $0, so
// global/weekly/daily all trivially pass regardless of role defaults —
// this block's whole purpose is pinning ONE thing: the kie-balance step
// refuses when short, passes when sufficient, and — the judgement call this
// task is explicit about getting right — SKIPS rather than BLOCKS when the
// read itself fails, leaving the three pre-existing caps (exercised for
// real here, not stubbed) as what actually decides the outcome.
vi.mock("@/lib/kie-balance", () => ({
  getKieAccountBalanceUsd: vi.fn(),
}));

/**
 * Every RPC (spend_total_usd, user_spend_usd, user_active_grants_usd)
 * answers $0, and the in-flight scenes read answers with `rows`.
 *
 * `from` has to be here, not just `rpc`: getInFlightSpend reads `scenes`
 * through this same client, and a mock without it makes that read throw
 * into assertWithinSpendCaps' fail-soft branch — which is a real code
 * path, but it means a test believing it exercised the caps actually
 * exercised the degraded fallback.
 */
async function mockZeroSpend(
  rows: unknown[] = [],
  // The installation's daily-guard default, which getUserDailyCapEnabled now
  // reads from app_settings instead of an env var (0077_daily_cap_toggle.sql).
  // Defaults false, matching the seeded row and the shipped behaviour.
  userDailyCapEnabled = false,
): Promise<{ order: ReturnType<typeof vi.fn> }> {
  const { createAdminClient } = await import("@/lib/supabase/server");
  const settingsBuilder = {
    select: vi.fn(() => settingsBuilder),
    limit: vi.fn(() => settingsBuilder),
    maybeSingle: vi.fn(() =>
      Promise.resolve({ data: { user_daily_cap_enabled: userDailyCapEnabled }, error: null }),
    ),
  };
  const builder = {
    select: vi.fn(() => builder),
    in: vi.fn(() => builder),
    // .eq() is the MODE partition (scenes.dev). It belongs in the chain
    // rather than stubbed away: a developer's mocked renders sit in the same
    // table, and counting them here would refuse real work on headroom that
    // nothing will ever bill for.
    eq: vi.fn(() => builder),
    // .order() is part of the chain on purpose — a paginated read of a
    // mutating set without a stable sort can skip or repeat a row, so a
    // mock missing it would make that requirement untestable here.
    order: vi.fn(() => builder),
    range: vi.fn(() => Promise.resolve({ data: rows, error: null })),
  };
  const runsBuilder = {
    select: vi.fn(() => runsBuilder),
    eq: vi.fn(() => runsBuilder),
    not: vi.fn(() => runsBuilder),
    gte: vi.fn(() => runsBuilder),
    lt: vi.fn(() => Promise.resolve({ data: [], error: null })),
  };
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi.fn(() => Promise.resolve({ data: 0, error: null })),
    // Table-aware: app_settings is a one-row lookup with a different chain
    // (limit/maybeSingle) from the scenes read's select/in/eq/order/range, and
    // a single builder serving both would make one of them silently wrong.
    from: vi.fn((table: string) => {
      if (table === "app_settings") return settingsBuilder;
      if (table === "runs") return runsBuilder;
      return builder;
    }),
  } as unknown as SupabaseClient<Database>);
  return builder;
}

/** One in-flight scene owned by `userId`, priced off the project's model. */
function inFlightScene(userId: string, durationS: number): unknown {
  return {
    duration_s: durationS,
    is_talking_head: false,
    render_settings_override: null,
    projects: { user_id: userId, render_settings: null },
  };
}

describe("assertWithinSpendCaps — kie balance step", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  // An account with an explicit, admin-set allowance — NOT the editor role
  // default, which is 0 (a new account spends nothing until an admin acts).
  // These tests are about the cap ARITHMETIC: global vs weekly vs daily
  // ordering, in-flight holds, the balance step. Leaning on whatever the
  // role default happened to be made them refuse everything the moment that
  // number legitimately changed, which said nothing about the arithmetic.
  const editorProfile = {
    role: "editor" as const,
    daily_cap_override_usd: 5,
    weekly_cap_override_usd: 10,
  };

  const estimatedUsd = 3; // well under every real DAILY_CAP_USD/WEEKLY_CAP_USD default

  it("lets an exempt account past an exhausted team cap, and still blocks everyone else", async () => {
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(1000);
    await mockZeroSpend();
    const { createAdminClient } = await import("@/lib/supabase/server");
    // The team has already spent $150 against the default $100 daily team cap;
    // this account itself has spent nothing.
    const client = createAdminClient() as unknown as { rpc: ReturnType<typeof vi.fn> };
    client.rpc = vi.fn((fn: string) =>
      Promise.resolve({ data: fn === "spend_total_usd" ? 150 : 0, error: null }),
    );
    const { assertWithinSpendCaps } = await import("./spend");

    expect(await assertWithinSpendCaps("u1", editorProfile, estimatedUsd)).toEqual({
      error: expect.stringMatching(/global/i),
    });
    expect(
      await assertWithinSpendCaps(
        "u1",
        { ...editorProfile, global_cap_exempt: true },
        estimatedUsd,
      ),
      "an exempt account was still stopped by the team cap",
    ).toBeUndefined();
  });

  it("refuses when the kie balance cannot cover the estimate", async () => {
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(1);
    const { assertWithinSpendCaps } = await import("./spend");

    const result = await assertWithinSpendCaps("u1", editorProfile, estimatedUsd);
    expect(result).toEqual({ error: expect.stringMatching(/admin/i) });
  });

  // -------------------------------------------------------------------------
  // AN UNPRICEABLE CLIP IS NOT AN UNFUNDED ACCOUNT.
  //
  // priceForSecond returns +Infinity for a model/resolution nobody has
  // priced. That Infinity used to flow straight into the balance step, where
  // `balanceUsd < estimatedUsd` is true against ANY balance — so an operator
  // picking Seedance 2.0 was told "the kie.ai account needs additional
  // funding" while kie held $89.03. The message named the wrong problem, the
  // wrong system and the wrong person to fix it.
  //
  // Asserted as "does not mention funding" as well as "says it cannot be
  // priced", because the failure mode being guarded is specifically a refusal
  // that sends someone to top up an account that is fine.
  // -------------------------------------------------------------------------
  it("refuses an unpriceable estimate without blaming the balance", async () => {
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(89.03);
    const { assertWithinSpendCaps } = await import("./spend");

    const result = await assertWithinSpendCaps("u1", editorProfile, Number.POSITIVE_INFINITY);

    expect(result?.error).toMatch(/cannot be priced/i);
    expect(
      result?.error,
      "an unpriced model/resolution was reported as a funding problem",
    ).not.toMatch(/funding|fund the account/i);
  });

  it("does not reach the balance read at all when the estimate is unpriceable", async () => {
    // The balance is fine here; the point is that asking kie about it is not
    // even relevant, so the refusal must not depend on the answer.
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(89.03);
    const { assertWithinSpendCaps } = await import("./spend");

    await assertWithinSpendCaps("u1", editorProfile, Number.POSITIVE_INFINITY);

    expect(getKieAccountBalanceUsd).not.toHaveBeenCalled();
  });

  it("passes when the kie balance covers the estimate", async () => {
    await mockZeroSpend();
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(100);
    const { assertWithinSpendCaps } = await import("./spend");

    const result = await assertWithinSpendCaps("u1", editorProfile, estimatedUsd);
    expect(result).toBeUndefined();
  });

  // The judgement call: a balance a real check would have refused (1 < 3)
  // must NOT block the render when the read itself failed (null) — only
  // when the read succeeds and genuinely comes back short.
  it("skips (does not block) when the balance read fails, even though a real read would have refused", async () => {
    await mockZeroSpend();
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(null);
    const { assertWithinSpendCaps } = await import("./spend");

    const result = await assertWithinSpendCaps("u1", editorProfile, estimatedUsd);
    expect(result).toBeUndefined();
  });

  it("skips the balance read entirely for a zero-dollar estimate", async () => {
    await mockZeroSpend();
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    const { assertWithinSpendCaps } = await import("./spend");

    const result = await assertWithinSpendCaps("u1", editorProfile, 0);
    expect(result).toBeUndefined();
    expect(getKieAccountBalanceUsd).not.toHaveBeenCalled();
  });

  it("does not enforce the per-user daily threshold when the optional guard is off", async () => {
    await mockZeroSpend([], false);
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(100);
    const { assertWithinSpendCaps } = await import("./spend");

    const result = await assertWithinSpendCaps(
      "u1",
      { ...editorProfile, daily_cap_override_usd: 0 },
      estimatedUsd,
    );
    expect(result).toBeUndefined();
  });

  it("enforces the per-user daily threshold when the installation has it on", async () => {
    await mockZeroSpend([], true);
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(100);
    const { assertWithinSpendCaps } = await import("./spend");

    const result = await assertWithinSpendCaps(
      "u1",
      { ...editorProfile, daily_cap_override_usd: 0 },
      estimatedUsd,
    );
    expect(result).toEqual({ error: expect.stringMatching(/daily burst guard/i) });
  });
});

// ---------------------------------------------------------------------------
// assertWithinSpendCaps — renders committed but not yet recorded
// ---------------------------------------------------------------------------
//
// `runs` rows are written at COMPLETION (the worker's MarkDone/MarkFailed),
// so between 'queued' and 'done' a render's cost is invisible to every cap.
// That window is the length of a render — four minutes was measured on one
// Seedance Mini scene — and two operators confirming inside it both read a
// total missing the other's work. These pin that the in-flight estimate is
// folded in, which is what makes the second one refuse.
describe("assertWithinSpendCaps — in-flight renders", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  // An account with an explicit, admin-set allowance — NOT the editor role
  // default, which is 0 (a new account spends nothing until an admin acts).
  // These tests are about the cap ARITHMETIC: global vs weekly vs daily
  // ordering, in-flight holds, the balance step. Leaning on whatever the
  // role default happened to be made them refuse everything the moment that
  // number legitimately changed, which said nothing about the arithmetic.
  const editorProfile = {
    role: "editor" as const,
    daily_cap_override_usd: 5,
    weekly_cap_override_usd: 10,
  };

  it("passes a modest estimate when nothing is in flight", async () => {
    await mockZeroSpend([]);
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(10_000);
    const { assertWithinSpendCaps } = await import("./spend");

    expect(await assertWithinSpendCaps("u1", editorProfile, 3)).toBeUndefined();
  });

  // The only part of the ordering requirement a mock can enforce. A mock
  // returns whatever rows it was given regardless of sort, so deleting
  // .order() from the query changes no result here — the skipped/duplicated
  // row it causes only happens against a real, concurrently-mutating table.
  // Asserting the CALL is therefore the guard: it fails the moment someone
  // removes the clause, which is the realistic regression.
  it("reads the in-flight set in a stable order, since it pages with .range()", async () => {
    const builder = await mockZeroSpend([inFlightScene("u1", 6)]);
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(10_000);
    const { assertWithinSpendCaps } = await import("./spend");

    await assertWithinSpendCaps("u1", editorProfile, 3);

    expect(builder.order).toHaveBeenCalledWith("id", { ascending: true });
  });

  it("refuses when in-flight renders exhaust the cap, though `runs` still reads $0", async () => {
    // Every RPC answers $0 — the pre-existing caps see an account that has
    // spent nothing. The only thing that can refuse this is the queued work.
    const manyLongScenes = Array.from({ length: 400 }, () => inFlightScene("u1", 14));
    await mockZeroSpend(manyLongScenes);
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(10_000);
    const { assertWithinSpendCaps } = await import("./spend");

    expect(await assertWithinSpendCaps("u1", editorProfile, 3)).toEqual({
      error: expect.any(String),
    });
  });

  it("charges in-flight work to its owner, not to whoever is asking", async () => {
    // Same queue, different caller. u2 has nothing in flight, so the cap
    // that refused u1 above must not refuse u2 — an in-flight total applied
    // to every account would silently freeze the whole team.
    const manyLongScenes = Array.from({ length: 400 }, () => inFlightScene("u1", 14));
    await mockZeroSpend(manyLongScenes);
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(10_000);
    const { assertWithinSpendCaps } = await import("./spend");

    // The GLOBAL cap still sees all of it, so this is only meaningful below
    // that ceiling — a smaller queue that no single account's cap would
    // stop.
    await mockZeroSpend([inFlightScene("u1", 14)]);
    expect(await assertWithinSpendCaps("u2", editorProfile, 3)).toBeUndefined();
  });

  it("degrades instead of freezing every render when the in-flight read fails", async () => {
    // A throw here would refuse the whole account on a transient failure,
    // trading an occasional overspend for a total outage of the thing the
    // caps exist to permit.
    const { createAdminClient } = await import("@/lib/supabase/server");
    const builder = {
      select: vi.fn(() => builder),
      in: vi.fn(() => builder),
      // .eq() is the MODE partition (scenes.dev) — see mockZeroSpend's own
      // note on why it belongs in the chain rather than stubbed away.
      eq: vi.fn(() => builder),
      // .order() is part of the chain on purpose — a paginated read of a
      // mutating set without a stable sort can skip or repeat a row, so a
      // mock missing it would make that requirement untestable here.
      order: vi.fn(() => builder),
      range: vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } })),
    };
    // app_settings still answers: this test is about the IN-FLIGHT read
    // failing, and a fake that broke the settings lookup too would prove the
    // degrade path for the wrong reason.
    const settingsBuilder = {
      select: vi.fn(() => settingsBuilder),
      limit: vi.fn(() => settingsBuilder),
      maybeSingle: vi.fn(() =>
        Promise.resolve({ data: { user_daily_cap_enabled: false }, error: null }),
      ),
    };
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: vi.fn(() => Promise.resolve({ data: 0, error: null })),
      from: vi.fn((table: string) => (table === "app_settings" ? settingsBuilder : builder)),
    } as unknown as SupabaseClient<Database>);
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(10_000);
    const { assertWithinSpendCaps } = await import("./spend");

    expect(await assertWithinSpendCaps("u1", editorProfile, 3)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAccountBudgetSnapshot — the breakdown fields (Part 2 of the task that
// added them: "show the arithmetic, not just the answer") must sum to
// EXACTLY the same remaining figures assertWithinSpendCaps enforces against
// — not a second, independently-derived number that could quietly disagree.
// `expect(NaN).toBe(NaN)` passes vacuously in vitest (Object.is semantics —
// see the parseCapEnvUsd block's own comment above), so every assertion
// below is a concrete arithmetic identity checked against real numbers, not
// a comparison that could stay green while silently comparing NaN to NaN.
// ---------------------------------------------------------------------------
describe("getAccountBudgetSnapshot — breakdown arithmetic matches enforcement", () => {
  // Frozen to a Wednesday. The test below tells the daily RPC call apart from
  // the weekly one by the `from_ts` each carries — by argument rather than by
  // call order, which is the right instinct, except that weeks start on Monday
  // here, so ON A MONDAY the two boundaries are the SAME instant. The daily
  // branch then matches first and the weekly window receives the daily figure.
  // Red every Monday, green every Tuesday, which reads like a flake and is
  // not one. (Caught 2026-08-24, a Monday, on main and on an unrelated PR in
  // the same hour.) No product bug behind it: on the first day of the week,
  // spend today genuinely IS spend this week.
  //
  // `toFake: ["Date"]` only — faking timers wholesale stalls this test's awaits.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-26T04:00:00.000Z")); // Wednesday noon in Manila
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  // An account with an explicit, admin-set allowance — NOT the editor role
  // default, which is 0 (a new account spends nothing until an admin acts).
  // These tests are about the cap ARITHMETIC: global vs weekly vs daily
  // ordering, in-flight holds, the balance step. Leaning on whatever the
  // role default happened to be made them refuse everything the moment that
  // number legitimately changed, which said nothing about the arithmetic.
  // Explicit figures, not the editor role default (0 — a new account spends
  // nothing until an admin acts). This block asserts that the BREAKDOWN adds
  // up to the enforced remaining figure; at a cap of 0 every term is 0 and
  // the identity holds trivially, proving nothing.
  const EDITOR_WEEKLY_USD = 10;
  const editorProfile = {
    role: "editor" as const,
    daily_cap_override_usd: 5,
    weekly_cap_override_usd: EDITOR_WEEKLY_USD,
  };

  /**
   * getInFlightSpend's own read — `scenes` joined to `projects`, paged.
   *
   * Every mock in this block has to serve it, not just the one test that
   * cares about holds: getInFlightSpendSafe swallows a failed read and
   * returns zero, so a mock that omits this table produces heldUsd === 0 by
   * ACCIDENT and would keep the arithmetic identities below green no matter
   * what the hold arithmetic did. `rows` is what one page returns; the
   * loop stops on the first short page, so a single call is enough.
   */
  function inFlightScenesBuilder(rows: unknown[]) {
    const builder = {
      select: vi.fn(() => builder),
      in: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn(() => Promise.resolve({ data: rows, error: null })),
    };
    return builder;
  }

  it("dailyCapUsd - dailyUsedUsd === dailyRemainingUsd, and weeklyBaseCapUsd + weeklyGrantUsd - weeklyUsedUsd === weeklyRemainingUsd", async () => {
    const { createAdminClient } = await import("@/lib/supabase/server");
    const { startOfManilaDayIso, startOfManilaWeekIso } = await import("./spend");
    const dailyFromTs = startOfManilaDayIso();
    const weeklyFromTs = startOfManilaWeekIso();

    // user_spend_usd is called for BOTH the daily and weekly windows with
    // the SAME function name and different from_ts — distinguish them by
    // that argument, the exact value getDailySpend/getWeeklySpend actually
    // pass, rather than assuming call order.
    const rpc = vi.fn((fnName: string, args: { from_ts?: string }) => {
      if (fnName === "user_spend_usd") {
        if (args.from_ts === dailyFromTs) return Promise.resolve({ data: 2, error: null });
        if (args.from_ts === weeklyFromTs) return Promise.resolve({ data: 8, error: null });
        throw new Error(`unexpected user_spend_usd from_ts: ${args.from_ts}`);
      }
      if (fnName === "user_active_grants_usd") return Promise.resolve({ data: 5, error: null });
      if (fnName === "spend_total_usd") return Promise.resolve({ data: 0, error: null });
      throw new Error(`unexpected rpc call: ${fnName}`);
    });
    // getActiveGrantsSummary's own read: a plain filtered select over
    // allowance_grants, not an rpc — see its doc comment for why the DOLLAR
    // figure (weeklyGrantUsd) is deliberately NOT taken from this read.
    const grantsBuilder = {
      select: vi.fn(function (this: unknown) {
        return this;
      }),
      eq: vi.fn(function (this: unknown) {
        return this;
      }),
      gt: vi.fn(function (this: unknown) {
        return this;
      }),
      is: vi.fn(function (this: unknown) {
        return this;
      }),
      order: vi.fn(() =>
        Promise.resolve({
          data: [{ amount_usd: 5, expires_at: "2026-08-23T00:00:00.000Z" }],
          error: null,
        }),
      ),
    };
    const settingsBuilder = {
      select: vi.fn(() => settingsBuilder),
      limit: vi.fn(() => settingsBuilder),
      maybeSingle: vi.fn(() =>
        Promise.resolve({ data: { user_daily_cap_enabled: false }, error: null }),
      ),
    };
    const scenesBuilder = inFlightScenesBuilder([]);
    const from = vi.fn((table: string) => {
      if (table === "app_settings") return settingsBuilder;
      if (table === "scenes") return scenesBuilder;
      return grantsBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      rpc,
      from,
    } as unknown as SupabaseClient<Database>);

    const { getAccountBudgetSnapshot } = await import("./spend");
    const snapshot = await getAccountBudgetSnapshot("u1", editorProfile);

    // heldUsd is part of the identity now, not an afterthought: it is
    // subtracted from both remaining figures because assertWithinSpendCaps
    // subtracts it from both. Nothing is in flight here, so it is 0 — but
    // it is 0 because the scenes read ANSWERED with no rows, not because
    // the read failed and got swallowed (see inFlightScenesBuilder).
    expect(snapshot.heldUsd).toBe(0);
    expect(snapshot.dailyCapUsd - snapshot.dailyUsedUsd - snapshot.heldUsd).toBe(
      snapshot.dailyRemainingUsd,
    );
    expect(
      snapshot.weeklyBaseCapUsd +
        snapshot.weeklyGrantUsd -
        snapshot.weeklyUsedUsd -
        snapshot.heldUsd,
    ).toBe(snapshot.weeklyRemainingUsd);
    // The grant figure itself: DAILY_CAP_USD/WEEKLY_CAP_USD are the editor
    // defaults (no override), and user_active_grants_usd answered 5.
    expect(snapshot.dailyUsedUsd).toBe(2);
    expect(snapshot.weeklyUsedUsd).toBe(8);
    expect(snapshot.weeklyBaseCapUsd).toBe(EDITOR_WEEKLY_USD);
    expect(snapshot.weeklyGrantUsd).toBe(5);
    // The per-grant DETAIL fields (count, earliest expiry) come from the
    // separate getActiveGrantsSummary read, not from user_active_grants_usd
    // — proof that they reflect the fake row above, not the rpc's bare sum.
    expect(snapshot.weeklyGrantCount).toBe(1);
    expect(snapshot.weeklyGrantEarliestExpiresAt).toBe("2026-08-23T00:00:00.000Z");
  });

  it("a grant of 0 (no active grants) shows no grant line — weeklyGrantCount is 0 and weeklyGrantUsd is 0", async () => {
    const { createAdminClient } = await import("@/lib/supabase/server");
    const rpc = vi.fn(() => Promise.resolve({ data: 0, error: null }));
    const grantsBuilder = {
      select: vi.fn(function (this: unknown) {
        return this;
      }),
      eq: vi.fn(function (this: unknown) {
        return this;
      }),
      gt: vi.fn(function (this: unknown) {
        return this;
      }),
      is: vi.fn(function (this: unknown) {
        return this;
      }),
      order: vi.fn(() => Promise.resolve({ data: [], error: null })),
    };
    const settingsBuilder = {
      select: vi.fn(() => settingsBuilder),
      limit: vi.fn(() => settingsBuilder),
      maybeSingle: vi.fn(() =>
        Promise.resolve({ data: { user_daily_cap_enabled: false }, error: null }),
      ),
    };
    const scenesBuilder = inFlightScenesBuilder([]);
    const from = vi.fn((table: string) => {
      if (table === "app_settings") return settingsBuilder;
      if (table === "scenes") return scenesBuilder;
      return grantsBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      rpc,
      from,
    } as unknown as SupabaseClient<Database>);

    const { getAccountBudgetSnapshot } = await import("./spend");
    const snapshot = await getAccountBudgetSnapshot("u1", editorProfile);

    expect(snapshot.weeklyGrantUsd).toBe(0);
    expect(snapshot.weeklyGrantCount).toBe(0);
    expect(snapshot.weeklyGrantEarliestExpiresAt).toBeNull();
    expect(
      snapshot.weeklyBaseCapUsd +
        snapshot.weeklyGrantUsd -
        snapshot.weeklyUsedUsd -
        snapshot.heldUsd,
    ).toBe(snapshot.weeklyRemainingUsd);
  });

  // Credit passing (0087_pass_allowance.sql). A NET SENDER — one $5 grant
  // from an admin, $3 received from a colleague, $10 passed away — so
  // user_active_grants_usd sums to −2 and weeklyGrantUsd goes NEGATIVE.
  //
  // Nothing clamps that, deliberately: it is the correct arithmetic and it
  // is what enforcement uses. What the three-way split exists for is the
  // DISPLAY, which cannot render "−$2.00 grant" without lying about what
  // happened — the sidebar draws "$5 grant / +$3 received / −$10 passed"
  // off these fields instead.
  it("splits a net sender's active grants into granted / received / passed, and lets the total go negative", async () => {
    const { createAdminClient } = await import("@/lib/supabase/server");
    const rpc = vi.fn((fnName: string) => {
      if (fnName === "user_active_grants_usd") return Promise.resolve({ data: -2, error: null });
      return Promise.resolve({ data: 0, error: null });
    });
    const grantsBuilder = {
      select: vi.fn(function (this: unknown) {
        return this;
      }),
      eq: vi.fn(function (this: unknown) {
        return this;
      }),
      gt: vi.fn(function (this: unknown) {
        return this;
      }),
      is: vi.fn(function (this: unknown) {
        return this;
      }),
      order: vi.fn(() =>
        Promise.resolve({
          data: [
            // An approver's grant: no counterparty.
            { amount_usd: 5, expires_at: "2026-08-31T00:00:00.000Z", transfer_peer_id: null },
            // A pass received.
            { amount_usd: 3, expires_at: "2026-08-31T00:00:00.000Z", transfer_peer_id: "peer-1" },
            // A pass sent — stored negative, reported positive.
            { amount_usd: -10, expires_at: "2026-08-31T00:00:00.000Z", transfer_peer_id: "peer-2" },
          ],
          error: null,
        }),
      ),
    };
    const settingsBuilder = {
      select: vi.fn(() => settingsBuilder),
      limit: vi.fn(() => settingsBuilder),
      maybeSingle: vi.fn(() =>
        Promise.resolve({ data: { user_daily_cap_enabled: false }, error: null }),
      ),
    };
    const scenesBuilder = inFlightScenesBuilder([]);
    const from = vi.fn((table: string) => {
      if (table === "app_settings") return settingsBuilder;
      if (table === "scenes") return scenesBuilder;
      return grantsBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      rpc,
      from,
    } as unknown as SupabaseClient<Database>);

    const { getAccountBudgetSnapshot } = await import("./spend");
    const snapshot = await getAccountBudgetSnapshot("u1", editorProfile);

    expect(snapshot.grantedInUsd).toBe(5);
    expect(snapshot.receivedUsd).toBe(3);
    expect(snapshot.passedOutUsd).toBe(10);
    // The split reconstructs exactly what enforcement enforces — so the
    // sidebar's three lines cannot add up to a different number than the
    // one the next render is refused against.
    expect(snapshot.grantedInUsd + snapshot.receivedUsd - snapshot.passedOutUsd).toBe(
      snapshot.weeklyGrantUsd,
    );
    expect(snapshot.weeklyGrantUsd).toBe(-2);
    // Unclamped, and still part of the identity every other test in this
    // block asserts.
    expect(snapshot.weeklyCapUsd).toBe(EDITOR_WEEKLY_USD - 2);
    expect(
      snapshot.weeklyBaseCapUsd +
        snapshot.weeklyGrantUsd -
        snapshot.weeklyUsedUsd -
        snapshot.heldUsd,
    ).toBe(snapshot.weeklyRemainingUsd);
  });

  // The reason this whole block exists in the shape it does: pressing
  // Generate must take the estimate OUT of the balance immediately, and the
  // figure the operator is SHOWN must be the one the next enqueue will
  // enforce. assertWithinSpendCaps has counted queued/rendering renders
  // since getInFlightSpend was added; every displayed figure did not, so the
  // sidebar read "$X left" and the very next render was refused. If a future
  // edit drops getInFlightSpendSafe out of getAccountBudgetSnapshot, this is
  // the test that goes red.
  it("a queued render is HELD: heldUsd is the estimate, and both remaining figures are that much smaller", async () => {
    const { createAdminClient } = await import("@/lib/supabase/server");
    const rpc = vi.fn(() => Promise.resolve({ data: 0, error: null }));
    const grantsBuilder = {
      select: vi.fn(function (this: unknown) {
        return this;
      }),
      eq: vi.fn(function (this: unknown) {
        return this;
      }),
      gt: vi.fn(function (this: unknown) {
        return this;
      }),
      is: vi.fn(function (this: unknown) {
        return this;
      }),
      order: vi.fn(() => Promise.resolve({ data: [], error: null })),
    };
    const settingsBuilder = {
      select: vi.fn(() => settingsBuilder),
      limit: vi.fn(() => settingsBuilder),
      maybeSingle: vi.fn(() =>
        Promise.resolve({ data: { user_daily_cap_enabled: false }, error: null }),
      ),
    };
    // One scene of u1's sitting in queued/rendering. Priced by the same
    // estimateCost getInFlightSpend uses, so this asserts the wiring — that
    // the hold reaches the snapshot at all — rather than re-deriving a
    // per-second rate the pricing tables above already own.
    const scenesBuilder = inFlightScenesBuilder([
      {
        duration_s: 5,
        is_talking_head: false,
        render_settings_override: null,
        projects: { user_id: "u1", render_settings: {} },
      },
    ]);
    const from = vi.fn((table: string) => {
      if (table === "app_settings") return settingsBuilder;
      if (table === "scenes") return scenesBuilder;
      return grantsBuilder;
    });
    vi.mocked(createAdminClient).mockReturnValue({
      rpc,
      from,
    } as unknown as SupabaseClient<Database>);

    const { getAccountBudgetSnapshot, getInFlightSpend } = await import("./spend");
    const expectedHeldUsd = (await getInFlightSpend()).byUserUsd.get("u1") ?? 0;
    const snapshot = await getAccountBudgetSnapshot("u1", editorProfile);

    expect(expectedHeldUsd).toBeGreaterThan(0);
    expect(snapshot.heldUsd).toBe(expectedHeldUsd);
    // Nothing has been BILLED — the run row only lands when the render
    // finishes — so "used" stays 0 while the money is already unavailable.
    // That split is the whole point of a hold having its own field.
    expect(snapshot.dailyUsedUsd).toBe(0);
    expect(snapshot.weeklyUsedUsd).toBe(0);
    expect(snapshot.dailyRemainingUsd).toBe(snapshot.dailyCapUsd - expectedHeldUsd);
    expect(snapshot.weeklyRemainingUsd).toBe(snapshot.weeklyCapUsd - expectedHeldUsd);
  });
});

describe("getInFlightSpend, token monthly caps, and queueScenesIfWithinCaps", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  const editorProfile = {
    role: "editor" as const,
    daily_cap_override_usd: 5,
    weekly_cap_override_usd: 10,
  };

  it("prices in-flight scenes with video references at the video-input rate and tracks byTokenUsd", async () => {
    await mockZeroSpend([
      {
        duration_s: 5,
        is_talking_head: false,
        render_settings_override: null,
        api_token_id: "tok-1",
        estimated_cost_usd: null,
        projects: {
          user_id: "u1",
          render_settings: { model: "bytedance/seedance-2-fast", resolution: "480p" },
        },
        scene_references: [{ kind: "video", assets: { duration_s: 10 } }],
      },
      {
        duration_s: 5,
        is_talking_head: false,
        render_settings_override: null,
        api_token_id: null,
        estimated_cost_usd: null,
        projects: {
          user_id: "u1",
          render_settings: { model: "bytedance/seedance-2-fast", resolution: "480p" },
        },
        scene_references: [],
      },
    ]);

    const { getInFlightSpend } = await import("./spend");
    const hold = await getInFlightSpend();
    const tokenHold = hold.byTokenUsd.get("tok-1") ?? 0;
    const totalUserHold = hold.byUserUsd.get("u1") ?? 0;
    const nonVideoHold = totalUserHold - tokenHold;

    expect(tokenHold).toBeGreaterThan(nonVideoHold);
    expect(hold.globalUsd).toBeCloseTo(totalUserHold, 5);
  });

  it("enforces tokenMonthlyCapUsd across settled and in-flight token spend", async () => {
    await mockZeroSpend([
      {
        duration_s: 5,
        is_talking_head: false,
        render_settings_override: null,
        api_token_id: "tok-1",
        estimated_cost_usd: 2.5,
        projects: { user_id: "u1", render_settings: null },
        scene_references: [],
      },
    ]);
    const { getKieAccountBalanceUsd } = await import("@/lib/kie-balance");
    vi.mocked(getKieAccountBalanceUsd).mockResolvedValue(100);
    const { assertWithinSpendCaps } = await import("./spend");

    const blocked = await assertWithinSpendCaps("u1", editorProfile, 1.0, {
      apiTokenId: "tok-1",
      tokenMonthlyCapUsd: 3.0,
    });
    expect(blocked).toEqual({
      error: expect.stringMatching(/API token.*monthly cap/i),
    });

    const allowed = await assertWithinSpendCaps("u1", editorProfile, 1.0, {
      apiTokenId: "tok-1",
      tokenMonthlyCapUsd: 5.0,
    });
    expect(allowed).toBeUndefined();
  });

  it("queueScenesIfWithinCaps maps queued, fenced, and blocked RPC outcomes and serializes concurrent submissions", async () => {
    await mockZeroSpend([]);
    const { queueScenesIfWithinCaps } = await import("./spend");
    let inFlightCommitted = 0;

    const fakeAdmin = {
      rpc: vi.fn(async (fnName: string, args: { p_scene_estimates_usd: number[] }) => {
        expect(fnName).toBe("queue_scenes_if_within_caps");
        const est = args.p_scene_estimates_usd.reduce((a, b) => a + b, 0);
        if (inFlightCommitted + est > 10) {
          return {
            data: [
              {
                outcome: "blocked",
                blocked_by: "weekly",
                spent_usd: inFlightCommitted,
                cap_usd: 10,
              },
            ],
            error: null,
          };
        }
        inFlightCommitted += est;
        return {
          data: [{ outcome: "queued", blocked_by: null, spent_usd: 0, cap_usd: 10 }],
          error: null,
        };
      }),
    } as unknown as SupabaseClient<Database>;

    const first = await queueScenesIfWithinCaps({
      admin: fakeAdmin,
      projectId: "project-1",
      userId: "u1",
      profile: editorProfile,
      sceneIds: ["scene-1"],
      estimatesUsd: [6],
    });
    const second = await queueScenesIfWithinCaps({
      admin: fakeAdmin,
      projectId: "project-1",
      userId: "u1",
      profile: editorProfile,
      sceneIds: ["scene-2"],
      estimatesUsd: [6],
    });

    expect(first).toEqual({ outcome: "queued" });
    expect(second.outcome).toBe("blocked");
    if (second.outcome === "blocked") {
      expect(second.blockedBy).toBe("weekly");
      expect(second.error).toMatch(/weekly allowance/i);
    }

    const fencedAdmin = {
      rpc: vi.fn(async () => ({
        data: [{ outcome: "fenced", blocked_by: null, spent_usd: 0, cap_usd: 0 }],
        error: null,
      })),
    } as unknown as SupabaseClient<Database>;

    const fenced = await queueScenesIfWithinCaps({
      admin: fencedAdmin,
      projectId: "project-1",
      userId: "u1",
      profile: editorProfile,
      sceneIds: ["scene-3"],
      estimatesUsd: [1],
      prepareToken: "stale-token",
    });
    expect(fenced).toEqual({ outcome: "fenced" });
  });
});
