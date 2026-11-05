import { describe, expect, it } from "vitest";
import { canUseApp, requiresAccountApproval } from "./account-approval";

describe("account approval", () => {
  it("never requires approval for admins, regardless of the stored status", () => {
    expect(requiresAccountApproval("admin")).toBe(false);
    expect(canUseApp({ role: "admin", status: "pending" })).toBe(true);
    expect(canUseApp({ role: "admin", status: "rejected" })).toBe(true);
  });

  it("requires both editor tiers to be active", () => {
    for (const role of ["editor", "trusted_editor"] as const) {
      expect(requiresAccountApproval(role)).toBe(true);
      expect(canUseApp({ role, status: "pending" })).toBe(false);
      expect(canUseApp({ role, status: "rejected" })).toBe(false);
      expect(canUseApp({ role, status: "active" })).toBe(true);
    }
  });
});
