import { describe, expect, it } from "vitest";
import { buildBalanceAlertEmail } from "./balance-alert-email";

describe("buildBalanceAlertEmail", () => {
  const email = buildBalanceAlertEmail({
    vendorLabel: "Kie",
    balanceUsd: 1234.5,
    thresholdUsd: 2000,
    appUrl: "https://app.example.test/",
    sentAt: new Date("2026-11-12T05:42:00Z"),
  });

  it("states the balance, the threshold and the shortfall in both parts", () => {
    expect(email.subject).toBe("Kie balance is low: $1,234.50");
    for (const part of [email.html, email.text]) {
      expect(part).toContain("$1,234.50");
      expect(part).toContain("$2,000.00");
      expect(part).toContain("$765.50");
    }
  });

  it("links to Accounts Control on the app's own URL, without a double slash", () => {
    expect(email.html).toContain('href="https://app.example.test/accounts-control"');
    expect(email.text).toContain("https://app.example.test/accounts-control");
  });
});
