import { describe, expect, it } from "vitest";
import { buildAccountsRunsCsv } from "./accounts-runs-csv";

describe("buildAccountsRunsCsv", () => {
  it("matches the All Runs columns and escapes spreadsheet data", () => {
    expect(
      buildAccountsRunsCsv([
        {
          preview: "https://example.com/preview.jpg",
          userEmail: "=alice@example.com",
          provider: "kie",
          model: "seedance-2.5",
          costUsd: 0.56,
          details: "failed, then retried",
        },
        {
          preview: null,
          userEmail: "bob@example.com",
          provider: "BytePlus",
          model: "seedance-2.5",
          costUsd: 0.12,
          details: null,
        },
      ]),
    ).toBe(
      "preview,user_email,provider,model,cost_usd,details\r\n" +
        "https://example.com/preview.jpg,'=alice@example.com,kie,seedance-2.5,0.56,\"failed, then retried\"\r\n" +
        ",bob@example.com,BytePlus,seedance-2.5,0.12,\r\n",
    );
  });
});
