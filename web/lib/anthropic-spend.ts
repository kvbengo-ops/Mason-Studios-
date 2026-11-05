import "server-only";
import { z } from "zod";

// https://platform.claude.com/docs/en/manage-claude/usage-cost-api
// Cost amounts are decimal strings in cents, not dollars or remaining credits.
const reportSchema = z.object({
  data: z.array(
    z.object({
      results: z.array(
        z.object({
          amount: z.string().regex(/^\d+(\.\d+)?$/),
          currency: z.literal("USD"),
        }),
      ),
    }),
  ),
  has_more: z.boolean(),
  next_page: z.string().nullable(),
});

type AnthropicSpend = { status: "ok"; usd: number } | { status: "not_configured" | "unavailable" };

let cache: { month: string; expiresAt: number; result: AnthropicSpend } | null = null;

/** Organization-wide month-to-date cost, called only after the spend page's admin guard. */
export async function getAnthropicMonthlySpend(now = new Date()): Promise<AnthropicSpend> {
  // Read-only billing is intentionally live in both modes; generation stays MODE-gated.
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return { status: "not_configured" };

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = start.toISOString();
  if (cache?.month === month && cache.expiresAt > now.getTime()) return cache.result;

  let result: AnthropicSpend;
  try {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", month);
    // Daily UTC buckets: include today's bucket and its available partial usage.
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    url.searchParams.set("ending_at", end.toISOString());
    url.searchParams.set("limit", "31");
    let cents = 0;
    const seenPages = new Set<string>();
    const signal = AbortSignal.timeout(10_000);
    for (;;) {
      const response = await fetch(url, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const report = reportSchema.parse(await response.json());
      for (const bucket of report.data) {
        for (const item of bucket.results) cents += Number(item.amount);
      }
      if (!Number.isFinite(cents)) throw new Error("Invalid cost total");
      if (!report.has_more) break;
      if (!report.next_page || seenPages.has(report.next_page) || seenPages.size >= 31) {
        throw new Error("Invalid cost report pagination");
      }
      seenPages.add(report.next_page);
      url.searchParams.set("page", report.next_page);
    }
    result = { status: "ok", usd: cents / 100 };
  } catch {
    // Never log response bodies or credentials from the billing service.
    console.error("getAnthropicMonthlySpend: Anthropic cost report could not be read");
    result = { status: "unavailable" };
  }
  cache = { month, expiresAt: now.getTime() + 60_000, result };
  return result;
}
