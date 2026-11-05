import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatAccountFundsUsd,
  getKieAccountBalanceUsd,
  __resetKieBalanceCacheForTests,
  __setKieBalanceFetchForTests,
} from "./kie-balance";

// getKieAccountBalanceUsd is the one place KIE_API_KEY is used for a
// balance read (web/lib/kie-balance.ts's file header) — these tests never
// construct a real request, only fake fetch responses, so no key value is
// ever involved beyond the constant test string below (not a real
// credential).

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("getKieAccountBalanceUsd", () => {
  beforeEach(() => {
    // MODE=production, explicitly. Every test below this line is about what
    // happens when this function DOES call kie — the conversion, the header,
    // the failure paths — and none of that is reachable in development, where
    // the function returns null before it looks at anything else. Leaving
    // MODE unset made all eight of them pass for the wrong reason the moment
    // the dev gate was added: they were asserting against a mock of the
    // fetch that never ran.
    vi.stubEnv("MODE", "production");
    vi.stubEnv("KIE_API_KEY", "test-kie-key");
    __resetKieBalanceCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetKieBalanceCacheForTests();
    vi.restoreAllMocks();
  });

  // The gate that matters most, and it is FIRST because it runs before
  // everything the rest of this file tests.
  //
  // This was gated only on KIE_API_KEY being unset, which is not a gate — it
  // is an accident of configuration. lib/sidebar-budget.ts calls this and the
  // sidebar renders on every page under (app), so filling the key in without
  // touching MODE meant every page load sent the real key to api.kie.ai from
  // a process whose whole contract is that it talks to nobody.
  it("makes no call at all in development, even with a real key set", async () => {
    vi.stubEnv("MODE", "development");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, msg: "success", data: 820.0 }));
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    const balance = await getKieAccountBalanceUsd();

    expect(fetchMock, "development called api.kie.ai — MODE's contract is that it never does").not.toHaveBeenCalled();
    // null, not 0. Every caller reads null as "could not be read"; a zero
    // would read as an empty account and refuse renders.
    expect(balance).toBeNull();
  });

  it("returns the balance in USD, converted from credits at $0.005/credit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, msg: "success", data: 820.0 }));
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    const balance = await getKieAccountBalanceUsd();
    expect(balance).toBe(4.1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // NEGATIVE CONTROL (run manually, not part of the suite): comment out the
  // `body.code !== 200` check in kie-balance.ts and this test still passes
  // — it never gives kie a non-200 code. The next test is what actually
  // protects that check.
  it("sends the Authorization header kie expects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, msg: "success", data: 100 }));
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    await getKieAccountBalanceUsd();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.kie.ai/api/v1/chat/credit",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-kie-key" },
      }),
    );
  });

  it("skips (returns null) when KIE_API_KEY is unset, without throwing", async () => {
    // unstubAllEnvs clears MODE too, which would send this down the dev gate
    // and return null before it ever looks at the key — passing for the wrong
    // reason. This test is about the MISSING KEY path, so it puts production
    // back and only clears the key.
    vi.unstubAllEnvs();
    vi.stubEnv("MODE", "production");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    const balance = await getKieAccountBalanceUsd();
    expect(balance).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("skips (returns null) when the fetch itself fails — a network blip must not block rendering", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("network blip"));
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    const balance = await getKieAccountBalanceUsd();
    expect(balance).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("skips (returns null) on a non-200 HTTP response", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "forbidden" }, { status: 403 }));
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    const balance = await getKieAccountBalanceUsd();
    expect(balance).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  // kie's own envelope carries the real outcome in `code`, and HTTP is 200
  // even on failure (this file's own header) — an HTTP-status-only check
  // would treat this as success and hand back a bogus null-as-zero balance.
  it("skips (returns null) on HTTP 200 with a non-200 \`code\` in the envelope, even when data looks numeric", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 401, msg: "Unauthorized", data: 999 }));
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    const balance = await getKieAccountBalanceUsd();
    expect(balance).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("skips (returns null) when the response shape has no numeric `data`", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, msg: "success", data: "not-a-number" }));
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    const balance = await getKieAccountBalanceUsd();
    expect(balance).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  // expect(NaN).toBe(NaN) passes vacuously in vitest (Object.is semantics —
  // see spend.test.ts's own header comment on this exact trap), so this
  // pins the cache with a real, distinguishable pair of values rather than
  // asserting "still some number."
  it("does not re-fetch within the cache window, even if the balance changed server-side", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, msg: "success", data: 820 }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, msg: "success", data: 100 }));
    __setKieBalanceFetchForTests(fetchMock as unknown as typeof fetch);

    const start = 1_000_000;
    const first = await getKieAccountBalanceUsd(start);
    expect(first).toBe(4.1);

    // 59s later — still inside the 60s window (BALANCE_CACHE_TTL_MS).
    const second = await getKieAccountBalanceUsd(start + 59_000);
    expect(second).toBe(4.1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 61s later — outside the window; the (now different) server value
    // must be picked up.
    const third = await getKieAccountBalanceUsd(start + 61_000);
    expect(third).toBe(0.5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// formatAccountFundsUsd — the one place the read above gets formatted for
// display (/spend, /allowances, the approve dialog). Moved here from
// lib/fal-balance.test.ts when fal was decommissioned. The task this exists
// for is explicit: null (KIE_API_KEY unset, or any other read failure) must
// render as "unknown", NEVER as "$0.00", which would falsely claim the
// account is empty rather than merely unreadable.
describe("formatAccountFundsUsd", () => {
  it("renders null as Unknown, not $0.00", () => {
    const formatted = formatAccountFundsUsd(null);
    expect(formatted).toBe("Unknown");
    expect(formatted).not.toMatch(/\$0\.00/);
  });

  it("renders a real balance as a formatted dollar figure", () => {
    expect(formatAccountFundsUsd(31.17)).toBe("$31.17");
  });

  it("renders an actual zero balance as $0.00 — only null means unknown, a real 0 is a real 0", () => {
    expect(formatAccountFundsUsd(0)).toBe("$0.00");
  });
});
