import { describe, expect, it } from "vitest";
import {
  buildAttentionItems,
  groupFailuresByReason,
  LOW_BALANCE_USD,
  type AttentionInput,
} from "./needs-attention";

const NOTHING: AttentionInput = {
  pendingAccounts: 0,
  pendingAllowanceRequests: 0,
  nearCapAccounts: 0,
  failedRunErrors: [],
  kieBalanceUsd: 500,
  bytePlusBalanceUsd: 500,
};

describe("groupFailuresByReason", () => {
  it("groups by classifyRenderError's category, largest first", () => {
    const groups = groupFailuresByReason([
      'kie: {"code":402,"msg":"Credits insufficient"}',
      "insufficient balance",
      "client error: status 429: slow down",
      null,
    ]);
    expect(groups[0]).toEqual({
      category: "insufficient_balance",
      label: "vendor out of credit",
      count: 2,
    });
    expect(groups.map((g) => g.category)).toContain("rate_limited");
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(4);
  });

  it("is empty for no failures", () => {
    expect(groupFailuresByReason([])).toEqual([]);
  });
});

describe("buildAttentionItems", () => {
  it("lists nothing when nothing needs attention", () => {
    expect(buildAttentionItems(NOTHING)).toEqual([]);
  });

  it("skips unavailable reads instead of reporting them as zero or low", () => {
    expect(
      buildAttentionItems({
        pendingAccounts: null,
        pendingAllowanceRequests: null,
        nearCapAccounts: null,
        failedRunErrors: null,
        kieBalanceUsd: null,
        bytePlusBalanceUsd: null,
      }),
    ).toEqual([]);
  });

  it("links each line to where it is fixed", () => {
    const items = buildAttentionItems({
      pendingAccounts: 1,
      pendingAllowanceRequests: 3,
      nearCapAccounts: 2,
      failedRunErrors: ["insufficient balance", "insufficient balance"],
      kieBalanceUsd: LOW_BALANCE_USD - 0.01,
      bytePlusBalanceUsd: LOW_BALANCE_USD,
    });
    expect(items.map((i) => [i.label, i.href])).toEqual([
      ["1 account waiting for approval", "/users?filter=pending"],
      ["3 allowance requests waiting", "/allowances"],
      ["2 accounts at or near the weekly cap", "/users?filter=near-cap"],
      ["2 renders failed today: vendor out of credit", "/accounts-control?view=runs"],
      ["Kie balance is low: $49.99", "/accounts-control"],
    ]);
  });
});
