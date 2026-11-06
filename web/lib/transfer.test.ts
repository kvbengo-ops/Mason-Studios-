import { describe, expect, it } from "vitest";
import { passBlockReason, NOT_A_PASSER } from "./transfer";
import type { PassEligibility } from "./transfer";

// One eligible pass, varied per case. Editor -> trusted editor with room to
// spare, so anything that blocks below blocks for the reason the test names
// and not because the fixture was already broken.
function eligibility(overrides: Partial<PassEligibility> = {}): PassEligibility {
  return {
    senderRole: "editor",
    senderId: "sender-1",
    recipientRole: "trusted_editor",
    recipientId: "recipient-1",
    amountUsd: 5,
    headroomUsd: 20,
    ...overrides,
  };
}

describe("passBlockReason", () => {
  // Both directions were asked for explicitly, and they are not the same
  // assertion: a trusted editor is the tier with the larger allowance and
  // the one that can approve requests, so "may they also hand headroom
  // DOWN to a plain editor" is a separate question from "may an editor hand
  // it up".
  it("allows editor -> trusted_editor", () => {
    expect(
      passBlockReason(eligibility({ senderRole: "editor", recipientRole: "trusted_editor" })),
    ).toBeNull();
  });

  it("allows trusted_editor -> editor", () => {
    expect(
      passBlockReason(eligibility({ senderRole: "trusted_editor", recipientRole: "editor" })),
    ).toBeNull();
  });

  it("allows editor -> editor", () => {
    expect(
      passBlockReason(eligibility({ senderRole: "editor", recipientRole: "editor" })),
    ).toBeNull();
  });

  it("allows a pass of exactly the whole headroom", () => {
    expect(passBlockReason(eligibility({ amountUsd: 20, headroomUsd: 20 }))).toBeNull();
  });

  it("refuses a pass to yourself", () => {
    expect(passBlockReason(eligibility({ senderId: "same", recipientId: "same" }))).toMatch(
      /to yourself/i,
    );
  });

  // Admins are out of scope on BOTH ends (0087_pass_allowance.sql raises on
  // each independently), and the two produce different sentences because
  // they are different people's problems.
  it("refuses an admin sender, with the shared NOT_A_PASSER message", () => {
    expect(passBlockReason(eligibility({ senderRole: "admin" }))).toBe(NOT_A_PASSER);
  });

  it("refuses an admin recipient, naming the RECIPIENT rather than the caller", () => {
    const reason = passBlockReason(eligibility({ recipientRole: "admin" }));
    expect(reason).toMatch(/pass allowance to another editor/i);
    expect(reason).not.toBe(NOT_A_PASSER);
  });

  // A suspended or unapproved account cannot appear in transfer_recipients()
  // at all, so this function is never given one and deliberately has no
  // status field to check — see its doc comment. The rule is enforced in
  // 0087 and, for the app, by the action refusing an id that is not in that
  // list; asserted there (actions/transfer.test.ts) rather than here, so the
  // two halves of "non-active recipient" are each tested where they live.
  it("has no opinion on a recipient's status — the eligible SET is what enforces that", () => {
    expect(passBlockReason(eligibility())).toBeNull();
  });

  it("refuses more than the sender's headroom, and says how much is left", () => {
    const reason = passBlockReason(eligibility({ amountUsd: 20.01, headroomUsd: 20 }));
    // 20 USD is 4,000 credits — the unit the sender actually reads.
    expect(reason).toMatch(/\$20\.00/);
  });

  // An empty balance is NOT the overshoot case above. "You only have 0 cr
  // left, you can't pass more than that" reads as a cap on the amount; the
  // real answer is that no amount would work, and the sender's next move is
  // to top up rather than retype. Both still quote the figure.
  it("calls an empty balance insufficient funds, not an amount that overshoots", () => {
    const reason = passBlockReason(eligibility({ amountUsd: 0.01, headroomUsd: 0 }));
    expect(reason).toMatch(/insufficient funds/i);
    expect(reason).toMatch(/\$0\.00/);
  });

  // An account already over its allowance has negative headroom. It must be
  // refused, and it must not be shown a negative balance — the clamp is at
  // display only (remainingForDisplayUsd), never on the comparison.
  it("refuses a sender in deficit and shows 0 left, not a negative figure", () => {
    const reason = passBlockReason(eligibility({ amountUsd: 1, headroomUsd: -2 }));
    expect(reason).toMatch(/insufficient funds/i);
    expect(reason).toMatch(/\$0\.00/);
    expect(reason).not.toMatch(/-/);
  });

  // Non-finite headroom is unpassable for the same reason an empty balance
  // is. It matters that it lands HERE and not in the comparison below:
  // `amountUsd > NaN` is false for every amount, so a NaN routed there
  // would be waved through as an allowed pass.
  it("refuses non-finite headroom as insufficient funds rather than waving it through", () => {
    expect(passBlockReason(eligibility({ headroomUsd: Number.NaN }))).toMatch(
      /insufficient funds/i,
    );
  });

  // The overshoot message is now only ever seen with a real balance behind
  // it, so it can stay about the amount alone.
  it("still refuses an overshoot against a real balance, and says how much is left", () => {
    const reason = passBlockReason(eligibility({ amountUsd: 20.01, headroomUsd: 20 }));
    expect(reason).toMatch(/\$20\.00/);
    expect(reason).not.toMatch(/insufficient funds/i);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a non-positive or non-finite amount (%s)",
    (amountUsd) => {
      expect(passBlockReason(eligibility({ amountUsd }))).toMatch(/positive amount/i);
    },
  );

  // The ordering that matters most: NaN sorts false against every
  // comparison, so an amount check placed AFTER the headroom check would
  // let NaN through as "not more than the headroom" — the one case where
  // rule order is the difference between refusing and not.
  it("catches a NaN amount even when the headroom comparison would wave it through", () => {
    expect(passBlockReason(eligibility({ amountUsd: Number.NaN, headroomUsd: 0 }))).toMatch(
      /positive amount/i,
    );
  });
});
