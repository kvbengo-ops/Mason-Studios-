// What the "Needs attention" card lists — only things an admin can act on,
// each with the page where it is fixed. Pure: callers do the reads and pass
// the results; null means "that read failed or is unavailable", which is
// skipped rather than shown as zero (a missing balance is not a low one).

import { formatUsd } from "@/lib/format-usd";
import { classifyRenderError, type RenderErrorCategory } from "@/lib/render-error";

/** Below this a vendor balance is flagged. ponytail: one fixed figure; make it a setting if it needs tuning per vendor. */
export const LOW_BALANCE_USD = 50;

export interface AttentionInput {
  pendingAccounts: number | null;
  pendingAllowanceRequests: number | null;
  nearCapAccounts: number | null;
  /** `runs.error` of every attempt that failed today (Manila). */
  failedRunErrors: readonly (string | null)[] | null;
  kieBalanceUsd: number | null;
  bytePlusBalanceUsd: number | null;
}

export interface AttentionItem {
  key: string;
  label: string;
  href: string;
}

const REASON_LABEL: Record<RenderErrorCategory, string> = {
  insufficient_balance: "vendor out of credit",
  rate_limited: "rate limited",
  content_policy: "content policy",
  rejected: "input rejected",
  still_running: "vendor never finished",
  retryable: "temporary vendor error",
  unknown: "unknown reason",
};

export interface FailureGroup {
  category: RenderErrorCategory;
  label: string;
  count: number;
}

/** Failed attempts grouped by classifyRenderError's category, largest group first. */
export function groupFailuresByReason(errors: readonly (string | null)[]): FailureGroup[] {
  const counts = new Map<RenderErrorCategory, number>();
  for (const raw of errors) {
    const { category } = classifyRenderError(raw);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts]
    .map(([category, count]) => ({ category, label: REASON_LABEL[category], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function buildAttentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (input.pendingAccounts) {
    items.push({
      key: "pending-accounts",
      label: `${plural(input.pendingAccounts, "account", "accounts")} waiting for approval`,
      href: "/users?filter=pending",
    });
  }
  if (input.pendingAllowanceRequests) {
    items.push({
      key: "allowance-requests",
      label: `${plural(input.pendingAllowanceRequests, "allowance request", "allowance requests")} waiting`,
      href: "/allowances",
    });
  }
  if (input.nearCapAccounts) {
    items.push({
      key: "near-cap",
      label: `${plural(input.nearCapAccounts, "account", "accounts")} at or near the weekly cap`,
      href: "/users?filter=near-cap",
    });
  }
  for (const group of groupFailuresByReason(input.failedRunErrors ?? [])) {
    items.push({
      key: `failed-${group.category}`,
      label: `${plural(group.count, "render", "renders")} failed today: ${group.label}`,
      href: "/accounts-control?view=runs",
    });
  }
  const balances = [
    ["kie", "Kie", input.kieBalanceUsd],
    ["byteplus", "BytePlus", input.bytePlusBalanceUsd],
  ] as const;
  for (const [key, name, usd] of balances) {
    if (usd !== null && usd < LOW_BALANCE_USD) {
      items.push({
        key: `low-${key}`,
        label: `${name} balance is low: ${formatUsd(usd)}`,
        href: "/accounts-control",
      });
    }
  }
  return items;
}
