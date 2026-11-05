// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { passAllowance } from "@/actions/transfer";
import { passBlockReason } from "@/lib/transfer";
import { PassCreditsDialog } from "./pass-credits-dialog";

vi.mock("@/actions/transfer", () => ({ passAllowance: vi.fn() }));
vi.mock("@/lib/transfer", () => ({ passBlockReason: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function showDialog(headroomUsd = 10): void {
  render(
    <PassCreditsDialog
      open
      onOpenChange={vi.fn()}
      senderId="sender"
      senderRole="editor"
      headroomUsd={headroomUsd}
      recipients={[
        { id: "peer", username: "Ana", email: "ana@example.com", role: "trusted_editor" },
      ]}
    />,
  );
}

describe("PassCreditsDialog", () => {
  it("shows the blocked reason without submitting", async () => {
    const user = userEvent.setup();
    vi.mocked(passBlockReason).mockReturnValue("You do not have enough weekly headroom.");
    showDialog(0);
    await user.selectOptions(screen.getByRole("combobox"), "peer");
    await user.type(screen.getByLabelText("Amount (credits)"), "400");
    await user.click(screen.getByRole("button", { name: "Pass credits" }));
    expect(screen.getByRole("alert").textContent).toBe("You do not have enough weekly headroom.");
    expect(passAllowance).not.toHaveBeenCalled();
  });

  it("converts credits at the action boundary and shows remaining headroom", async () => {
    const user = userEvent.setup();
    vi.mocked(passBlockReason).mockReturnValue(null);
    vi.mocked(passAllowance).mockResolvedValue(undefined);
    showDialog();
    await user.selectOptions(screen.getByRole("combobox"), "peer");
    await user.type(screen.getByLabelText("Amount (credits)"), "400");
    await user.type(screen.getByLabelText("Note (optional)"), "  For your clip  ");
    expect(screen.getByText("Remaining this week: 2,000 cr")).toBeTruthy();
    expect(screen.getByText("Remaining after pass: 1,600 cr")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pass credits" }));
    expect(passBlockReason).toHaveBeenCalledWith({
      senderId: "sender",
      senderRole: "editor",
      recipientId: "peer",
      recipientRole: "trusted_editor",
      amountUsd: 2,
      headroomUsd: 10,
    });
    expect(passAllowance).toHaveBeenCalledWith("peer", 2, "For your clip");
  });

  // `min="1"` is enforced by the browser on native form submission only, and
  // this dialog submits from a button — so before the filter, "-50" was
  // typeable and reached passBlockReason to be refused after the fact.
  it("will not let a negative amount be typed at all", async () => {
    const user = userEvent.setup();
    vi.mocked(passBlockReason).mockReturnValue(null);
    showDialog(10);
    const amount = screen.getByLabelText<HTMLInputElement>("Amount (credits)");
    await user.type(amount, "-50");
    expect(amount.value).toBe("50");
  });

  it("drops a decimal point too — credits are whole", async () => {
    const user = userEvent.setup();
    vi.mocked(passBlockReason).mockReturnValue(null);
    showDialog(10);
    const amount = screen.getByLabelText<HTMLInputElement>("Amount (credits)");
    await user.type(amount, "1.5");
    expect(amount.value).toBe("15");
  });

  it("explains expiry and that unused headroom is not returned", () => {
    showDialog();
    expect(
      screen.getByText(/expires at the end.*of this Manila week and is not returned/s),
    ).toBeTruthy();
    expect(screen.getByText(/stops existing on Monday/)).toBeTruthy();
  });
});
