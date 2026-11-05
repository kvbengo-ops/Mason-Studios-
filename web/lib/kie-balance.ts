// kie.ai's real dollar balance — server-side only.
//
// Was originally written as "the kie twin of lib/fal-balance.ts", added
// alongside lib/vendor-routing.ts to fix a real bug: a render that routed
// to kie was checked against fal's balance, refusing a render kie had
// plenty of credit for. Both fal-balance.ts and vendor-routing.ts are gone
// now that fal is decommissioned — kie is the only vendor left, so this is
// simply the one balance check lib/spend.ts's assertKieBalanceCoversEstimate
// runs. Same caching, same fetch/test-seam shape, same fail-soft-to-null
// behaviour this file has always had.
//
// GET https://api.kie.ai/api/v1/chat/credit
//   Authorization: Bearer <KIE_API_KEY>
//   -> 200 {"code":200,"msg":"success","data":820.0}
//
// MEASURED against the live API, not documentation: HTTP is 200 even on a
// vendor-level failure — kie's own envelope carries the real status in
// `code`, never in the HTTP status line, same shape lib/kie.ts's
// generateImageViaKie already has to handle for image generation. `data` is
// CREDITS, not dollars: 1 credit = $0.005 (kie's published rate, the same
// CREDIT_USD lib/kie.ts and worker/internal/kie/client.go's creditUSD both
// use), so 820 credits is $4.10.
//
// KIE_API_KEY, the one key kie.ai has — unlike fal, there is no separate
// admin-scoped credential here: kie's own docs describe no such split, and
// lib/kie.ts already reads this same var for image generation. Declared on
// ugc-web (render.yaml) for that reason already; this file adds no new
// secret, only a new use of the existing one.
//
// Cached in module scope for BALANCE_CACHE_TTL_MS: the render gate loads
// constantly, and this is an in-memory, per-process cache correct for
// ugc-web's single long-lived Node process — not safe to assume shared
// across horizontally-scaled instances, should this service ever be scaled
// out.
import { isDev } from "@/lib/mode";

const BALANCE_CACHE_TTL_MS = 60_000;

const KIE_CREDIT_URL = "https://api.kie.ai/api/v1/chat/credit";

// kie.ai's published rate, confirmed against real paid calls (lib/kie.ts's
// own CREDIT_USD comment: 4 credits billed = $0.02 on both verified image
// models). Not imported from lib/kie.ts — that file is the image-generation
// vendor client and importing a balance-reading module's constant from it
// would tie two unrelated concerns together for a one-line saving; a
// duplicated literal is the smaller coupling here, same call
// worker/internal/kie/client.go's own creditUSD constant already made.
const CREDIT_USD = 0.005;

interface KieCreditResponse {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface BalanceCacheEntry {
  balanceUsd: number;
  fetchedAtMs: number;
}

let cache: BalanceCacheEntry | null = null;

/**
 * Fetch implementation used by getKieAccountBalanceUsd — a plain module
 * variable so production code never threads one through, swappable in
 * tests via __setKieBalanceFetchForTests.
 */
let fetchImpl: typeof fetch = fetch;

/** Test-only hook: swap the fetch implementation. See __resetKieBalanceCacheForTests. */
export function __setKieBalanceFetchForTests(impl: typeof fetch): void {
  fetchImpl = impl;
}

/** Test-only hook: clear the module-level cache between test cases. */
export function __resetKieBalanceCacheForTests(): void {
  cache = null;
  fetchImpl = fetch;
}

/**
 * Reads kie.ai's current USD balance, cached for BALANCE_CACHE_TTL_MS.
 *
 * Returns `null` — never throws — on ANY failure: KIE_API_KEY unset, a
 * network error, a non-200 HTTP response, a non-200 `code` in kie's own
 * envelope, or a response shape with no numeric `data`. Deliberately
 * fail-OPEN-to-the-OTHER-CHECKS: lib/
 * spend.ts's balance-gate step treats `null` as "skip this vendor's balance
 * check," which does not mean nothing is protecting the render — the
 * global/weekly/daily caps still run regardless, and refusing every render
 * because kie's status endpoint is briefly unreachable would take down the
 * whole product over a diagnostic. Every failure is logged (never the key
 * itself) so this stays observable instead of a silent no-op.
 */
export async function getKieAccountBalanceUsd(now: number = Date.now()): Promise<number | null> {
  // MODE first, before the cache and before the key.
  //
  // This is a real outbound call to api.kie.ai, and MODE's contract is that
  // development never makes one. It was gated only on KIE_API_KEY being unset
  // — which is not a gate, it is an accident of configuration. Fill the key in
  // without touching MODE and every page load in the app starts sending the
  // real key to kie from a process that is supposed to be talking to nobody.
  //
  // "Every page load" is not an exaggeration: lib/sidebar-budget.ts calls this,
  // and the sidebar is rendered by app/(app)/layout.tsx. Opening /ugc was
  // enough.
  //
  // The gate belongs HERE rather than at the call sites, and the reason is
  // sitting in the repository already: lib/spend.ts remembered to wrap this in
  // isDev(); sidebar-budget, /spend, /allowances and the scene page did not.
  // Four out of five is what a rule enforced by memory looks like. A rule
  // enforced in one place cannot be four-fifths applied.
  //
  // Returns null, which every caller already handles as "could not be read" —
  // deliberately NOT zero. An unreadable balance must never look like an empty
  // account.
  if (isDev()) {
    return null;
  }

  if (cache && now - cache.fetchedAtMs < BALANCE_CACHE_TTL_MS) {
    return cache.balanceUsd;
  }

  const key = process.env.KIE_API_KEY;
  if (!key) {
    console.error(
      "getKieAccountBalanceUsd: KIE_API_KEY is not set — skipping the kie balance check. " +
        "The three existing spend caps (global/weekly/daily) still apply; a kie-routed render " +
        "that runs the account dry still fails at submission time.",
    );
    return null;
  }

  let response: Response;
  try {
    response = await fetchImpl(KIE_CREDIT_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    console.error(
      "getKieAccountBalanceUsd: fetch failed — skipping the kie balance check.",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  if (!response.ok) {
    console.error(
      `getKieAccountBalanceUsd: kie credit endpoint returned HTTP ${response.status} — ` +
        "skipping the kie balance check.",
    );
    return null;
  }

  let body: KieCreditResponse;
  try {
    body = (await response.json()) as KieCreditResponse;
  } catch (err) {
    console.error(
      "getKieAccountBalanceUsd: kie credit response was not valid JSON — skipping the kie " +
        "balance check.",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  // kie's envelope carries the real outcome in `code`, not the HTTP status
  // — this file's own header, and lib/kie.ts's — so a 200 response with a
  // non-200 code (e.g. an expired key) must be treated as a failed read,
  // not a $0 or a bogus balance.
  if (body.code !== 200) {
    console.error(
      `getKieAccountBalanceUsd: kie credit endpoint answered code=${JSON.stringify(body.code)} ` +
        `(msg=${JSON.stringify(body.msg)}) — skipping the kie balance check.`,
    );
    return null;
  }

  const creditsRemaining = body.data;
  if (typeof creditsRemaining !== "number" || !Number.isFinite(creditsRemaining)) {
    console.error(
      "getKieAccountBalanceUsd: kie credit response had no numeric `data` field — skipping the " +
        "kie balance check.",
    );
    return null;
  }

  const balanceUsd = creditsRemaining * CREDIT_USD;
  cache = { balanceUsd, fetchedAtMs: now };
  return balanceUsd;
}

/**
 * The one place "account funds" (this vocabulary — never bare "balance",
 * never "credits") gets formatted for display. `null` — KIE_API_KEY unset
 * in this environment, or any other read failure — renders as "Unknown",
 * NEVER "$0.00": a zero would read as "the account is empty," a materially
 * different (and false) claim from "this app could not read the real
 * number." `null` is an ordinary state every caller that shows this figure
 * (/spend, /allowances, the approve dialog) must handle, not an edge case
 * to special-case per call site — hence one shared, unit-tested function
 * instead of an inline `!== null ? ... : ...` at every render site.
 *
 * Moved here from lib/fal-balance.ts when fal was decommissioned — every
 * caller already imported it alongside the balance read it formats, so this
 * file is now the one place both a balance and its formatter live.
 */
export function formatAccountFundsUsd(balanceUsd: number | null): string {
  if (balanceUsd === null) return "Unknown";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(balanceUsd);
}
