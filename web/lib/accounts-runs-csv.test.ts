import { describe, expect, it } from "vitest";
import { buildAccountsRunsCsv } from "./accounts-runs-csv";

describe("buildAccountsRunsCsv", () => {
  it("exports account, provider, USD, Kie credits, and video duration safely", () => {
    expect(
      buildAccountsRunsCsv([
        {
          username: "=alice",
          model: "seedance-2.5",
          provider: "kie",
          costUsd: 0.56,
          durationS: 4,
        },
        {
          username: "bob",
          model: "seedance-2.5",
          provider: "BytePlus",
          costUsd: 0.12,
          durationS: null,
        },
      ]),
    ).toBe(
      "username,model,provider,cost_usd,kie_credits,duration_s\r\n" +
        "'=alice,seedance-2.5,kie,0.56,112,4\r\n" +
        "bob,seedance-2.5,BytePlus,0.12,,\r\n",
    );
  });
});
