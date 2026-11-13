import { describe, expect, it } from "vitest";
import { grantMessage } from "./grant-message";

describe("grantMessage", () => {
  it("reads the note from metadata, then from the body text", () => {
    expect(
      grantMessage({ kind: "credit_approved", body: "x", metadata: { note: " Use it well " } }),
    ).toBe("Use it well");
    expect(
      grantMessage({
        kind: "credit_approved",
        body: "$10.00 added to your weekly allowance. Note: for the launch",
        metadata: {},
      }),
    ).toBe("for the launch");
    expect(
      grantMessage({
        kind: "credit_denied",
        body: "Your weekly allowance request was denied: tes\ntonly lorem ipsum",
        metadata: { requested_usd: 5 },
      }),
    ).toBe("tes\ntonly lorem ipsum");
  });

  it("is null without a message, and for non-allowance notifications", () => {
    expect(
      grantMessage({
        kind: "credit_approved",
        body: "$1.00 added to your weekly allowance.",
        metadata: {},
      }),
    ).toBeNull();
    expect(
      grantMessage({
        kind: "credit_denied",
        body: "Your weekly credit request was denied.",
        metadata: {},
      }),
    ).toBeNull();
    expect(grantMessage({ kind: "scene_completed", body: "Note: hi", metadata: {} })).toBeNull();
  });
});
