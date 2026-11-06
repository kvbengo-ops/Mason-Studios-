import { describe, expect, it } from "vitest";
import { signBalanceRequest } from "@/lib/byteplus-balance";

describe("signBalanceRequest", () => {
  // Vector from the same algorithm BytePlus accepted live (200, 2026-11-06).
  it("matches the live-verified signature", () => {
    const headers = signBalanceRequest("AKTEST", "secret", "20261106T154642Z");
    expect(headers.authorization).toBe(
      "HMAC-SHA256 Credential=AKTEST/20261106/ap-singapore-1/billing/request, " +
        "SignedHeaders=content-type;host;x-content-sha256;x-date, " +
        "Signature=e64e3eee4a941e124ef83ca2da98b0d1cfee3b1ec8241487caf5616f51b977bd",
    );
  });
});
