// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decideAllowanceRequest } from "@/actions/allowance";
import { DecideAllowanceRequestDialog } from "./decide-allowance-request-dialog";

vi.mock("@/actions/allowance", () => ({
  decideAllowanceRequest: vi.fn(),
}));

// THE EXPIRY FIXTURE IS RELATIVE TO NOW, and that is the whole fix.
//
// Every case below used to pass a literal
// `defaultExpiresAtIso={inSevenDays()}`, and handleApprove refuses
// an expiry that is not in the future — correctly, because a grant that has
// already expired is not a grant. So this file passed until that moment
// arrived and failed every run afterwards, on main, with nothing having
// changed and nobody having touched it. A test that starts failing because a
// date went by is a time bomb; this one went off on the one day CI was down
// and could not say so.
//
// Seven days out rather than a frozen clock: `vi.setSystemTime` without
// handing userEvent its own advance function hangs every interaction in the
// file, and this is a date the dialog only ever compares against `now`.
const inSevenDays = (): string => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

afterEach(() => {
  cleanup();
  vi.mocked(decideAllowanceRequest).mockReset();
});

describe("DecideAllowanceRequestDialog peer mode", () => {
  // The prop set matters here. This used to pass requestedUsd 6999 with a
  // default of 7000 (the old $5 round-up) against a 6000 ceiling, to prove
  // the dialog clamped the pre-fill. /allowances cannot produce that state:
  // decisionBlockReason refuses a peer any request over their ceiling, so the
  // dialog never renders for one. The clamp is gone with the round-up that
  // made it necessary; what this still proves is the part that does happen —
  // a peer sees the requested amount, no expiry control, and cannot submit
  // more than their limit.
  it("pre-fills the requested amount, hides expiry, and refuses an over-ceiling grant client-side", async () => {
    const user = userEvent.setup();
    render(
      <DecideAllowanceRequestDialog
        requestId="request-1"
        requesterEmail="editor@example.com"
        requestedUsd={5000}
        reason={null}
        defaultGrantAmountUsd={5000}
        defaultExpiresAtIso={inSevenDays()}
        peerMaxGrantUsd={6000}
        currentAllowanceUsd={5000}
        usedThisWeekUsd={1200}
        accountFundsUsd={null}
        outstandingAllowanceUsd={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    const amount = within(dialog).getByLabelText("Grant amount (USD)") as HTMLInputElement;

    // What was asked for — not the ceiling, and not a rounded-up figure.
    expect(amount.value).toBe("5000");
    expect(amount.max).toBe("6000");
    expect(within(dialog).queryByLabelText("Expires")).toBeNull();
    expect(within(dialog).getByText(/approval limit is \$6,000\.00/i)).toBeTruthy();

    await user.clear(amount);
    await user.type(amount, "6001");
    await user.click(within(dialog).getByRole("button", { name: "Approve & grant" }));

    expect(dialog.querySelector(".text-destructive")?.textContent).toBeTruthy();
    expect(decideAllowanceRequest).not.toHaveBeenCalled();
  });

  it("keeps the uncapped amount and editable expiry for an admin", async () => {
    const user = userEvent.setup();
    render(
      <DecideAllowanceRequestDialog
        requestId="request-2"
        requesterEmail="editor@example.com"
        requestedUsd={6999}
        reason={null}
        defaultGrantAmountUsd={6999}
        defaultExpiresAtIso={inSevenDays()}
        peerMaxGrantUsd={null}
        currentAllowanceUsd={5000}
        usedThisWeekUsd={1200}
        accountFundsUsd={100}
        outstandingAllowanceUsd={80}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    const amount = within(dialog).getByLabelText("Grant amount (USD)") as HTMLInputElement;

    expect(amount.value).toBe("6999");
    expect(amount.hasAttribute("max")).toBe(false);
    expect(within(dialog).getByLabelText("Expires")).toBeTruthy();
    expect(within(dialog).queryByText(/approval limit is/i)).toBeNull();
  });

  it("shows a trusted editor credits and submits the equivalent USD amount", async () => {
    const user = userEvent.setup();
    vi.mocked(decideAllowanceRequest).mockResolvedValue(undefined);
    render(
      <DecideAllowanceRequestDialog
        requestId="request-credits"
        requesterEmail="editor@example.com"
        requestedUsd={30}
        reason={null}
        defaultGrantAmountUsd={30}
        defaultExpiresAtIso={inSevenDays()}
        peerMaxGrantUsd={30}
        currentAllowanceUsd={75}
        usedThisWeekUsd={10}
        accountFundsUsd={null}
        outstandingAllowanceUsd={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    const amount = within(dialog).getByLabelText("Grant amount (USD)") as HTMLInputElement;

    expect(amount.value).toBe("30");
    expect(amount.max).toBe("30");
    expect(within(dialog).getByText(/requested \$30\.00/i)).toBeTruthy();
    expect(within(dialog).getByText(/current allowance:/i).textContent).toContain("$75.00");

    await user.click(within(dialog).getByRole("button", { name: "Approve & grant" }));

    expect(decideAllowanceRequest).toHaveBeenCalledWith(
      "request-credits",
      "approve",
      expect.objectContaining({ grantAmountUsd: 30 }),
    );
  });

  it("shows admins dollars and accepts the grant in dollars", async () => {
    const user = userEvent.setup();
    vi.mocked(decideAllowanceRequest).mockResolvedValue(undefined);
    render(
      <DecideAllowanceRequestDialog
        requestId="request-dual"
        requesterEmail="editor@example.com"
        requestedUsd={30}
        reason={null}
        defaultGrantAmountUsd={30}
        defaultExpiresAtIso={inSevenDays()}
        peerMaxGrantUsd={null}
        currentAllowanceUsd={75}
        usedThisWeekUsd={10}
        accountFundsUsd={100}
        outstandingAllowanceUsd={80}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    const amount = within(dialog).getByLabelText("Grant amount (USD)") as HTMLInputElement;

    expect(amount.value).toBe("30");
    expect(within(dialog).getByText(/requested \$30\.00/i)).toBeTruthy();
    expect(within(dialog).getByText(/account funds:/i).textContent).toContain("$100.00");

    await user.click(within(dialog).getByRole("button", { name: "Approve & grant" }));

    expect(decideAllowanceRequest).toHaveBeenCalledWith(
      "request-dual",
      "approve",
      expect.objectContaining({ grantAmountUsd: 30 }),
    );
  });

  it("shows the requester's full reason in the Approve and Deny dialogs", async () => {
    const user = userEvent.setup();
    const reason = [
      "Client reshoot for the skincare campaign: 12 extra Seedance clips, line 2",
      "and a second paragraph.",
    ].join("\n");
    render(
      <DecideAllowanceRequestDialog
        requestId="request-reason"
        requesterEmail="editor@example.com"
        requestedUsd={50}
        reason={reason}
        defaultGrantAmountUsd={50}
        defaultExpiresAtIso={inSevenDays()}
        peerMaxGrantUsd={null}
        currentAllowanceUsd={null}
        usedThisWeekUsd={null}
        accountFundsUsd={null}
        outstandingAllowanceUsd={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("dialog").textContent).toContain("a second paragraph");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByRole("dialog").textContent).toContain("Client reshoot for the skincare campaign");
  });
});
